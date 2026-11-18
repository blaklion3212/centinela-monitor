#!/usr/bin/env node
'use strict';
/*
 * Servidor de Centinela. Sin dependencias externas (solo Node 18+).
 *   - Sirve el dashboard (index.html, assets/, js/).
 *   - API REST para organizaciones, objetivos, configuración y disposición de ventanas (por organización, ?org=ID).
 *   - Transmite resultados en vivo por Server-Sent Events (/api/stream).
 *
 * Por defecto escucha solo en 127.0.0.1. Para verlo desde otros equipos usa HOST=0.0.0.0.
 * El acceso exige usuario y contraseña (usuarios en data/users.json, roles admin / operator / viewer).
 */
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var store = require('./lib/store').load();
var validate = require('./lib/validate');
var Scheduler = require('./lib/scheduler').Scheduler;
var tracer = require('./probes/traceroute');
var authLib = require('./lib/auth');
var pkg = require('../package.json');

var ROOT = path.join(__dirname, '..');
var PORT = parseInt(process.env.PORT || '8080', 10);
var HOST = process.env.HOST || '127.0.0.1';
var MAX_TARGETS = 500;
var MAX_BODY = 512 * 1024;

var AUTH_ON = String(process.env.CENTINELA_AUTH || 'on').toLowerCase() !== 'off';
var auth = authLib.create();
// La contraseña aleatoria se muestra aquí, antes de listen, para que sea visible aunque el arranque falle
// (p. ej. EADDRINUSE); después se borra de memoria.
if (auth.seeded && auth.seeded.generatedPassword) {
  var bar = '============================================================';
  console.log(bar);
  console.log('  CONTRASEÑA INICIAL DEL ADMINISTRADOR (se muestra UNA sola vez)');
  console.log('  Usuario:    ' + auth.seeded.username);
  console.log('  Contraseña: ' + auth.seeded.generatedPassword);
  console.log('  Anótala ahora; deberás cambiarla al iniciar sesión.');
  console.log(bar);
  auth.seeded.generatedPassword = null;
}
var LOCAL_USER = { id: 'local', username: 'local', role: 'admin' };

var scheduler = new Scheduler(store);
var clients = new Map();       // res -> { sid, key, user, ka } (flujos SSE abiertos; el Map conserva el orden de apertura)
// Topes de flujos SSE: por clave (sid con auth activa; IP con auth off), por usuario (o IP con auth off) y global.
// Al superar uno de los dos primeros se cierra el flujo MÁS ANTIGUO; solo el global rechaza con 429.
var MAX_STREAMS_PER_KEY = 5, MAX_STREAMS_PER_USER = 15, MAX_STREAMS = 200, MAX_STREAM_BUFFER = 1024 * 1024;
var traceActive = 0;
var traceByUser = {};          // userId (o IP con auth off) -> traceroute en curso (máx. 1)

// Cierra un flujo SSE y libera sus recursos (idempotente).
function dropClient(res) {
  var info = clients.get(res);
  if (!info) return;
  clearInterval(info.ka);
  clients.delete(res);
  try { res.end(); } catch (e) { /* ya cerrado */ }
}
// Cierra los flujos más antiguos con ese campo (key|user) hasta dejar sitio para uno nuevo (máx. `max` abiertos).
function evictOldest(field, value, max) {
  var mine = [];
  clients.forEach(function (info, res) { if (info[field] === value) mine.push(res); }); // orden de apertura
  while (mine.length >= max) {
    var old = mine.shift();
    // Se avisa al cliente antes de cerrar para que no reconecte en ciclo.
    try { old.write('event: evicted\ndata: {"reason":"tope"}\n\n'); } catch (e) { /* ya cerrado */ }
    dropClient(old);
  }
}
// Al cerrar o expulsar sesiones (logout, usuario deshabilitado o eliminado) se cortan sus flujos de inmediato.
function dropStreamsOf(sids) {
  var set = {}; sids.forEach(function (x) { set[x] = true; });
  Array.from(clients.keys()).forEach(function (res) { if (set[clients.get(res).sid]) dropClient(res); });
}
auth.onSessionsDropped = dropStreamsOf;
// Al exigir cambio de contraseña sin cerrar sesiones, solo se cortan los flujos en vivo.
auth.onStreamsDropped = dropStreamsOf;

// Protección contra DNS rebinding: lista de Host permitidos (sin puerto).
// Con CENTINELA_ALLOWED_HOSTS (separada por comas) se usa esa lista; sin autenticación (CENTINELA_AUTH=off)
// y sin variable, se admiten solo localhost, loopback, el nombre del equipo y sus IPs. Con auth activa y sin variable no se filtra.
// Estricto: solo se acepta `nombre[:puerto]` o `[ipv6][:puerto]` (puerto numérico); cualquier otra cosa da null.
function hostName(h) {
  h = String(h || '').trim().toLowerCase();
  var m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(h);
  if (m) return m[1].indexOf(':') >= 0 ? m[1] : null;
  m = /^([a-z0-9]([a-z0-9._-]*[a-z0-9])?)(?::(\d{1,5}))?$/.exec(h);
  return m ? m[1] : null;
}
// Entradas de CENTINELA_ALLOWED_HOSTS: además admite una IPv6 sin corchetes (p. ej. ::1).
function envHost(h) {
  h = String(h || '').trim().toLowerCase();
  return hostName(h) || (/^[0-9a-f:.]*:[0-9a-f:.]*$/.test(h) ? h : null);
}
var ALLOWED_HOSTS = null;
(function () {
  var env = String(process.env.CENTINELA_ALLOWED_HOSTS || '').trim();
  var list = null;
  if (env) list = env.split(',').map(envHost).filter(Boolean);
  else if (!AUTH_ON) {
    list = ['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase()];
    var ifs = os.networkInterfaces();
    Object.keys(ifs).forEach(function (n) { (ifs[n] || []).forEach(function (a) { list.push(String(a.address).toLowerCase()); }); });
  }
  if (list) {
    // Con el filtro activo siempre se aceptan los literales de loopback: en un rebinding el Host es el dominio
    // del atacante, nunca localhost/127.0.0.1/::1 (y así el healthcheck local sigue funcionando).
    list = list.concat(['localhost', '127.0.0.1', '::1']);
    ALLOWED_HOSTS = {}; list.forEach(function (h) { ALLOWED_HOSTS[h] = true; }); }
})();
// 'ok' | 'malformed' (400) | 'denied' (421). Sin filtro activo todo pasa.
function hostCheck(req) {
  if (!ALLOWED_HOSTS) return 'ok';
  var n = hostName(req.headers.host);
  if (n === null) return 'malformed';
  return ALLOWED_HOSTS[n] === true ? 'ok' : 'denied';
}

var MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};
var CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
          "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function sendJson(res, code, obj, extraHeaders) {
  var body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
                        'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(body) }, extraHeaders || {}));
  res.end(body);
}

function ipOf(req) { return req.socket.remoteAddress || ''; }
function sidOf(req) { return authLib.parseCookies(req.headers.cookie)[auth.COOKIE] || null; }
// Con CENTINELA_COOKIE_SECURE=1 la cookie lleva el atributo Secure (úsalo detrás de un proxy con TLS;
// sin HTTPS el navegador no la enviaría).
var COOKIE_SECURE = process.env.CENTINELA_COOKIE_SECURE === '1';
function sessionCookie(sid, maxAgeSec) {
  return auth.COOKIE + '=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAgeSec + (COOKIE_SECURE ? '; Secure' : '');
}
function userView(u) { return u.id === 'local' ? { id: 'local', username: 'local', role: 'admin', mustChange: false } : auth.publicUser(u); }
// Rutas de escritura que cualquier usuario autenticado puede usar (diagnóstico, no cambian la configuración).
function readOnlyAllowed(p) { return p === '/api/traceroute' || /^\/api\/targets\/[A-Za-z0-9_-]{1,64}\/check$/.test(p); }

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      var v;
      try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return reject(Object.assign(new Error('JSON no válido'), { status: 400 })); }
      // Solo se aceptan objetos planos (no null, números, textos ni arreglos).
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(Object.assign(new Error('JSON no válido'), { status: 400 }));
      resolve(v);
    });
    req.on('error', reject);
  });
}

function publicList(orgId) { return store.getTargets(orgId).map(validate.publicTarget); }

// Organización de la petición (?org=ID). Sin parámetro es el host (organización principal).
function orgOf(url) {
  var id = url.searchParams.get('org') || store.DEFAULT_ORG;
  return store.hasOrg(id) ? id : null;
}
function noOrg(res) { return sendJson(res, 404, { error: 'Organización no encontrada' }); }
function orgsPayload() { return { orgs: store.getOrgs(), statuses: scheduler.statuses() }; }
function targetsChanged(orgId) {
  scheduler.reschedule();
  broadcast('targets', { org: orgId, targets: publicList(orgId), statuses: scheduler.statuses(), orgs: store.getOrgs() });
}

function broadcast(event, data) {
  var payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  Array.from(clients.keys()).forEach(function (res) {
    try {
      if (res.writableLength > MAX_STREAM_BUFFER) return dropClient(res); // cliente lento: se corta
      res.write(payload);
    } catch (e) { dropClient(res); }
  });
}

scheduler.on('result', function (r) { broadcast('result', Object.assign({}, r, { org: store.orgOf(r.id) })); });
scheduler.on('event', function (e) { broadcast('event', e); });

function findTarget(id) { return store.findTarget(id); }

// Ids ya usados en cualquier organización (deben ser únicos globalmente). En un reemplazo total
// de una organización, sus propios ids se pueden reutilizar.
function takenIds(exceptOrg) {
  var t = {};
  store.getOrgs().forEach(function (o) {
    if (o.id === exceptOrg) return;
    store.getTargets(o.id).forEach(function (x) { t[x.id] = true; });
  });
  return t;
}

function uniqueId(id, taken) {
  if (!taken[id]) return id;
  var n = validate.newId();
  while (taken[n]) n = validate.newId();
  return n;
}

async function api(req, res, url) {
  var p = url.pathname, m = req.method;

  // Defensa CSRF: las escrituras exigen JSON, lo que obliga a un preflight CORS que este servidor no concede.
  if (m !== 'GET' && m !== 'HEAD' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
    return sendJson(res, 415, { error: 'Content-Type debe ser application/json' });
  }

  // Defensa CSRF adicional: si el navegador indica el origen, debe ser este mismo servidor.
  if (m !== 'GET' && m !== 'HEAD' && req.headers.origin) {
    var oh = ''; try { oh = new URL(req.headers.origin).host; } catch (e) { /* origen no válido */ }
    if (oh !== req.headers.host) return sendJson(res, 403, { error: 'Origen no permitido' });
  }

  // Públicas: comprobación de vida (sin datos del equipo) e inicio de sesión.
  if (p === '/api/health' && m === 'GET') return sendJson(res, 200, { ok: true, mode: 'live', auth: AUTH_ON });
  if (p === '/api/auth/login' && m === 'POST') {
    if (!AUTH_ON) return sendJson(res, 400, { error: 'La autenticación está desactivada en este servidor.' });
    var lb0 = await readBody(req);
    var lr = await auth.login(lb0.username, lb0.password, ipOf(req));
    if (lr.error) return sendJson(res, lr.status || 401, { error: lr.error });
    return sendJson(res, 200, { user: lr.user }, { 'Set-Cookie': sessionCookie(lr.sid, Math.floor(auth.SESSION_MS / 1000)) });
  }

  // Todo lo demás exige sesión.
  var me = AUTH_ON ? auth.fromSid(sidOf(req)) : LOCAL_USER;
  if (!me) return sendJson(res, 401, { error: 'Inicia sesión para continuar', login: true });
  var write = m !== 'GET' && m !== 'HEAD';

  // Contraseña por defecto: hasta cambiarla solo se permite consultar la sesión, cambiar la contraseña y salir.
  if (AUTH_ON && me.defaultPassword &&
      !((p === '/api/auth/me' && m === 'GET') || (p === '/api/auth/password' && m === 'POST') || (p === '/api/auth/logout' && m === 'POST'))) {
    return sendJson(res, 403, { error: 'Debes cambiar la contraseña antes de continuar', mustChange: true });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    auth.logout(sidOf(req));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (p === '/api/auth/me' && m === 'GET') {
    var meBody = { user: userView(me), authEnabled: AUTH_ON };
    // Datos del equipo servidor: solo para administradores.
    if (me.role === 'admin') meBody.server = { host: os.hostname(), platform: process.platform, node: process.version, version: pkg.version };
    return sendJson(res, 200, meBody);
  }
  if (p === '/api/auth/password' && m === 'POST') {
    if (!AUTH_ON) return sendJson(res, 400, { errors: ['La autenticación está desactivada.'] });
    var pb = await readBody(req);
    var pr = await auth.changeOwnPassword(me.id, pb.current, pb.next, sidOf(req), ipOf(req));
    if (pr.errors) return sendJson(res, pr.status || 400, { errors: pr.errors }, pr.closeSession ? { 'Set-Cookie': sessionCookie('', 0) } : null);
    return sendJson(res, 200, { user: pr.value });
  }

  // Gestión de usuarios: solo administradores.
  if (p === '/api/users' || /^\/api\/users\/[A-Za-z0-9_]{1,40}$/.test(p)) {
    if (me.role !== 'admin') return sendJson(res, 403, { error: 'Solo un administrador puede gestionar usuarios' });
    if (p === '/api/users') {
      if (m === 'GET') return sendJson(res, 200, { users: auth.list(), roles: auth.ROLES, minPassword: auth.MIN_PASSWORD });
      if (m === 'POST') {
        var newUserBody = await readBody(req);
        var newUserRes = await auth.create(newUserBody);
        if (newUserRes.errors) return sendJson(res, newUserRes.status || 400, { errors: newUserRes.errors });
        return sendJson(res, 201, { user: newUserRes.value });
      }
    } else {
      var uid = p.split('/')[3];
      if (m === 'PUT') {
        var ub1 = await readBody(req);
        var ur1 = await auth.update(uid, ub1, me.id, sidOf(req));
        if (ur1.errors) return sendJson(res, ur1.status || 400, { errors: ur1.errors });
        return sendJson(res, 200, { user: ur1.value });
      }
      if (m === 'DELETE') {
        var dr0 = auth.remove(uid, me.id);
        if (dr0.errors) return sendJson(res, dr0.status || 400, { errors: dr0.errors });
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 405, { error: 'Método no permitido' });
  }

  // Lectores: solo consulta (y diagnósticos de solo lectura).
  if (write && me.role === 'viewer' && !readOnlyAllowed(p)) return sendJson(res, 403, { error: 'Tu usuario es de solo lectura' });

  if (p === '/api/state' && m === 'GET') {
    var so = orgOf(url); if (!so) return noOrg(res);
    var snap = scheduler.snapshot(so);
    return sendJson(res, 200, { org: so, orgs: store.getOrgs(), statuses: scheduler.statuses(), targets: publicList(so),
                                settings: store.getSettings(), results: snap.results, history: snap.history,
                                events: snap.events, serverTime: Date.now() });
  }

  if (p === '/api/orgs') {
    if (m === 'GET') return sendJson(res, 200, orgsPayload());
    if (m === 'POST') {
      var ob = await readBody(req);
      var orr = store.addOrg(ob);
      if (orr.errors) return sendJson(res, 400, { errors: orr.errors });
      broadcast('orgs', orgsPayload());
      return sendJson(res, 201, { org: orr.value });
    }
  }
  var mo = /^\/api\/orgs\/([a-z0-9]{1,32})$/.exec(p);
  if (mo) {
    if (!store.hasOrg(mo[1])) return noOrg(res);
    if (m === 'PUT') {
      var orgBody = await readBody(req);
      var orgUpdRes = store.updateOrg(mo[1], orgBody);
      if (orgUpdRes.errors) return sendJson(res, 400, { errors: orgUpdRes.errors });
      broadcast('orgs', orgsPayload());
      return sendJson(res, 200, { org: orgUpdRes.value });
    }
    if (m === 'DELETE') {
      var dr = store.removeOrg(mo[1]);
      if (dr.errors) return sendJson(res, 400, { errors: dr.errors });
      scheduler.reschedule();
      broadcast('orgs', orgsPayload());
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === '/api/stream' && m === 'GET') {
    var streamSid = sidOf(req) || 'local';
    var streamKey = AUTH_ON ? streamSid : ipOf(req);
    var streamUser = AUTH_ON ? me.id : ipOf(req);
    // Se cierra el flujo más antiguo de la clave (y del usuario) hasta que quepa el nuevo.
    evictOldest('key', streamKey, MAX_STREAMS_PER_KEY);
    evictOldest('user', streamUser, MAX_STREAMS_PER_USER);
    if (clients.size >= MAX_STREAMS) return sendJson(res, 429, { error: 'Demasiados flujos en vivo abiertos' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive',
                         'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    var ka = setInterval(function () {
      // Si la sesión terminó (cierre, usuario deshabilitado o eliminado, caducidad), se corta el flujo en vivo.
      if (AUTH_ON && !auth.fromSid(streamSid, true)) return dropClient(res);
      try { res.write(': ka\n\n'); } catch (e) { dropClient(res); }
    }, 20000);
    clients.set(res, { sid: streamSid, key: streamKey, user: streamUser, ka: ka });
    req.on('close', function () { dropClient(res); });
    res.on('close', function () { dropClient(res); });
    res.on('error', function () { dropClient(res); });
    return;
  }

  if (p === '/api/settings') {
    if (m === 'GET') return sendJson(res, 200, store.getSettings());
    if (m === 'PUT') {
      var body = await readBody(req);
      if (typeof validate.settingsErrors === 'function') {
        var setErrs = validate.settingsErrors(body, store.getSettings());
        if (setErrs && setErrs.length) return sendJson(res, 400, { errors: setErrs });
      }
      var next = validate.sanitizeSettings(body, store.getSettings());
      store.saveSettings(next);
      broadcast('settings', next);
      return sendJson(res, 200, next);
    }
  }

  if (p === '/api/layout') {
    var lo = orgOf(url); if (!lo) return noOrg(res);
    if (m === 'GET') return sendJson(res, 200, { layout: store.getLayout(lo) });
    if (m === 'PUT') {
      var lb = await readBody(req);
      return sendJson(res, 200, { layout: store.saveLayout(lo, lb) });
    }
  }

  if (p === '/api/traceroute' && m === 'POST') {
    var tb = await readBody(req);
    var host = null;
    if (me.role === 'viewer' && !tb.targetId) return sendJson(res, 403, { error: 'Tu usuario solo puede hacer traceroute a objetivos existentes' });
    if (tb.targetId) {
      var tt = findTarget(String(tb.targetId));
      if (!tt) return sendJson(res, 404, { error: 'Objetivo no encontrado' });
      host = validate.hostFromAddress(tt.kind, tt.address);
    } else host = String(tb.address || '').trim();
    if (!validate.isValidHost(host)) return sendJson(res, 400, { error: 'Dirección no válida para traceroute' });
    var traceKey = AUTH_ON ? me.id : ipOf(req); // con auth off todos son 'local': el cupo es por IP
    if (traceByUser[traceKey]) return sendJson(res, 429, { error: 'Ya tienes un traceroute en curso' });
    if (traceActive >= 3) return sendJson(res, 429, { error: 'Hay demasiados traceroute en curso, intenta en unos segundos' });
    traceActive++; traceByUser[traceKey] = true;
    try { return sendJson(res, 200, Object.assign({ host: host }, await tracer.trace(host))); }
    finally { traceActive--; delete traceByUser[traceKey]; }
  }

  if (p === '/api/targets') {
    var to = orgOf(url); if (!to) return noOrg(res);
    if (m === 'GET') return sendJson(res, 200, { targets: publicList(to) });
    if (m === 'POST') {
      var cb = await readBody(req);
      if (store.getTargets(to).length >= MAX_TARGETS) return sendJson(res, 400, { errors: ['Se alcanzó el máximo de ' + MAX_TARGETS + ' objetivos.'] });
      var cr = validate.sanitizeTarget(cb, null, store.getSettings());
      if (cr.errors.length) return sendJson(res, 400, { errors: cr.errors });
      cr.value.id = uniqueId(cr.value.id, takenIds());
      store.saveTargets(to, store.getTargets(to).concat([cr.value]));
      targetsChanged(to);
      return sendJson(res, 201, { target: validate.publicTarget(cr.value) });
    }
    if (m === 'PUT') { // reemplazo total (importar)
      var ib = await readBody(req);
      var arr = Array.isArray(ib.targets) ? ib.targets : null;
      if (!arr) return sendJson(res, 400, { errors: ['Se esperaba { "targets": [...] }'] });
      if (arr.length > MAX_TARGETS) return sendJson(res, 400, { errors: ['Máximo ' + MAX_TARGETS + ' objetivos.'] });
      var errs = [], seen = takenIds(to), out = [];
      arr.forEach(function (x, i) {
        var prev = x && x.id ? findTarget(String(x.id)) : null; // conserva el token del agente de objetivos existentes
        if (prev && store.orgOf(prev.id) !== to) prev = null;
        var r = validate.sanitizeTarget(x, prev, store.getSettings());
        if (r.errors.length) errs.push('Fila ' + (i + 1) + ': ' + r.errors.join(' '));
        else { r.value.id = uniqueId(r.value.id, seen); seen[r.value.id] = true; out.push(r.value); }
      });
      if (errs.length) return sendJson(res, 400, { errors: errs.slice(0, 20) });
      store.saveTargets(to, out);
      targetsChanged(to);
      return sendJson(res, 200, { targets: publicList(to) });
    }
  }

  var mt = /^\/api\/targets\/([A-Za-z0-9_-]{1,64})(\/check)?$/.exec(p);
  if (mt) {
    var id = mt[1], existing = null, ub = null;
    // En PUT el cuerpo se lee antes de buscar el objetivo: durante la lectura pudo borrarse.
    if (!mt[2] && m === 'PUT') ub = await readBody(req);
    existing = findTarget(id);
    if (!existing) return sendJson(res, 404, { error: 'Objetivo no encontrado' });

    if (mt[2] && m === 'POST') {
      // Si la verificación excede CENTINELA_CHECK_TIMEOUT_MS, runOne no lanza: devuelve un resultado DOWN
      // con motivo code 'timeout', que se responde con 200 como cualquier otro resultado.
      if (scheduler.isRunning(id)) return sendJson(res, 409, { error: 'Ya hay una verificación en curso para este objetivo' });
      var rr = await scheduler.runOne(existing);
      return sendJson(res, 200, { result: rr });
    }
    if (!mt[2] && m === 'PUT') {
      var ur = validate.sanitizeTarget(ub, existing, store.getSettings());
      if (ur.errors.length) return sendJson(res, 400, { errors: ur.errors });
      ur.value.id = id;
      var uo = store.orgOf(id);
      if (!uo) return sendJson(res, 404, { error: 'Objetivo no encontrado' });
      store.saveTargets(uo, store.getTargets(uo).map(function (t) { return t.id === id ? ur.value : t; }));
      targetsChanged(uo);
      return sendJson(res, 200, { target: validate.publicTarget(ur.value) });
    }
    if (!mt[2] && m === 'DELETE') {
      var dorg = store.orgOf(id);
      if (!dorg) return sendJson(res, 404, { error: 'Objetivo no encontrado' });
      store.saveTargets(dorg, store.getTargets(dorg).filter(function (t) { return t.id !== id; }));
      targetsChanged(dorg);
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'Ruta no encontrada' });
}

// Solo se sirven index.html, assets/ y js/. data/, server/ y agent/ nunca son accesibles por HTTP.
function serveStatic(req, res, url) {
  var rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('Solicitud no válida'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  var allowed = rel === '/index.html' || rel.indexOf('/assets/') === 0 || rel.indexOf('/js/') === 0;
  var full = path.normalize(path.join(ROOT, rel));
  if (!allowed || full.indexOf(ROOT + path.sep) !== 0 || rel.indexOf('\0') >= 0) { res.writeHead(404); return res.end('No encontrado'); }
  fs.readFile(full, function (err, buf) {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    var ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache',
                         'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

var server = http.createServer(function (req, res) {
  var hc = hostCheck(req);
  if (hc === 'malformed') return sendJson(res, 400, { error: 'Host no válido' });
  if (hc === 'denied') return sendJson(res, 421, { error: 'Host no permitido' });
  var url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return sendJson(res, 400, { error: 'Solicitud no válida' }); }
  if (url.pathname.indexOf('/api/') === 0) {
    api(req, res, url).catch(function (e) {
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Error interno del servidor' });
      if (!e.status) console.error('[api]', req.method, url.pathname, e);
    });
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url);
  } else {
    res.writeHead(405); res.end();
  }
});

server.listen(PORT, HOST, function () {
  scheduler.start();
  console.log('Centinela ' + pkg.version + ' → http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log(AUTH_ON ? 'Acceso: inicio de sesión activado (' + auth.count() + ' usuario(s))' : 'AVISO: CENTINELA_AUTH=off, la API no pide inicio de sesión.');
  if (auth.seeded) {
    console.log('Usuario inicial creado: ' + auth.seeded.username + (auth.seeded.isDefault ? ' (deberá cambiar la contraseña al entrar)' : ''));
  }
  console.log('Datos en: ' + store.dir + '  |  ' + store.allTargets().length + ' objetivos en ' + store.getOrgs().length + ' organización(es)');
  if (!AUTH_ON && HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('AVISO: sin autenticación y abierto a la red; protégelo con un firewall.');
});

function shutdown() {
  scheduler.stop();
  Array.from(clients.keys()).forEach(dropClient);
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
