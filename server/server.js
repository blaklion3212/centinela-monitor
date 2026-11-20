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
 *
 * Variables de entorno de red y robustez (además de PORT, HOST, CENTINELA_AUTH, CENTINELA_COOKIE_SECURE...):
 *   - CENTINELA_TRUST_PROXY: lista de IPs de proxies inversos de confianza, separadas por comas (p. ej. 127.0.0.1,10.0.0.5).
 *     Solo si la conexión TCP llega desde una de ellas se lee X-Forwarded-For y la IP del cliente es la entrada más a la
 *     derecha que NO sea un proxy de confianza. Esa IP (clientIp) se usa en los límites de login y de cambio de contraseña,
 *     en el cupo de traceroute y en la clave SSE sin autenticación. Sin la variable, X-Forwarded-For se ignora.
 *   - CENTINELA_CONCURRENCY y CENTINELA_CHECK_TIMEOUT_MS: ver server/lib/scheduler.js (las verificaciones colgadas tras el
 *     plazo reducen la capacidad efectiva, sin bloquearla del todo).
 *   - POST /api/targets/:id/check: intervalo mínimo de 5 s por objetivo entre verificaciones manuales (429 + Retry-After).
 *
 * Alertas opcionales por Telegram (solo administradores, rutas /api/alerts*; ver docs/requisitos/alertas.md):
 *   - CENTINELA_TELEGRAM_TOKEN: token del bot. Tiene prioridad sobre el guardado en el panel (data/alerts.json).
 *     Mejor definirlo en el .env que guardarlo en el panel.
 *   - CENTINELA_ALERTS_DISABLED: 1 o true bloquea la función entera (no se envía nada, ni pruebas ni búsqueda de chats).
 *   - POST /api/alerts/test y /api/alerts/chats: una acción en curso por administrador y como mínimo 5 s entre acciones (429 + Retry-After).
 */
var http = require('http');
var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');

var store = require('./lib/store').load();
var validate = require('./lib/validate');
var routes = require('./lib/routes');
var Scheduler = require('./lib/scheduler').Scheduler;
var tracer = require('./probes/traceroute');
var authLib = require('./lib/auth');
var alertsCfg = require('./lib/alerts-config');
var telegram = require('./lib/channels/telegram');
var notify = require('./lib/notify');
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

// Alertas por Telegram: configuración (data/alerts.json), canal de red y motor de avisos.
var storeMod = require('./lib/store');
var alertsStore = {
  load: function () { return alertsCfg.load(storeMod, store.getOrgs().map(function (o) { return o.id; })); },
  save: function (cfg) { alertsCfg.save(storeMod, cfg); },
  cfgApi: alertsCfg
};
var tgChannel = telegram.create({ apiBase: process.env.CENTINELA_TELEGRAM_API_BASE || undefined, timeoutMs: 10000, maxBodyBytes: 262144 });
if (tgChannel.baseWarning) console.warn('[alertas] ' + tgChannel.baseWarning);
else if (tgChannel.apiBase !== 'https://api.telegram.org') console.log('[alertas] Usando base alternativa de la API: ' + new URL(tgChannel.apiBase).origin);
var notifyConsts = {};
// Variable interna de pruebas: ventana de agrupación (entero acotado entre 0 y 60000 ms).
if (/^\d{1,5}$/.test(String(process.env.CENTINELA_ALERTS_GROUP_WINDOW_MS || '').trim())) {
  notifyConsts.GROUP_WINDOW_MS = Math.min(60000, parseInt(process.env.CENTINELA_ALERTS_GROUP_WINDOW_MS, 10));
}
var notifier = notify.create({ store: store, alertsStore: alertsStore, channel: tgChannel, env: process.env,
  version: pkg.version, consts: notifyConsts, chatsFromUpdates: telegram.chatsFromUpdates,
  thresholds: function () { return store.getSettings().thresholds; } });
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

// IPs de proxies de confianza (CENTINELA_TRUST_PROXY, separadas por comas). Vacío: X-Forwarded-For se ignora.
function normIp(ip) { ip = String(ip || '').trim().toLowerCase(); return ip.indexOf('::ffff:') === 0 ? ip.slice(7) : ip; }
// Entrada de X-Forwarded-For: quita corchetes y puerto ('a.b.c.d:port', '[v6]:port') y valida con net.isIP.
// Devuelve la IP normalizada (IPv6 en minúsculas) o '' si no es una IP válida.
function parseForwarded(v) {
  v = String(v || '').trim().toLowerCase();
  var m = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(v);
  if (m) v = m[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  v = normIp(v);
  return net.isIP(v) ? v : '';
}
// Proxies de confianza: solo IP literales; lo demás (p. ej. CIDR) se avisa y se ignora.
var TRUSTED_PROXIES = String(process.env.CENTINELA_TRUST_PROXY || '').split(',').map(function (x) { return x.trim(); })
  .filter(Boolean).map(function (x) {
    var n = normIp(x);
    if (!net.isIP(n)) { console.warn('CENTINELA_TRUST_PROXY: entrada ignorada (no es una IP): ' + x); return ''; }
    return n;
  }).filter(Boolean);
function isTrustedProxy(ip) { return TRUSTED_PROXIES.indexOf(normIp(ip)) >= 0; }
// IP del cliente: la remota, salvo que venga de un proxy de confianza; entonces, la entrada válida más a la derecha de
// X-Forwarded-For que no sea un proxy de confianza (las entradas no válidas se descartan; si no hay ninguna, la remota).
function clientIp(req) {
  var remote = normIp(req.socket.remoteAddress);
  if (!TRUSTED_PROXIES.length || !isTrustedProxy(remote)) return remote;
  var xff = req.headers['x-forwarded-for'];
  if (Array.isArray(xff)) xff = xff.join(',');
  var parts = String(xff || '').split(',').map(parseForwarded).filter(Boolean);
  for (var i = parts.length - 1; i >= 0; i--) if (!isTrustedProxy(parts[i])) return parts[i];
  return remote;
}
var ipOf = clientIp;
// Última verificación manual por objetivo (H-17): intervalo mínimo de 5 s.
var MANUAL_MIN_MS = 5000;
var lastManual = new Map();
function pruneManual() {
  var now = Date.now();
  lastManual.forEach(function (t, k) {
    // Se poda si ya pasó el intervalo y no corre, o si el objetivo ya no existe.
    if ((now - t >= MANUAL_MIN_MS && !scheduler.isRunning(k)) || !store.findTarget(k)) lastManual.delete(k);
  });
  manualQuota.forEach(function (q, k) {
    q.stamps = q.stamps.filter(function (t) { return now - t < MANUAL_WINDOW_MS; });
    if (!q.inflight && !q.stamps.length) manualQuota.delete(k);
  });
}
// Cupo de verificaciones manuales por usuario (o por IP sin auth): máx. 3 simultáneas y 30 por minuto.
var MANUAL_MAX_INFLIGHT = 3, MANUAL_MAX_PER_MIN = 30, MANUAL_WINDOW_MS = 60000;
var manualQuota = new Map(); // clave -> { inflight, stamps[] }
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
  pruneManual();
  notifier.prune();
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

/*
 * Manejadores de la API. Todos reciben un contexto c = { req, res, url, me, params, p, m }:
 * `me` es el usuario autenticado (o el local con auth off) y `params` los parámetros de la ruta (':id').
 * Los que responden por sí mismos (sendJson) no devuelven nada; las funciones `pre` de las rutas devuelven true
 * si ya respondieron (en ese caso no se ejecuta el manejador).
 */
function notFound(c) { return sendJson(c.res, 404, { error: 'Ruta no encontrada' }); }

// Públicas: comprobación de vida (sin datos del equipo) e inicio de sesión.
function hHealth(c) { return sendJson(c.res, 200, { ok: true, mode: 'live', auth: AUTH_ON }); }
async function hLogin(c) {
  if (!AUTH_ON) return sendJson(c.res, 400, { error: 'La autenticación está desactivada en este servidor.' });
  var lb0 = await readBody(c.req);
  var lr = await auth.login(lb0.username, lb0.password, ipOf(c.req));
  if (lr.error) return sendJson(c.res, lr.status || 401, { error: lr.error });
  return sendJson(c.res, 200, { user: lr.user }, { 'Set-Cookie': sessionCookie(lr.sid, Math.floor(auth.SESSION_MS / 1000)) });
}

// Sesión propia.
function hLogout(c) {
  auth.logout(sidOf(c.req));
  return sendJson(c.res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}
function hMe(c) {
  var meBody = { user: userView(c.me), authEnabled: AUTH_ON };
  // Datos del equipo servidor: solo para administradores.
  if (c.me.role === 'admin') meBody.server = { host: os.hostname(), platform: process.platform, node: process.version, version: pkg.version };
  return sendJson(c.res, 200, meBody);
}
async function hPassword(c) {
  if (!AUTH_ON) return sendJson(c.res, 400, { errors: ['La autenticación está desactivada.'] });
  var pb = await readBody(c.req);
  var pr = await auth.changeOwnPassword(c.me.id, pb.current, pb.next, sidOf(c.req), ipOf(c.req));
  if (pr.errors) return sendJson(c.res, pr.status || 400, { errors: pr.errors }, pr.closeSession ? { 'Set-Cookie': sessionCookie('', 0) } : null);
  return sendJson(c.res, 200, { user: pr.value });
}

// Gestión de usuarios (solo administradores).
function hUsersList(c) { return sendJson(c.res, 200, { users: auth.list(), roles: auth.ROLES, minPassword: auth.MIN_PASSWORD }); }
async function hUsersCreate(c) {
  var newUserBody = await readBody(c.req);
  var newUserRes = await auth.create(newUserBody);
  if (newUserRes.errors) return sendJson(c.res, newUserRes.status || 400, { errors: newUserRes.errors });
  return sendJson(c.res, 201, { user: newUserRes.value });
}
async function hUsersUpdate(c) {
  var ub1 = await readBody(c.req);
  var ur1 = await auth.update(c.params.id, ub1, c.me.id, sidOf(c.req));
  if (ur1.errors) return sendJson(c.res, ur1.status || 400, { errors: ur1.errors });
  return sendJson(c.res, 200, { user: ur1.value });
}
function hUsersRemove(c) {
  var dr0 = auth.remove(c.params.id, c.me.id);
  if (dr0.errors) return sendJson(c.res, dr0.status || 400, { errors: dr0.errors });
  return sendJson(c.res, 200, { ok: true });
}

// Estado completo, organizaciones y flujo en vivo.
function hState(c) {
  var so = orgOf(c.url); if (!so) return noOrg(c.res);
  var snap = scheduler.snapshot(so);
  return sendJson(c.res, 200, { org: so, orgs: store.getOrgs(), statuses: scheduler.statuses(), targets: publicList(so),
                                settings: store.getSettings(), results: snap.results, history: snap.history,
                                events: snap.events, serverTime: Date.now() });
}
function hOrgsList(c) { return sendJson(c.res, 200, orgsPayload()); }
async function hOrgsCreate(c) {
  var ob = await readBody(c.req);
  var orr = store.addOrg(ob);
  if (orr.errors) return sendJson(c.res, 400, { errors: orr.errors });
  broadcast('orgs', orgsPayload());
  return sendJson(c.res, 201, { org: orr.value });
}
// Las rutas /api/orgs/:id comprueban que la organización exista antes de mirar el método.
function preOrgParam(c) { if (!store.hasOrg(c.params.id)) { noOrg(c.res); return true; } }
async function hOrgsUpdate(c) {
  var orgBody = await readBody(c.req);
  var orgUpdRes = store.updateOrg(c.params.id, orgBody);
  if (orgUpdRes.errors) return sendJson(c.res, 400, { errors: orgUpdRes.errors });
  broadcast('orgs', orgsPayload());
  return sendJson(c.res, 200, { org: orgUpdRes.value });
}
function hOrgsRemove(c) {
  var dr = store.removeOrg(c.params.id);
  if (dr.errors) return sendJson(c.res, 400, { errors: dr.errors });
  scheduler.reschedule();
  notifier.prune();
  broadcast('orgs', orgsPayload());
  return sendJson(c.res, 200, { ok: true });
}

function hStream(c) {
  var req = c.req, res = c.res;
  var streamSid = sidOf(req) || 'local';
  var streamKey = AUTH_ON ? streamSid : ipOf(req);
  var streamUser = AUTH_ON ? c.me.id : ipOf(req);
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
}

// Ajustes, disposición y traceroute.
function hSettingsGet(c) { return sendJson(c.res, 200, store.getSettings()); }
async function hSettingsPut(c) {
  var body = await readBody(c.req);
  if (typeof validate.settingsErrors === 'function') {
    var setErrs = validate.settingsErrors(body, store.getSettings());
    if (setErrs && setErrs.length) return sendJson(c.res, 400, { errors: setErrs });
  }
  var next = validate.sanitizeSettings(body, store.getSettings());
  store.saveSettings(next);
  broadcast('settings', next);
  return sendJson(c.res, 200, next);
}
// Las rutas con ?org= resuelven la organización (c.org) antes de mirar el método.
function preOrgQuery(c) { c.org = orgOf(c.url); if (!c.org) { noOrg(c.res); return true; } }
function hLayoutGet(c) { return sendJson(c.res, 200, { layout: store.getLayout(c.org) }); }
async function hLayoutPut(c) {
  var lb = await readBody(c.req);
  return sendJson(c.res, 200, { layout: store.saveLayout(c.org, lb) });
}
async function hTraceroute(c) {
  var res = c.res, me = c.me;
  var tb = await readBody(c.req);
  var host = null;
  if (me.role === 'viewer' && !tb.targetId) return sendJson(res, 403, { error: 'Tu usuario solo puede hacer traceroute a objetivos existentes' });
  if (tb.targetId) {
    var tt = findTarget(String(tb.targetId));
    if (!tt) return sendJson(res, 404, { error: 'Objetivo no encontrado' });
    host = validate.hostFromAddress(tt.kind, tt.address);
  } else host = String(tb.address || '').trim();
  if (!validate.isValidHost(host)) return sendJson(res, 400, { error: 'Dirección no válida para traceroute' });
  var traceKey = AUTH_ON ? me.id : ipOf(c.req); // con auth off todos son 'local': el cupo es por IP
  if (traceByUser[traceKey]) return sendJson(res, 429, { error: 'Ya tienes un traceroute en curso' });
  if (traceActive >= 3) return sendJson(res, 429, { error: 'Hay demasiados traceroute en curso, intenta en unos segundos' });
  traceActive++; traceByUser[traceKey] = true;
  try { return sendJson(res, 200, Object.assign({ host: host }, await tracer.trace(host))); }
  finally { traceActive--; delete traceByUser[traceKey]; }
}

// Objetivos.
function hTargetsList(c) { return sendJson(c.res, 200, { targets: publicList(c.org) }); }
async function hTargetsCreate(c) {
  var to = c.org, res = c.res;
  var cb = await readBody(c.req);
  if (store.getTargets(to).length >= MAX_TARGETS) return sendJson(res, 400, { errors: ['Se alcanzó el máximo de ' + MAX_TARGETS + ' objetivos.'] });
  var cr = validate.sanitizeTarget(cb, null, store.getSettings());
  if (cr.errors.length) return sendJson(res, 400, { errors: cr.errors });
  cr.value.id = uniqueId(cr.value.id, takenIds());
  store.saveTargets(to, store.getTargets(to).concat([cr.value]));
  targetsChanged(to);
  return sendJson(res, 201, { target: validate.publicTarget(cr.value) });
}
async function hTargetsReplace(c) { // reemplazo total (importar)
  var to = c.org, res = c.res;
  var ib = await readBody(c.req);
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
// Las rutas /api/targets/:id buscan el objetivo (c.existing) antes de mirar el método. En el PUT el cuerpo se lee
// antes de buscar: durante la lectura pudo borrarse.
function preTarget(c) {
  c.existing = findTarget(c.params.id);
  if (!c.existing) { sendJson(c.res, 404, { error: 'Objetivo no encontrado' }); return true; }
}
async function preTargetBody(c) { c.body = await readBody(c.req); return preTarget(c); }
async function hTargetCheck(c) {
  var id = c.params.id;
  // Si la verificación excede CENTINELA_CHECK_TIMEOUT_MS, runOne no lanza: devuelve un resultado DOWN
  // con motivo code 'timeout', que se responde con 200 como cualquier otro resultado.
  if (scheduler.isRunning(id)) return sendJson(c.res, 409, { error: 'Ya hay una verificación en curso para este objetivo' });
  var nowM = Date.now(), lastM = lastManual.get(id) || 0;
  if (nowM - lastM < MANUAL_MIN_MS) {
    var wait = Math.max(1, Math.ceil((MANUAL_MIN_MS - (nowM - lastM)) / 1000));
    return sendJson(c.res, 429, { error: 'Espera unos segundos antes de volver a verificar este objetivo' }, { 'Retry-After': String(wait) });
  }
  var qKey = AUTH_ON ? c.me.id : ipOf(c.req);
  var q = manualQuota.get(qKey);
  if (!q) { q = { inflight: 0, stamps: [] }; manualQuota.set(qKey, q); }
  q.stamps = q.stamps.filter(function (t) { return nowM - t < MANUAL_WINDOW_MS; });
  if (q.inflight >= MANUAL_MAX_INFLIGHT || q.stamps.length >= MANUAL_MAX_PER_MIN) {
    var qWait = q.inflight >= MANUAL_MAX_INFLIGHT || !q.stamps.length ? 5 : Math.max(1, Math.ceil((MANUAL_WINDOW_MS - (nowM - q.stamps[0])) / 1000));
    return sendJson(c.res, 429, { error: 'Demasiadas verificaciones manuales; espera un momento' }, { 'Retry-After': String(qWait) });
  }
  q.inflight++; q.stamps.push(nowM);
  lastManual.set(id, nowM); // se reserva antes de verificar; se actualiza al terminar
  var rr;
  try { rr = await scheduler.runOne(c.existing); } finally { q.inflight--; lastManual.set(id, Date.now()); pruneManual(); }
  return sendJson(c.res, 200, { result: rr });
}
function hTargetUpdate(c) {
  var id = c.params.id, res = c.res;
  var ur = validate.sanitizeTarget(c.body, c.existing, store.getSettings());
  if (ur.errors.length) return sendJson(res, 400, { errors: ur.errors });
  ur.value.id = id;
  var uo = store.orgOf(id);
  if (!uo) return sendJson(res, 404, { error: 'Objetivo no encontrado' });
  store.saveTargets(uo, store.getTargets(uo).map(function (t) { return t.id === id ? ur.value : t; }));
  targetsChanged(uo);
  return sendJson(res, 200, { target: validate.publicTarget(ur.value) });
}
function hTargetRemove(c) {
  var id = c.params.id;
  var dorg = store.orgOf(id);
  if (!dorg) return sendJson(c.res, 404, { error: 'Objetivo no encontrado' });
  store.saveTargets(dorg, store.getTargets(dorg).filter(function (t) { return t.id !== id; }));
  targetsChanged(dorg);
  return sendJson(c.res, 200, { ok: true });
}

// Alertas por Telegram (solo administradores). Nunca se devuelve ni se registra el token.
var ALERTS_MIN_MS = 5000;
var alertsAct = {};            // administrador (o IP con auth off) -> { busy, last }
function alertsLog(c, msg) { console.log('[alertas] ' + msg + ' por ' + c.me.username); }
function tokenEnvConflict(c) {
  if (alertsCfg.tokenInfo(alertsStore.load(), process.env).source !== 'env') return false;
  sendJson(c.res, 409, { error: 'El token está definido en la variable de entorno CENTINELA_TELEGRAM_TOKEN; quita la variable para gestionarlo desde el panel', code: 'token_from_env' });
  return true;
}
function hAlertsGet(c) {
  var cfg = alertsStore.load();
  return sendJson(c.res, 200, Object.assign(alertsCfg.publicView(cfg, process.env), { tokenEnvInvalid: alertsCfg.tokenInfo(cfg, process.env).envInvalid }));
}
async function hAlertsPut(c) {
  var body = await readBody(c.req);
  var cur = alertsStore.load();
  var vr = alertsCfg.validateUpdate(body, cur, process.env);
  if (vr.errors) return sendJson(c.res, 400, { errors: vr.errors });
  // Se relee justo antes de guardar y se conservan el token y `alerted` actuales.
  var fresh = alertsStore.load();
  var next = vr.value;
  next.token = fresh.token; next.alerted = fresh.alerted;
  alertsStore.save(next);
  notifier.reload();
  if (!!fresh.enabled !== !!next.enabled) alertsLog(c, next.enabled ? 'activadas' : 'desactivadas');
  // RA-14: todo guardado deja rastro; solo los nombres de los campos cambiados, sin valores.
  var changed = ['chatId', 'detail', 'failsBeforeAlert'].filter(function (k) { return fresh[k] !== next[k]; });
  // Tipos de «Qué avisar» que cambiaron: solo nombres de tipo, nunca objetivos ni particiones.
  var types = alertsCfg.NOTIFY_KEYS.filter(function (k) { return !!(fresh.notify && fresh.notify[k]) !== !!(next.notify && next.notify[k]); });
  if (types.length) changed.push('tipos: ' + types.join(', '));
  alertsLog(c, 'ajustes guardados' + (changed.length ? ' (' + changed.join(', ') + ')' : ' sin cambios'));
  return sendJson(c.res, 200, alertsCfg.publicView(next, process.env));
}
async function hAlertsTokenPut(c) {
  var body = await readBody(c.req);
  if (tokenEnvConflict(c)) return;
  var tk = typeof body.token === 'string' ? body.token.trim() : '';
  if (!alertsCfg.validateToken(tk)) return sendJson(c.res, 400, { errors: ['Parece incompleto: cópialo entero desde BotFather'] });
  var cfg = alertsStore.load();
  cfg.token = tk;
  alertsStore.save(cfg);
  notifier.reload();
  alertsLog(c, 'token guardado desde el panel');
  var ti = alertsCfg.tokenInfo(cfg, process.env);
  return sendJson(c.res, 200, { tokenConfigured: ti.source !== 'none', tokenHint: ti.hint, tokenSource: ti.source });
}
function hAlertsTokenDelete(c) {
  if (tokenEnvConflict(c)) return;
  var cfg = alertsStore.load();
  cfg.token = '';
  var wasOn = cfg.enabled;
  cfg.enabled = false; // sin token no puede seguir activada
  alertsStore.save(cfg);
  notifier.reload();
  alertsLog(c, 'token borrado del panel' + (wasOn ? '; alertas desactivadas' : ''));
  return sendJson(c.res, 200, { tokenConfigured: false, tokenSource: alertsCfg.tokenInfo(cfg, process.env).source, enabled: !!cfg.enabled });
}
function hAlertsStatus(c) {
  var st = notifier.status(), envInvalid = alertsCfg.tokenInfo(alertsStore.load(), process.env).envInvalid;
  // RA-21: una variable de token con formato no válido se ignora y se explica en la nota.
  if (envInvalid && !st.note) st.note = 'La variable no tiene formato de token (CENTINELA_TELEGRAM_TOKEN): se ignora.';
  return sendJson(c.res, 200, Object.assign(st, { tokenEnvInvalid: envInvalid, blockedByEnv: alertsCfg.blockedByEnv(process.env) }));
}
// Prueba y búsqueda de chats: bloqueo por entorno, una acción a la vez y una cada 5 s por administrador.
async function alertsAction(c, run) {
  var body = await readBody(c.req);
  if (alertsCfg.blockedByEnv(process.env)) {
    return sendJson(c.res, 409, { error: 'alerts_disabled_by_env', code: 'alerts_disabled_by_env',
      message: 'Las alertas están bloqueadas por la variable de entorno CENTINELA_ALERTS_DISABLED; quítala y reinicia el servidor para usarlas.' });
  }
  var key = AUTH_ON ? c.me.id : ipOf(c.req);
  var st = alertsAct[key] || (alertsAct[key] = { busy: false, last: 0 });
  var nowA = Date.now();
  if (st.busy) return sendJson(c.res, 429, { error: 'Ya hay una acción de alertas en curso; espera a que termine' }, { 'Retry-After': '5' });
  if (nowA - st.last < ALERTS_MIN_MS) {
    var aw = Math.max(1, Math.ceil((ALERTS_MIN_MS - (nowA - st.last)) / 1000));
    return sendJson(c.res, 429, { error: 'Espera unos segundos antes de repetir esta acción' }, { 'Retry-After': String(aw) });
  }
  st.busy = true; st.last = nowA;
  var r;
  try { r = await run(body); } finally { st.busy = false; st.last = Date.now(); }
  if (r && r.ok === false) {
    if (r.code === 'no_token' || r.code === 'no_chat') return sendJson(c.res, 400, { error: r.message, code: r.code });
    if (r.retryAfterS != null) r = Object.assign({}, r, { retryAfter: r.retryAfterS });
  }
  return sendJson(c.res, 200, r);
}
function hAlertsTest(c) {
  return alertsAction(c, function (b) { return notifier.test(typeof b.chatId === 'string' && b.chatId ? b.chatId : undefined); });
}
function hAlertsChats(c) { return alertsAction(c, function () { return notifier.findChats(); }); }

/*
 * Tabla de rutas. Gana la PRIMERA que coincide en método y patrón. No hay entradas comodín: si el patrón existe con
 * otro método, la respuesta es 405 con `Allow` (ver api()); las comprobaciones `pre` (organización u objetivo
 * inexistente) solo se ejecutan cuando el método SÍ está declarado.
 * Campos:
 *   - access: 'public' (sin sesión) | 'session' (cualquier usuario con sesión, incluso lectores) | 'admin' |
 *             'standard' (los lectores solo pueden hacer lecturas y los diagnósticos de readOnlyAllowed).
 *   - deniedMsg: mensaje del 403 cuando una ruta 'admin' se pide sin ser administrador (por defecto el de gestión de usuarios).
 *   - mustChange: con la contraseña temporal sin cambiar, la ruta sigue permitida.
 *   - pre: comprobación previa al manejador; devuelve true si ya respondió.
 * Rutas no listadas: 404 'Ruta no encontrada', tras la sesión y el control de lectores. Patrón listado con otro método: 405.
 * HEAD se trata como GET (sin cuerpo; lo descarta Node). Excepción: `noHead: true` (/api/stream), porque un HEAD abriría
 * un flujo SSE registrado y sin lector; ahí HEAD responde 405 con `Allow: GET`.
 */
var ID_USER = '[A-Za-z0-9_]{1,40}', ID_ORG = '[a-z0-9]{1,32}', ID_TARGET = '[A-Za-z0-9_-]{1,64}';
var ALERTS_DENIED = 'Solo un administrador puede configurar las alertas';
var ROUTES = [
  { method: 'GET',    pattern: '/api/health',         access: 'public', handler: hHealth },
  { method: 'POST',   pattern: '/api/auth/login',     access: 'public', handler: hLogin },

  { method: 'POST',   pattern: '/api/auth/logout',    access: 'session', mustChange: true, handler: hLogout },
  { method: 'GET',    pattern: '/api/auth/me',        access: 'session', mustChange: true, handler: hMe },
  { method: 'POST',   pattern: '/api/auth/password',  access: 'session', mustChange: true, handler: hPassword },

  { method: 'GET',    pattern: '/api/users',          access: 'admin', handler: hUsersList },
  { method: 'POST',   pattern: '/api/users',          access: 'admin', handler: hUsersCreate },
  { method: 'PUT',    pattern: '/api/users/:id',      params: { id: ID_USER }, access: 'admin', handler: hUsersUpdate },
  { method: 'DELETE', pattern: '/api/users/:id',      params: { id: ID_USER }, access: 'admin', handler: hUsersRemove },

  { method: 'GET',    pattern: '/api/alerts',         access: 'admin', deniedMsg: ALERTS_DENIED, handler: hAlertsGet },
  { method: 'PUT',    pattern: '/api/alerts',         access: 'admin', deniedMsg: ALERTS_DENIED, handler: hAlertsPut },
  { method: 'PUT',    pattern: '/api/alerts/token',   access: 'admin', deniedMsg: ALERTS_DENIED, handler: hAlertsTokenPut },
  { method: 'DELETE', pattern: '/api/alerts/token',   access: 'admin', deniedMsg: ALERTS_DENIED, handler: hAlertsTokenDelete },
  { method: 'POST',   pattern: '/api/alerts/test',    access: 'admin', deniedMsg: ALERTS_DENIED, handler: hAlertsTest },
  { method: 'POST',   pattern: '/api/alerts/chats',   access: 'admin', deniedMsg: ALERTS_DENIED, handler: hAlertsChats },
  { method: 'GET',    pattern: '/api/alerts/status',  access: 'admin', deniedMsg: ALERTS_DENIED, handler: hAlertsStatus },

  { method: 'GET',    pattern: '/api/state',          access: 'standard', handler: hState },
  { method: 'GET',    pattern: '/api/orgs',           access: 'standard', handler: hOrgsList },
  { method: 'POST',   pattern: '/api/orgs',           access: 'standard', handler: hOrgsCreate },
  { method: 'PUT',    pattern: '/api/orgs/:id',       params: { id: ID_ORG }, access: 'standard', pre: preOrgParam, handler: hOrgsUpdate },
  { method: 'DELETE', pattern: '/api/orgs/:id',       params: { id: ID_ORG }, access: 'standard', pre: preOrgParam, handler: hOrgsRemove },
  { method: 'GET',    pattern: '/api/stream',         access: 'standard', noHead: true, handler: hStream },
  { method: 'GET',    pattern: '/api/settings',       access: 'standard', handler: hSettingsGet },
  { method: 'PUT',    pattern: '/api/settings',       access: 'standard', handler: hSettingsPut },
  { method: 'GET',    pattern: '/api/layout',         access: 'standard', pre: preOrgQuery, handler: hLayoutGet },
  { method: 'PUT',    pattern: '/api/layout',         access: 'standard', pre: preOrgQuery, handler: hLayoutPut },
  { method: 'POST',   pattern: '/api/traceroute',     access: 'standard', handler: hTraceroute },
  { method: 'GET',    pattern: '/api/targets',        access: 'standard', pre: preOrgQuery, handler: hTargetsList },
  { method: 'POST',   pattern: '/api/targets',        access: 'standard', pre: preOrgQuery, handler: hTargetsCreate },
  { method: 'PUT',    pattern: '/api/targets',        access: 'standard', pre: preOrgQuery, handler: hTargetsReplace },
  { method: 'PUT',    pattern: '/api/targets/:id',    params: { id: ID_TARGET }, access: 'standard', pre: preTargetBody, handler: hTargetUpdate },
  { method: 'DELETE', pattern: '/api/targets/:id',    params: { id: ID_TARGET }, access: 'standard', pre: preTarget, handler: hTargetRemove },
  { method: 'POST',   pattern: '/api/targets/:id/check', params: { id: ID_TARGET }, access: 'standard', pre: preTarget, handler: hTargetCheck }
];
var router = routes.createRouter(ROUTES);

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

  var hit = router.match(m, p), route = hit && hit.route;
  var c = { req: req, res: res, url: url, me: null, params: hit ? hit.params : {}, p: p, m: m };

  // Públicas: comprobación de vida e inicio de sesión.
  if (route && route.access === 'public') return route.handler(c);

  // Todo lo demás exige sesión.
  var me = AUTH_ON ? auth.fromSid(sidOf(req)) : LOCAL_USER;
  if (!me) return sendJson(res, 401, { error: 'Inicia sesión para continuar', login: true });
  c.me = me;
  var write = m !== 'GET' && m !== 'HEAD';

  // Contraseña por defecto: hasta cambiarla solo se permite consultar la sesión, cambiar la contraseña y salir.
  if (AUTH_ON && me.defaultPassword && !(route && route.mustChange)) {
    return sendJson(res, 403, { error: 'Debes cambiar la contraseña antes de continuar', mustChange: true });
  }

  // Gestión de usuarios: solo administradores.
  if (route && route.access === 'admin' && me.role !== 'admin') return sendJson(res, 403, { error: route.deniedMsg || 'Solo un administrador puede gestionar usuarios' });

  // Ruta existente con un método no declarado: se resuelve aquí para que el 405 llegue DESPUÉS de 401 y 403 (un
  // anónimo nunca averigua qué rutas existen) y se aplique a todos los roles. `known.route` aporta el `access` del patrón.
  var known = route ? null : router.allowed(p);

  // Gestión de usuarios: solo administradores (también con un método no declarado).
  if (known && known.route.access === 'admin' && me.role !== 'admin') return sendJson(res, 403, { error: known.route.deniedMsg || 'Solo un administrador puede gestionar usuarios' });

  // Lectores: solo consulta (y diagnósticos de solo lectura). Rige para rutas desconocidas; en una ruta existente
  // sin ese método manda el 405 (no tiene sentido decir "solo lectura" de algo que nadie puede hacer).
  if (!known && (!route || route.access === 'standard') && write && me.role === 'viewer' && !readOnlyAllowed(p)) {
    return sendJson(res, 403, { error: 'Tu usuario es de solo lectura' });
  }

  if (known) return sendJson(res, 405, { error: 'Método no permitido' }, { 'Allow': known.methods.join(', ') });
  if (!route) return notFound(c);
  if (route.pre && await route.pre(c)) return;
  return route.handler(c);
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
  notifier.start(scheduler);
  console.log('Centinela ' + pkg.version + ' → http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log(AUTH_ON ? 'Acceso: inicio de sesión activado (' + auth.count() + ' usuario(s))' : 'AVISO: CENTINELA_AUTH=off, la API no pide inicio de sesión.');
  if (auth.seeded) {
    console.log('Usuario inicial creado: ' + auth.seeded.username + (auth.seeded.isDefault ? ' (deberá cambiar la contraseña al entrar)' : ''));
  }
  console.log('Datos en: ' + store.dir + '  |  ' + store.allTargets().length + ' objetivos en ' + store.getOrgs().length + ' organización(es)');
  if (!AUTH_ON && HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('AVISO: sin autenticación y abierto a la red; protégelo con un firewall.');
  if (!AUTH_ON && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1' && HOST !== '[::1]') console.log('AVISO: sin autenticación, cualquier equipo de la red puede configurar las alertas de Telegram');
});

function shutdown() {
  notifier.stop();
  scheduler.stop();
  Array.from(clients.keys()).forEach(dropClient);
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
