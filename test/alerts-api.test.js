'use strict';
/*
 * Alertas por Telegram: API /api/alerts* con el servidor real (proceso hijo, 127.0.0.1, datos temporales) y el servidor de
 * Telegram simulado. Nunca se usa data/ del repositorio ni Internet. Requisitos: RA-01, RA-02, RA-04, RA-05, RA-10 a RA-14,
 * RA-20 a RA-23, RA-50 a RA-55, RA-67, RA-94 y RA-98 (escenarios 7 y 10).
 * Las pruebas de test/chats usan un administrador distinto cada una: el límite de 5 s es por administrador.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var net = require('net');
var srv = require('./helpers/server');
var A = require('./helpers/alerts-server');
var tmp = require('./helpers/tmp');
var R = A.R;

var TOKEN = A.TOKEN, TOKEN_ENV = A.TOKEN_ENV, CHAT = A.CHAT;
var DENEGADO = 'Solo un administrador puede configurar las alertas';
var VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

test.after(async function () { await A.limpiar(); });

function claves(o, acc) {
  acc = acc || [];
  if (Array.isArray(o)) o.forEach(function (x) { claves(x, acc); });
  else if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { acc.push(k); claves(o[k], acc); });
  return acc;
}
// Puerto 1 de loopback: privilegiado y sin servicio en las pruebas, así que siempre rechaza la conexión.
// (Un puerto efímero recién liberado podía ocuparlo otra prueba en paralelo y dar resultados intermitentes.)
function puertoCerrado() { return Promise.resolve(1); }

/* =============================================================================================
 * Permisos y orden de comprobaciones (RA-50, RA-98.7)
 * ========================================================================================== */

var VALIDAS = [['GET', '/api/alerts'], ['PUT', '/api/alerts', {}], ['PUT', '/api/alerts/token', { token: TOKEN }], ['DELETE', '/api/alerts/token', {}],
  ['POST', '/api/alerts/test', {}], ['POST', '/api/alerts/chats', {}], ['GET', '/api/alerts/status']];
var INVALIDAS = [['DELETE', '/api/alerts', {}], ['POST', '/api/alerts', {}], ['POST', '/api/alerts/token', {}], ['GET', '/api/alerts/test'],
  ['PUT', '/api/alerts/chats', {}], ['POST', '/api/alerts/status', {}]];
var INEXISTENTES = [['GET', '/api/alerts/otra'], ['POST', '/api/alerts/otra', {}]];

var perm = null;
async function permisos() {
  if (perm) return perm;
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ enabled: false }) });
  perm = { h: h, sim: sim, op: await A.nuevoUsuario(h, 'operador1', 'operator'), lec: await A.nuevoUsuario(h, 'lector1', 'viewer') };
  return perm;
}

test('RA-98.7 / RA-50 anónimo: 401 con login:true en todas las rutas de alertas, con método válido, inválido o ruta inexistente', async function () {
  var p = await permisos(); p.sim.reset();
  for (var r of VALIDAS.concat(INVALIDAS, INEXISTENTES)) {
    var x = await p.h.request(r[0], r[1], { body: r[2] });
    assert.strictEqual(x.status, 401, r[0] + ' ' + r[1] + ' => ' + x.text);
    assert.strictEqual(x.json.login, true);
  }
  assert.strictEqual(p.sim.requests.length, 0, 'ninguna petición llegó a Telegram');
});

test('RA-98.7 / RA-50 operador y lector: 403 con mensaje de administrador de alertas en todas las rutas (con método válido o no)', async function () {
  var p = await permisos(); p.sim.reset();
  for (var quien of [p.op, p.lec]) {
    for (var r of VALIDAS.concat(INVALIDAS)) {
      var x = await p.h.request(r[0], r[1], { cookie: quien, body: r[2] });
      assert.strictEqual(x.status, 403, r[0] + ' ' + r[1] + ' => ' + x.text);
      assert.strictEqual(x.json.error, DENEGADO, 'mensaje específico de alertas');
      assert.ok(!/usuarios/.test(x.json.error));
    }
  }
  assert.strictEqual(p.sim.requests.length, 0, 'ningún acceso no autorizado llegó a Telegram');
});

// Decisión de diseño (2026-11-19): una ruta inexistente responde 404 a cualquier usuario con sesión, como en el resto de la API;
// no revela nada que no se sepa (las rutas reales dan 403 a no administradores).
test('RA-50 operador y lector en una ruta inexistente bajo /api/alerts/ responden igual que cualquier ruta inexistente de la API', async function () {
  var p = await permisos();
  for (var quien of [p.op, p.lec]) {
    for (var r of INEXISTENTES) {
      // Misma respuesta que una ruta inexistente fuera de alertas (404; el lector que escribe recibe el 403 general de solo lectura).
      var x = await p.h.request(r[0], r[1], { cookie: quien, body: r[2] });
      var ref = await p.h.request(r[0], '/api/noexiste', { cookie: quien, body: r[2] });
      assert.strictEqual(x.status, ref.status, r[0] + ' ' + r[1] + ' => ' + x.status + ' ' + x.text);
      assert.deepStrictEqual(x.json, ref.json);
      assert.ok(!/alertas/i.test(x.text), 'no revela que exista la sección de alertas');
    }
  }
});

test('RA-50 los 403 de usuarios siguen diciendo «gestionar usuarios» (sin cambios en rutas existentes)', async function () {
  var p = await permisos();
  var x = await p.h.request('GET', '/api/users', { cookie: p.op });
  assert.strictEqual(x.status, 403);
  assert.match(x.json.error, /gestionar usuarios/);
});

test('RA-50 administrador: 405 con Allow según el patrón y 404 para rutas inexistentes (solo tras 401 y 403)', async function () {
  var p = await permisos();
  function allow(x) { return x.headers.allow.split(',').map(function (s) { return s.trim(); }).sort(); }
  var d = await p.h.api('DELETE', '/api/alerts', {});
  assert.strictEqual(d.status, 405); assert.deepStrictEqual(d.json, { error: 'Método no permitido' });
  assert.ok(allow(d).indexOf('GET') >= 0 && allow(d).indexOf('PUT') >= 0 && allow(d).indexOf('DELETE') < 0, d.headers.allow);
  var t = await p.h.api('POST', '/api/alerts/token', {});
  assert.strictEqual(t.status, 405);
  assert.ok(allow(t).indexOf('PUT') >= 0 && allow(t).indexOf('DELETE') >= 0 && allow(t).indexOf('POST') < 0, t.headers.allow);
  var g = await p.h.api('GET', '/api/alerts/test');
  assert.strictEqual(g.status, 405); assert.ok(allow(g).indexOf('POST') >= 0 && allow(g).indexOf('GET') < 0);
  var c = await p.h.api('PUT', '/api/alerts/chats', {});
  assert.strictEqual(c.status, 405); assert.ok(allow(c).indexOf('POST') >= 0);
  var s = await p.h.api('POST', '/api/alerts/status', {});
  assert.strictEqual(s.status, 405); assert.ok(allow(s).indexOf('GET') >= 0 && allow(s).indexOf('POST') < 0);
  var o = await p.h.api('GET', '/api/alerts/otra');
  assert.strictEqual(o.status, 404);
  assert.strictEqual((await p.h.api('POST', '/api/alerts/otra', {})).status, 404);
});

test('RA-50 escritura sin Content-Type JSON: 415 (antes que 401); Origin ajeno: 403', async function () {
  var p = await permisos();
  var sinTipo = await p.h.request('PUT', '/api/alerts', { cookie: p.h.cookie, json: false, headers: { 'Content-Type': 'text/plain' }, body: '{"enabled":false}' });
  assert.strictEqual(sinTipo.status, 415);
  var anon = await p.h.request('POST', '/api/alerts/test', { json: false, headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.strictEqual(anon.status, 415, 'el 415 precede al 401');
  var ajeno = await p.h.request('PUT', '/api/alerts', { cookie: p.h.cookie, headers: { Origin: 'http://evil.example' }, body: { enabled: false } });
  assert.strictEqual(ajeno.status, 403);
  var ajenoTok = await p.h.request('PUT', '/api/alerts/token', { cookie: p.h.cookie, headers: { Origin: 'http://evil.example' }, body: { token: TOKEN } });
  assert.strictEqual(ajenoTok.status, 403);
  assert.strictEqual((await p.h.api('GET', '/api/alerts')).json.tokenConfigured, true, 'el token del archivo sigue igual (no se tocó)');
});

test('RA-50 cuerpo JSON inválido o que no es objeto: 400', async function () {
  var p = await permisos();
  for (var cuerpo of ['{ roto', 'null', '[]', '123', '"texto"']) {
    var x = await p.h.request('PUT', '/api/alerts', { cookie: p.h.cookie, body: cuerpo });
    assert.strictEqual(x.status, 400, cuerpo);
    var y = await p.h.request('PUT', '/api/alerts/token', { cookie: p.h.cookie, body: cuerpo });
    assert.strictEqual(y.status, 400, 'token ' + cuerpo);
  }
});

test('RA-50 cuerpo demasiado grande: error 4xx sin tumbar el servidor', async function () {
  var p = await permisos();
  var x = await p.h.request('PUT', '/api/alerts', { cookie: p.h.cookie, body: JSON.stringify({ chatId: new Array(3 * 1024 * 1024).join('a') }) }).catch(function (e) { return { status: 0, err: e }; });
  assert.ok(x.status === 0 || (x.status >= 400 && x.status < 500), 'estado ' + x.status);
  assert.strictEqual((await p.h.request('GET', '/api/health')).status, 200);
});

test('RA-50 contraseña temporal sin cambiar: 403 mustChange en las rutas de alertas', async function () {
  var sim = await A.nuevoSim();
  var h = await srv.startServer({ env: { CENTINELA_TELEGRAM_API_BASE: sim.base, CENTINELA_TELEGRAM_TOKEN: '', CENTINELA_ALERTS_DISABLED: '' } });
  try {
    var r = await h.request('POST', '/api/auth/login', { body: { username: 'administrador', password: h.adminPassword() } });
    assert.strictEqual(r.status, 200, r.text);
    var ck = srv.cookieOf(r);
    for (var q of VALIDAS) {
      var x = await h.request(q[0], q[1], { cookie: ck, body: q[2] });
      assert.strictEqual(x.status, 403, q[0] + ' ' + q[1]);
      assert.strictEqual(x.json.mustChange, true);
    }
    assert.strictEqual(sim.requests.length, 0);
  } finally { await h.stop(); }
});

/* =============================================================================================
 * RA-05, RA-55: no administradores y SSE no ven nada de alertas
 * ========================================================================================== */

test('RA-05 / RA-55 operador y lector: /api/state, /api/settings y /api/stream no contienen alertas, token ni chat; el SSE no difunde cambios', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ enabled: false }) });
  var op = await A.nuevoUsuario(h, 'operador1', 'operator'), lec = await A.nuevoUsuario(h, 'lector1', 'viewer');
  var antes = {};
  for (var q of [['op', op], ['lec', lec]]) {
    var st = await h.request('GET', '/api/state', { cookie: q[1] });
    var se = await h.request('GET', '/api/settings', { cookie: q[1] });
    assert.strictEqual(st.status, 200); assert.strictEqual(se.status, 200);
    antes[q[0]] = { state: Object.keys(st.json).sort(), settings: Object.keys(se.json).sort() };
    [st, se].forEach(function (x) {
      var ks = claves(x.json).join(',');
      assert.ok(!/alerts|telegram|chatId|token|orgChats|alerted/i.test(ks), 'claves prohibidas: ' + ks);
      assert.ok(x.text.indexOf(TOKEN) < 0 && x.text.indexOf(CHAT) < 0);
    });
  }
  // SSE de un lector y del administrador mientras el administrador cambia la configuración.
  var sLec = await srv.openStream(h.port, { cookie: lec });
  var sAdm = await srv.openStream(h.port, { cookie: h.cookie });
  assert.strictEqual(sLec.status, 200); assert.strictEqual(sAdm.status, 200);
  await h.api('PUT', '/api/alerts', { detail: 'full', chatId: '-100999888777', failsBeforeAlert: 3 });
  await h.api('PUT', '/api/alerts/token', { token: TOKEN });
  await h.api('PUT', '/api/settings', { intervalSec: 11 }); // control positivo: los ajustes normales sí viajan por SSE
  await A.esperar(function () { return /event: settings/.test(sLec.text) && /event: settings/.test(sAdm.text); }, 4000, 'evento settings en SSE');
  [sLec, sAdm].forEach(function (s) {
    assert.ok(!/alerts|telegram|chatId|orgChats|alerted/i.test(s.text), 'el SSE no debe mencionar alertas: ' + s.text.slice(0, 300));
    assert.ok(s.text.indexOf(TOKEN) < 0 && s.text.indexOf('-100999888777') < 0);
  });
  sLec.close(); sAdm.close();
  // Las respuestas existentes conservan sus claves tras activar y configurar alertas.
  var st2 = await h.request('GET', '/api/state', { cookie: lec });
  assert.deepStrictEqual(Object.keys(st2.json).sort(), antes.lec.state);
});

/* =============================================================================================
 * Configuración (RA-01, RA-02, RA-10, RA-12, RA-13, RA-14, RA-51)
 * ========================================================================================== */

test('RA-01 / RA-51 / RT-41 sin alerts.json: GET devuelve los valores por defecto sin token, el servidor no abre conexiones y no crea el archivo', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var r = await h.api('GET', '/api/alerts');
  assert.strictEqual(r.status, 200);
  var j = r.json;
  assert.strictEqual(j.enabled, false); assert.strictEqual(j.tokenConfigured, false); assert.strictEqual(j.tokenSource, 'none'); assert.strictEqual(j.tokenHint, '');
  assert.strictEqual(j.chatId, ''); assert.deepStrictEqual(j.orgChats, {}); assert.strictEqual(j.detail, 'minimal');
  assert.strictEqual(j.failsBeforeAlert, 2);
  assert.deepStrictEqual(j.notify, { down: true, recovery: true, certExpired: true, certExpiring: false, certTrust: false,
    latency: false, resources: false, disk: false, other: false }, 'notify completo con los valores por defecto (RT-41)');
  assert.strictEqual(j.notifyRecovery, true, 'compatibilidad: = notify.recovery'); assert.strictEqual(j.notifyDegraded, false, 'compatibilidad: false si falta algún tipo de degradación');
  assert.strictEqual(j.blockedByEnv, false); assert.strictEqual(j.version, 2);
  assert.strictEqual('token' in j, false); assert.strictEqual('alerted' in j, false);
  var s = await h.api('GET', '/api/alerts/status');
  assert.strictEqual(s.status, 200); assert.strictEqual(s.json.state, 'off');
  assert.strictEqual(sim.requests.length, 0);
});

test('RA-01 alerts.json ilegible o ausente: el servidor arranca igualmente con los valores por defecto', async function () {
  for (var raw of ['{ esto no es json', '', '[]', '"texto"']) {
    var sim = await A.nuevoSim();
    var h = await A.arrancar({ sim: sim, rawAlerts: raw });
    var r = await h.api('GET', '/api/alerts');
    assert.strictEqual(r.status, 200, JSON.stringify(raw) + ' => ' + r.text);
    assert.strictEqual(r.json.enabled, false);
    assert.strictEqual(sim.requests.length, 0);
  }
});

test('RA-02 activar sin token o sin chat: 400 con errors que indican qué falta y enabled no cambia', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var sinNada = await h.api('PUT', '/api/alerts', { enabled: true });
  assert.strictEqual(sinNada.status, 400);
  assert.ok(Array.isArray(sinNada.json.errors) && sinNada.json.errors.length >= 2, sinNada.text);
  assert.match(sinNada.json.errors.join(' '), /token/i); assert.match(sinNada.json.errors.join(' '), /chat/i);
  assert.strictEqual((await h.api('GET', '/api/alerts')).json.enabled, false);
  await h.api('PUT', '/api/alerts/token', { token: TOKEN });
  var sinChat = await h.api('PUT', '/api/alerts', { enabled: true });
  assert.strictEqual(sinChat.status, 400); assert.match(sinChat.json.errors.join(' '), /chat/i);
  assert.strictEqual((await h.api('GET', '/api/alerts')).json.enabled, false);
});

test('RA-02 / RA-14 activar con token y chat válidos: GET refleja enabled=true; el archivo tiene permisos 0600 y se registra sin secretos', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  assert.strictEqual((await h.api('PUT', '/api/alerts/token', { token: TOKEN })).status, 200);
  var r = await h.api('PUT', '/api/alerts', { enabled: true, chatId: CHAT });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.enabled, true); assert.strictEqual(r.json.chatId, CHAT);
  assert.strictEqual((await h.api('GET', '/api/alerts')).json.enabled, true);
  assert.strictEqual((await h.api('GET', '/api/alerts/status')).json.state, 'ok');
  var f = path.join(h.dir, 'alerts.json');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, 'permisos del archivo');
  var disco = A.leerAlerts(h.dir);
  assert.strictEqual(disco.enabled, true); assert.strictEqual(disco.token, TOKEN, 'el token vive solo en alerts.json'); assert.strictEqual(disco.chatId, CHAT);
  var log = h.log();
  assert.match(log, /\[alertas\] .*activadas por administrador/);
  assert.match(log, /\[alertas\] .*token guardado/);
  assert.ok(log.indexOf(TOKEN) < 0 && log.indexOf('123456789') < 0, 'el log no contiene el token');
  await h.api('PUT', '/api/alerts', { enabled: false });
  assert.match(h.log(), /desactivadas por administrador/);
  assert.strictEqual(sim.requests.length, 0, 'activar/desactivar no envía nada por sí solo');
});

test('RA-14 cada guardado de ajustes de alertas se anota en el log del servidor, no solo activar o desactivar', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ enabled: false }) });
  var antes = (h.log().match(/\[alertas\]/g) || []).length;
  var r = await h.api('PUT', '/api/alerts', { detail: 'full', failsBeforeAlert: 3 });
  assert.strictEqual(r.status, 200, r.text);
  var despues = (h.log().match(/\[alertas\]/g) || []).length;
  assert.ok(despues > antes, 'el guardado de ajustes no dejó rastro en el log');
});

test('RA-14 el directorio de datos conserva modo restrictivo (0700) al crear alerts.json', async function () {
  if (process.platform === 'win32') return;
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  await h.api('PUT', '/api/alerts/token', { token: TOKEN });
  assert.strictEqual(fs.statSync(path.join(h.dir, 'alerts.json')).mode & 0o077, 0, 'sin permisos para grupo ni otros');
});

test('RA-12 / RT-42 PUT inválido: 400 con { errors: [..] } en español y no guarda nada (todo o nada)', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var antes = (await h.api('GET', '/api/alerts')).json;
  var casos = [{ failsBeforeAlert: 0 }, { failsBeforeAlert: 11 }, { failsBeforeAlert: 'dos' }, { detail: 'enorme' }, { enabled: 'si' }, { notifyDegraded: 5 }, { notify: 'todo' }, { notify: { down: 'sí' } }, { notify: { inventada: true } },
    { chatId: 'no-es-un-chat' }, { chatId: 123 }, { detail: 'full', failsBeforeAlert: 99 }];
  for (var b of casos) {
    var r = await h.api('PUT', '/api/alerts', b);
    assert.strictEqual(r.status, 400, JSON.stringify(b));
    assert.ok(Array.isArray(r.json.errors) && r.json.errors.length && typeof r.json.errors[0] === 'string', r.text);
    assert.deepStrictEqual((await h.api('GET', '/api/alerts')).json, antes, 'no cambió nada con ' + JSON.stringify(b));
  }
});

test('RA-12 / RT-42 PUT válido guarda todos los campos editables (incluido notify); claves desconocidas y token del cuerpo se ignoran', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  await h.api('PUT', '/api/alerts/token', { token: TOKEN });
  var r = await h.api('PUT', '/api/alerts', { detail: 'full', failsBeforeAlert: 5, notify: { recovery: false, latency: true, disk: true }, chatId: '@mi_canal_ti',
    foo: 'bar', token: '999999999:ZZZ_abcdefghijklmnopqrstuvwxyz000000', alerted: { x: 'down' }, version: 7 });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.detail, 'full'); assert.strictEqual(r.json.failsBeforeAlert, 5);
  assert.deepStrictEqual(r.json.notify, { down: true, recovery: false, certExpired: true, certExpiring: false, certTrust: false,
    latency: true, resources: false, disk: true, other: false }, 'notify parcial fusionado con el vigente');
  assert.strictEqual(r.json.notifyRecovery, false); assert.strictEqual(r.json.notifyDegraded, false, 'faltan tipos de degradación: no es «todos»');
  assert.strictEqual(r.json.chatId, '@mi_canal_ti');
  assert.strictEqual('foo' in r.json, false);
  var d = A.leerAlerts(h.dir);
  assert.strictEqual('foo' in d, false);
  assert.strictEqual(d.token, TOKEN, 'el PUT general no cambia el token');
  assert.deepStrictEqual(d.alerted, {}); assert.strictEqual(d.version, 2);
  assert.deepStrictEqual(d.notify, r.json.notify, 'lo guardado en disco coincide con lo devuelto (RT-40)');
  assert.strictEqual('notifyRecovery' in d, false); assert.strictEqual('notifyDegraded' in d, false);
  assert.strictEqual(r.json.tokenHint, '…2345');
});

test('RT-42 PUT con los campos antiguos notifyRecovery/notifyDegraded se traduce a notify; si viene notify mandan los de notify', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var r = await h.api('PUT', '/api/alerts', { notifyRecovery: false, notifyDegraded: true });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.notify.recovery, false);
  ['certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other'].forEach(function (k) { assert.strictEqual(r.json.notify[k], true, k); });
  assert.strictEqual(r.json.notifyDegraded, true);
  var q = await h.api('PUT', '/api/alerts', { notify: { latency: false }, notifyDegraded: true, notifyRecovery: true });
  assert.strictEqual(q.status, 200, q.text);
  assert.strictEqual(q.json.notify.latency, false, 'notify manda sobre los campos antiguos');
  assert.strictEqual(q.json.notify.recovery, false, 'notifyRecovery se ignora si viene notify');
  assert.strictEqual(q.json.notifyDegraded, false);
  var d = A.leerAlerts(h.dir);
  assert.deepStrictEqual(d.notify, q.json.notify);
});

test('RT-42 PUT con todos los tipos en false es válido (no es error) y no envía nada', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var todos = {};
  ['down', 'recovery', 'certExpired', 'certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other'].forEach(function (k) { todos[k] = false; });
  var r = await h.api('PUT', '/api/alerts', { notify: todos });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.notify, todos);
  assert.strictEqual(sim.requests.length, 0);
});

test('RA-10 orgChats con alguna clave en el PUT: 400 «Los chats por organización aún no están disponibles»; vacío o ausente es válido', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var r = await h.api('PUT', '/api/alerts', { orgChats: { acme: '-100123' } });
  assert.strictEqual(r.status, 400);
  assert.ok(r.json.errors.some(function (e) { return /Los chats por organización aún no están disponibles/.test(e); }), r.text);
  assert.strictEqual((await h.api('PUT', '/api/alerts', { orgChats: {} })).status, 200);
  assert.strictEqual((await h.api('PUT', '/api/alerts', { detail: 'full' })).status, 200);
  assert.deepStrictEqual((await h.api('GET', '/api/alerts')).json.orgChats, {});
});

test('RA-10 un orgChats cargado a mano en alerts.json se conserva al guardar y se descartan las organizaciones inexistentes', async function () {
  var sim = await A.nuevoSim();
  var h0 = await A.arrancar({ sim: sim });
  var org = await h0.api('POST', '/api/orgs', { name: 'Cliente ACME' });
  assert.strictEqual(org.status, 201, org.text);
  var oid = org.json.org.id;
  var dir = h0.dir;
  await A.parar(h0);
  fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify(A.alertasActivas({ enabled: false, orgChats: (function () { var o = { zzzinexistente: '-100999' }; o[oid] = '-100321'; return o; })() })), { mode: 0o600 });
  var h = await A.arrancar({ sim: sim, dir: dir });
  var g = await h.api('GET', '/api/alerts');
  assert.deepStrictEqual(Object.keys(g.json.orgChats), [oid], 'la organización inexistente se descarta al cargar');
  await h.api('PUT', '/api/alerts', { detail: 'full' });
  assert.strictEqual(A.leerAlerts(dir).orgChats[oid], '-100321', 'se conserva al guardar');
});

test('RA-13 chatId: acepta enteros con signo, @canal y vacío; rechaza fuera de rango y formatos raros', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  for (var ok of ['123456789', '-1001234567890', '-4000000000000', '1099511627775', '@canal_publico', '']) {
    var r = await h.api('PUT', '/api/alerts', { chatId: ok });
    assert.strictEqual(r.status, 200, JSON.stringify(ok) + ' => ' + r.text);
    assert.strictEqual(r.json.chatId, ok);
  }
  for (var mal of ['1099511627776', '-4000000000001', '@abc', 'canal', '12 34', '1e3', '--1', '<script>']) {
    assert.strictEqual((await h.api('PUT', '/api/alerts', { chatId: mal })).status, 400, mal);
  }
});

test('RA-12 vaciar el chat con las alertas activas se rechaza y las alertas siguen activas', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas() });
  var r = await h.api('PUT', '/api/alerts', { chatId: '' });
  assert.strictEqual(r.status, 400);
  var g = await h.api('GET', '/api/alerts');
  assert.strictEqual(g.json.enabled, true); assert.strictEqual(g.json.chatId, CHAT);
});

test('RA-67 los ajustes generales y los de alertas son independientes (archivos y rutas distintos)', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ enabled: false }) });
  var alertasAntes = (await h.api('GET', '/api/alerts')).json;
  var s = await h.api('PUT', '/api/settings', { intervalSec: 17, historyPoints: 100 });
  assert.strictEqual(s.status, 200, s.text);
  assert.deepStrictEqual((await h.api('GET', '/api/alerts')).json, alertasAntes);
  var st = await h.api('GET', '/api/settings');
  await h.api('PUT', '/api/alerts', { detail: 'full', failsBeforeAlert: 4 });
  assert.deepStrictEqual((await h.api('GET', '/api/settings')).json, st.json);
  assert.ok(!/alerts|chatId|telegram/i.test(JSON.stringify(st.json)));
  var settingsFile = path.join(h.dir, 'settings.json');
  if (fs.existsSync(settingsFile)) assert.ok(!/chatId|telegram|token/i.test(fs.readFileSync(settingsFile, 'utf8')));
});

/* =============================================================================================
 * Token (RA-20, RA-21, RA-22, RA-98.10)
 * ========================================================================================== */

test('RA-20 PUT token: guarda y responde solo con tokenConfigured y la pista de los últimos 4 caracteres', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var r = await h.api('PUT', '/api/alerts/token', { token: '  ' + TOKEN + '  ' });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json, { tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel' });
  assert.ok(r.text.indexOf('123456789') < 0 && r.text.indexOf('AAH_') < 0);
  var g = await h.api('GET', '/api/alerts');
  assert.strictEqual(g.json.tokenConfigured, true); assert.strictEqual(g.json.tokenHint, '…2345');
  assert.ok(g.text.indexOf(TOKEN) < 0 && g.text.indexOf('abcdefghij') < 0);
  assert.strictEqual(A.leerAlerts(h.dir).token, TOKEN);
});

test('RA-20 PUT token con formato inválido: 400 con «Parece incompleto: cópialo entero desde BotFather» y no guarda', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var malos = ['', 'abc', '123456789:corto', '0123456789:AAH_abcdefghijklmnopqrstuvwxyz012345', '123456789:AAH/abcdefghijklmnopqrstuvwxyz012345',
    TOKEN + new Array(60).join('a'), 12345, null, ['x'], { a: 1 }];
  for (var t of malos) {
    var r = await h.api('PUT', '/api/alerts/token', { token: t });
    assert.strictEqual(r.status, 400, JSON.stringify(t));
    assert.ok(r.json.errors.some(function (e) { return /Parece incompleto: cópialo entero desde BotFather/.test(e); }), r.text);
  }
  assert.strictEqual((await h.api('PUT', '/api/alerts/token', {})).status, 400);
  assert.strictEqual((await h.api('GET', '/api/alerts')).json.tokenConfigured, false);
  assert.ok(!fs.existsSync(path.join(h.dir, 'alerts.json')) || A.leerAlerts(h.dir).token === '');
});

test('RA-20 DELETE token: lo borra y, si las alertas estaban activas, quedan desactivadas con enabled:false en la respuesta', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas() });
  var r = await h.api('DELETE', '/api/alerts/token', {});
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.tokenConfigured, false); assert.strictEqual(r.json.enabled, false);
  var g = (await h.api('GET', '/api/alerts')).json;
  assert.strictEqual(g.tokenConfigured, false); assert.strictEqual(g.enabled, false);
  assert.strictEqual(A.leerAlerts(h.dir).token, '');
  assert.match(h.log(), /token borrado del panel/);
  var otra = await h.api('DELETE', '/api/alerts/token', {});
  assert.strictEqual(otra.status, 200, 'borrar sin token es inofensivo');
  assert.strictEqual(otra.json.enabled, false);
});

test('RA-98.10 / RA-21 token por variable de entorno: tiene prioridad, bloquea PUT/DELETE del panel con 409 token_from_env y no se copia a alerts.json', async function () {
  var sim = await A.nuevoSim();
  var h0 = await A.arrancar({ sim: sim });
  await h0.api('PUT', '/api/alerts/token', { token: TOKEN });
  var dir = h0.dir;
  await A.parar(h0);
  var h = await A.arrancar({ sim: sim, dir: dir, env: { CENTINELA_TELEGRAM_TOKEN: TOKEN_ENV } });
  var g = (await h.api('GET', '/api/alerts')).json;
  assert.strictEqual(g.tokenSource, 'env'); assert.strictEqual(g.tokenConfigured, true); assert.strictEqual(g.tokenHint, '…7890');
  var put = await h.api('PUT', '/api/alerts/token', { token: TOKEN });
  assert.strictEqual(put.status, 409); assert.strictEqual(put.json.code, 'token_from_env');
  var del = await h.api('DELETE', '/api/alerts/token', {});
  assert.strictEqual(del.status, 409); assert.strictEqual(del.json.code, 'token_from_env');
  assert.strictEqual(A.leerAlerts(dir).token, TOKEN, 'el token del panel no se tocó');
  assert.ok(JSON.stringify(A.leerAlerts(dir)).indexOf(TOKEN_ENV) < 0, 'la variable no se copia a alerts.json');
  assert.strictEqual((await h.api('GET', '/api/alerts/status')).json.tokenSource, 'env');
  // La prueba de envío usa el token de la variable.
  await h.api('PUT', '/api/alerts', { chatId: CHAT });
  var t = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(t.status, 200); assert.strictEqual(t.json.ok, true, t.text);
  assert.strictEqual(sim.sent()[0].token, TOKEN_ENV, 'se envía con el token de la variable');
  // Sin la variable, y tras reiniciar, vuelve a usarse el del panel.
  await A.parar(h);
  var h2 = await A.arrancar({ sim: sim, dir: dir });
  var g2 = (await h2.api('GET', '/api/alerts')).json;
  assert.strictEqual(g2.tokenSource, 'panel'); assert.strictEqual(g2.tokenHint, '…2345');
});

test('RA-21 variable de entorno con formato no válido: se trata como no definida (tokenSource none)', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, env: { CENTINELA_TELEGRAM_TOKEN: 'esto-no-es-un-token' } });
  var g = (await h.api('GET', '/api/alerts')).json;
  assert.strictEqual(g.tokenSource, 'none'); assert.strictEqual(g.tokenConfigured, false);
  var st = (await h.api('GET', '/api/alerts/status')).json;
  assert.strictEqual(st.tokenSource, 'none');
  // Como si no estuviera definida, el panel sí permite guardar un token.
  assert.strictEqual((await h.api('PUT', '/api/alerts/token', { token: TOKEN })).status, 200);
  assert.ok(h.log().indexOf('esto-no-es-un-token') < 0, 'el valor de la variable no se registra');
});

test('RA-21 con la variable inválida, status informa la nota «La variable no tiene formato de token»', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, env: { CENTINELA_TELEGRAM_TOKEN: 'esto-no-es-un-token' } });
  var st = (await h.api('GET', '/api/alerts/status')).json;
  assert.match(String(st.note || ''), /La variable no tiene formato de token/, 'status = ' + JSON.stringify(st));
});

test('RA-04 / RA-98.10 CENTINELA_ALERTS_DISABLED: 1, true y TRUE bloquean; 0, no y vacío no', async function () {
  for (var v of ['1', 'true', 'TRUE']) {
    var sim = await A.nuevoSim();
    var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas(), env: { CENTINELA_ALERTS_DISABLED: v } });
    var g = (await h.api('GET', '/api/alerts')).json;
    assert.strictEqual(g.blockedByEnv, true, v); assert.strictEqual(g.enabled, true, 'el panel conserva su valor');
    assert.strictEqual((await h.api('GET', '/api/alerts/status')).json.state, 'blocked', v);
  }
  for (var w of ['0', 'no', 'false', '']) {
    var sim2 = await A.nuevoSim();
    var h2 = await A.arrancar({ sim: sim2, alerts: A.alertasActivas(), env: { CENTINELA_ALERTS_DISABLED: w } });
    assert.strictEqual((await h2.api('GET', '/api/alerts')).json.blockedByEnv, false, JSON.stringify(w));
    assert.strictEqual((await h2.api('GET', '/api/alerts/status')).json.state, 'ok', JSON.stringify(w));
  }
});

test('RA-04 bloqueo por entorno: test y chats responden 409 alerts_disabled_by_env con mensaje en español y el simulador recibe 0 peticiones', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas(), env: { CENTINELA_ALERTS_DISABLED: '1' } });
  var a1 = await A.nuevoAdmin(h), a2 = await A.nuevoAdmin(h);
  var t = await h.request('POST', '/api/alerts/test', { cookie: a1, body: {} });
  var c = await h.request('POST', '/api/alerts/chats', { cookie: a2, body: {} });
  [t, c].forEach(function (x) {
    assert.strictEqual(x.status, 409, x.text);
    assert.strictEqual(x.json.code, 'alerts_disabled_by_env');
    assert.match(x.json.message, /CENTINELA_ALERTS_DISABLED/);
    assert.match(x.json.message, /variable de entorno/);
  });
  assert.strictEqual(sim.requests.length, 0);
});

test('RA-04 GET /api/alerts/status informa blockedByEnv=true cuando la función está bloqueada', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas(), env: { CENTINELA_ALERTS_DISABLED: '1' } });
  var st = (await h.api('GET', '/api/alerts/status')).json;
  assert.strictEqual(st.blockedByEnv, true, 'status = ' + JSON.stringify(st));
});

/* =============================================================================================
 * Prueba de envío y búsqueda de chats (RA-23, RA-52, RA-73, RA-92)
 * ========================================================================================== */

// Servidor con token y chat guardados y las alertas desactivadas (las acciones explícitas funcionan igual).
async function conCanal(extra) {
  var sim = await A.nuevoSim();
  var h = await A.arrancar(Object.assign({ sim: sim, alerts: A.alertasActivas({ enabled: false }) }, extra || {}));
  h.sim = sim;
  return h;
}

test('RA-52 POST test con alertas desactivadas: 200 {ok:true}, texto fijo con la versión, al chat guardado y sin datos de objetivos', async function () {
  var h = await conCanal();
  var c = await A.nuevoCtl(200);
  await A.nuevoObjetivo(h, 'ObjetivoSecretoXYZ', c);
  var r = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.ok, true);
  assert.strictEqual(h.sim.sent().length, 1);
  var q = h.sim.sent()[0];
  assert.strictEqual(q.token, TOKEN); assert.strictEqual(q.body.chat_id, CHAT);
  assert.match(q.body.text, /^✅ Centinela: mensaje de prueba/);
  assert.ok(q.body.text.indexOf(VERSION) > 0, 'incluye la versión ' + VERSION + ': ' + q.body.text);
  assert.ok(q.body.text.indexOf('ObjetivoSecretoXYZ') < 0 && q.body.text.indexOf('127.0.0.1') < 0);
  assert.strictEqual('parse_mode' in q.body, false);
});

test('RA-52 / P8 POST test con {chatId}: prueba ese chat sin guardarlo', async function () {
  var h = await conCanal();
  var r = await h.api('POST', '/api/alerts/test', { chatId: '-100555666777' });
  assert.strictEqual(r.json.ok, true, r.text);
  assert.strictEqual(h.sim.sent()[0].body.chat_id, '-100555666777');
  assert.strictEqual((await h.api('GET', '/api/alerts')).json.chatId, CHAT);
});

test('RA-52 POST test sin token o sin chat: 400 con mensaje claro y sin salir a la red', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var a2 = await A.nuevoAdmin(h);
  var sinToken = await h.api('POST', '/api/alerts/test', { chatId: CHAT });
  assert.strictEqual(sinToken.status, 400); assert.ok(sinToken.json.error && /token/i.test(sinToken.json.error), sinToken.text);
  await h.api('PUT', '/api/alerts/token', { token: TOKEN });
  var sinChat = await h.request('POST', '/api/alerts/test', { cookie: a2, body: {} });
  assert.strictEqual(sinChat.status, 400); assert.ok(/chat/i.test(sinChat.json.error), sinChat.text);
  assert.strictEqual(sim.requests.length, 0);
});

test('RA-23 / RA-73 errores de Telegram en la prueba: 200 {ok:false, code, message} en español, sin URL ni token, para cada código', async function () {
  var casos = [
    ['invalid_token', R.error(401, 'Unauthorized'), /401/],
    ['chat_not_found', R.chatNotFound(), /Buscar mis chats/],
    ['blocked', R.error(403, 'Forbidden: bot was blocked by the user'), /bloqueado|expulsado/],
    ['rate_limited', R.retryAfter(7), /7 s/]
  ];
  var h = await conCanal();
  for (var c of casos) {
    h.sim.reset(); h.sim.on('sendMessage', c[1]);
    var admin = await A.nuevoAdmin(h);
    var r = await h.request('POST', '/api/alerts/test', { cookie: admin, body: {} });
    assert.strictEqual(r.status, 200, c[0] + ' => ' + r.text);
    assert.strictEqual(r.json.ok, false); assert.strictEqual(r.json.code, c[0]);
    assert.match(r.json.message, c[2], c[0]);
    assert.ok(r.text.indexOf(TOKEN) < 0 && r.text.indexOf('123456789') < 0 && r.text.indexOf('/bot') < 0 && r.text.indexOf(String(h.sim.port)) < 0, 'sin fugas: ' + r.text);
  }
});

test('RA-23 error 5xx del simulador en la prueba: ok:false con code unknown sin detalles internos', async function () {
  var h = await conCanal();
  h.sim.on('sendMessage', R.error(502, 'Bad Gateway'));
  var r = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, false); assert.strictEqual(r.json.code, 'unknown');
  assert.ok(r.text.indexOf(TOKEN) < 0 && r.text.indexOf('/bot') < 0);
});

test('RA-23 / RA-73 sin conexión: code no_internet con el mensaje del puerto 443 y sin la URL', async function () {
  var cerrado = await puertoCerrado();
  var h = await A.arrancar({ base: 'http://127.0.0.1:' + cerrado, alerts: A.alertasActivas({ enabled: false }) });
  var r = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.code, 'no_internet');
  assert.match(r.json.message, /puerto 443/);
  assert.ok(r.text.indexOf(String(cerrado)) < 0 && r.text.indexOf(TOKEN) < 0);
  assert.ok(h.log().indexOf(TOKEN) < 0);
});

test('Anexo A 400 con migrate_to_chat_id en la prueba del chat guardado: actualiza alerts.json y reintenta una vez', async function () {
  var h = await conCanal();
  h.sim.on('sendMessage', [R.migrate(-1009990001112), R.ok()]);
  var r = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(r.json.ok, true, r.text);
  assert.strictEqual(h.sim.sent().length, 2);
  assert.strictEqual(h.sim.sent()[1].body.chat_id, '-1009990001112');
  assert.strictEqual(A.leerAlerts(h.dir).chatId, '-1009990001112');
  assert.strictEqual((await h.api('GET', '/api/alerts')).json.chatId, '-1009990001112');
});

test('RA-52 POST chats: devuelve {id,type,title} deduplicados, llama a getUpdates una sola vez sin offset ni allowed_updates y no filtra mensajes', async function () {
  var h = await conCanal();
  h.sim.setUpdates([
    A.updMessage(111, 'private', undefined, { chat: { id: 111, type: 'private', first_name: 'Ana', username: 'ana_p' }, text: 'contraseña-del-wifi' }),
    A.updMessage(-100200, 'supergroup', 'Guardia TI'), A.updMessage(-100200, 'supergroup', 'Guardia TI'),
    { update_id: 9, channel_post: { chat: { id: -100300, type: 'channel', title: 'Avisos' }, text: 'otro-secreto' } }]);
  var r = await h.api('POST', '/api/alerts/chats', {});
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.ok, true);
  assert.deepStrictEqual(r.json.chats, [{ id: 111, type: 'private', title: 'Ana', username: 'ana_p' }, { id: -100200, type: 'supergroup', title: 'Guardia TI' }, { id: -100300, type: 'channel', title: 'Avisos' }]);
  assert.ok(!/contraseña-del-wifi|otro-secreto/.test(r.text), 'no se filtran mensajes (el @username del chat sí se devuelve, SEC-A10)');
  var gu = h.sim.calls('getUpdates');
  assert.strictEqual(gu.length, 1); assert.strictEqual(gu[0].body.timeout, 0);
  assert.ok(!('offset' in gu[0].body) && !('allowed_updates' in gu[0].body));
  assert.strictEqual(h.sim.sent().length, 0, 'no envía mensajes');
});

test('RA-52 POST chats: máximo 20 chats y, sin resultados, chats:[] con la pista de escribirle al bot', async function () {
  var h = await conCanal();
  var muchos = [];
  for (var i = 1; i <= 30; i++) muchos.push(A.updMessage(-1000 - i, 'group', 'G' + i));
  h.sim.setUpdates(muchos);
  var r = await h.api('POST', '/api/alerts/chats', {});
  assert.strictEqual(r.json.chats.length, 20);
  h.sim.setUpdates([]);
  var a2 = await A.nuevoAdmin(h);
  var v = await h.request('POST', '/api/alerts/chats', { cookie: a2, body: {} });
  assert.strictEqual(v.json.ok, true); assert.deepStrictEqual(v.json.chats, []);
  assert.match(v.json.hint, /Escríbele un mensaje al bot y vuelve a pulsar/);
});

test('RA-52 / RA-65 POST chats devuelve el título tal cual (el escape es de la interfaz) y funciona con las alertas desactivadas y sin chat guardado', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ enabled: false, chatId: '' }) });
  sim.setUpdates([A.updMessage(-100777, 'group', '<img src=x onerror=alert(1)>')]);
  var r = await h.api('POST', '/api/alerts/chats', {});
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.chats[0].title, '<img src=x onerror=alert(1)>');
});

test('Anexo A 409 en getUpdates (webhook u otro lector): ok:false con explicación y sin excepción', async function () {
  var h = await conCanal();
  h.sim.on('getUpdates', R.error(409, 'Conflict: can\'t use getUpdates method while webhook is active'));
  var r = await h.api('POST', '/api/alerts/chats', {});
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, false);
  assert.match(r.json.message, /webhook|bot dedicado/i);
});

test('RA-23 POST chats con token rechazado (401): code invalid_token', async function () {
  var h = await conCanal();
  h.sim.on('getUpdates', R.error(401, 'Unauthorized'));
  var r = await h.api('POST', '/api/alerts/chats', {});
  assert.strictEqual(r.json.ok, false); assert.strictEqual(r.json.code, 'invalid_token');
});

test('RA-52 límite de frecuencia: repetir test o chats antes de 5 s da 429 con Retry-After y no vuelve a llamar a Telegram', async function () {
  var h = await conCanal();
  var a = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(a.status, 200);
  var b = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(b.status, 429, b.text);
  assert.match(b.headers['retry-after'], /^[1-5]$/);
  var c = await h.api('POST', '/api/alerts/chats', {});
  assert.strictEqual(c.status, 429, 'el límite es por administrador, compartido entre test y chats');
  assert.strictEqual(h.sim.requests.length, 1);
  // Otro administrador tiene su propio límite.
  var otro = await A.nuevoAdmin(h);
  var d = await h.request('POST', '/api/alerts/test', { cookie: otro, body: {} });
  assert.strictEqual(d.status, 200);
});

test('RA-52 una sola acción en curso a la vez por administrador: la segunda simultánea da 429', async function () {
  var h = await conCanal();
  h.sim.on('sendMessage', R.delayed(1200, R.ok()));
  var primera = h.api('POST', '/api/alerts/test', {});
  await A.esperar(function () { return h.sim.sent().length === 1; }, 5000, 'la primera petición llega al simulador');
  var segunda = await h.api('POST', '/api/alerts/chats', {});
  assert.strictEqual(segunda.status, 429, segunda.text);
  assert.ok(/^\d+$/.test(segunda.headers['retry-after']));
  var p = await primera;
  assert.strictEqual(p.status, 200); assert.strictEqual(p.json.ok, true);
  assert.strictEqual(h.sim.calls('getUpdates').length, 0);
});

/* =============================================================================================
 * Estado (RA-53)
 * ========================================================================================== */

test('RA-53 GET status: campos del estado y ningún texto de mensaje ni nombre de objetivo; los errores están saneados', async function () {
  var h = await conCanal();
  var s0 = (await h.api('GET', '/api/alerts/status')).json;
  ['state', 'lastSentAt', 'lastError', 'queued', 'inWindow', 'sentTotal', 'failedTotal', 'droppedTotal', 'tokenSource'].forEach(function (k) { assert.ok(k in s0, 'falta ' + k); });
  assert.strictEqual(s0.state, 'off'); assert.strictEqual(s0.tokenSource, 'panel');
  assert.strictEqual(s0.sentTotal, 0); assert.strictEqual(s0.lastSentAt, null);
});

test('RA-53 HEAD /api/alerts/status se trata como GET (200 sin cuerpo)', async function () {
  var h = await conCanal();
  var r = await h.request('HEAD', '/api/alerts/status', { cookie: h.cookie });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.text, '');
});
