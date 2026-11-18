'use strict';
/*
 * R9 (ronda 1): API de integración, parte 2. Cada grupo arranca su propio servidor hijo en 127.0.0.1 (puerto efímero,
 * datos temporales). Cubre SSE (topes, expulsión del más antiguo, revocación), semáforo de hashes, bloqueo del cambio
 * de contraseña, cookie Secure, filtro de Host, PUT concurrente, plazo de /check, cupo de traceroute y forceChange.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var net = require('net');
var spawn = require('child_process').spawn;
var Defaults = require('../js/config/defaults.js');
var path = require('path');
var tmp = require('./helpers/tmp');
var srv = require('./helpers/server');

var ADMIN = 'administrador', ADMIN_PASS = 'clave-admin-segura-1';
var servidores = [];
var abiertos = [];     // flujos SSE abiertos por las pruebas (se cierran siempre al terminar)

async function arrancar(env, opts) {
  var h = await srv.startServer(Object.assign({ env: env || {} }, opts || {}));
  servidores.push(h);
  return h;
}
// Servidor con contraseña de administrador válida (sin cambio obligatorio) y objetivos vacíos.
function arrancarAdmin(extra) { return arrancar(Object.assign({ CENTINELA_ADMIN_PASSWORD: ADMIN_PASS }, extra || {})); }

test.after(async function () {
  abiertos.forEach(function (st) { st.close(); });
  for (var h of servidores) await h.stop();
});

async function entrar(h, user, pass, extra) {
  var r = await h.request('POST', '/api/auth/login', Object.assign({ body: { username: user, password: pass } }, extra || {}));
  return { res: r, cookie: srv.cookieOf(r) };
}
async function crearUsuario(h, cookie, nombre, rol, clave, extra) {
  var r = await h.request('POST', '/api/users', { cookie: cookie, body: Object.assign({ username: nombre, role: rol, password: clave }, extra || {}) });
  assert.strictEqual(r.status, 201, r.text);
  return r.json.user;
}
async function stream(h, cookie, extra) {
  var st = await srv.openStream(h.port, Object.assign({ cookie: cookie }, extra || {}));
  if (st.status === 200) abiertos.push(st);
  return st;
}
function pausa(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// Espera a que cond() sea verdadera (sondeo cada 25 ms) con plazo máximo; falla con el motivo si vence.
async function esperar(cond, ms, motivo) {
  var fin = Date.now() + (ms || 5000);
  while (Date.now() < fin) { if (await cond()) return; await pausa(25); }
  assert.fail('plazo agotado esperando: ' + (motivo || 'condición'));
}
// Servidor HTTP local que acepta conexiones y nunca responde (la sonda espera hasta su propio plazo).
async function servidorMudo() {
  var socks = new Set(), m = { conexiones: 0 };
  var http = require('http').createServer(function () { /* no responde */ });
  http.on('connection', function (s) { m.conexiones++; socks.add(s); s.on('close', function () { socks.delete(s); }); });
  await new Promise(function (r) { http.listen(0, '127.0.0.1', r); });
  m.port = http.address().port;
  m.cerrar = function () { socks.forEach(function (s) { s.destroy(); }); http.close(); };
  return m;
}

/* ---------- Arranque: contraseña inicial en el log ---------- */

test('R9: con CENTINELA_ADMIN_PASSWORD no se imprime ninguna contraseña inicial', async function () {
  var h = await arrancarAdmin();
  assert.ok(!/CONTRASEÑA INICIAL/.test(h.log()), h.log());
  assert.strictEqual(h.log().indexOf(ADMIN_PASS), -1, 'la contraseña de entorno no debe aparecer en el log');
  assert.strictEqual(h.adminPassword(), null);
  assert.doesNotMatch(h.log(), /deberá cambiar la contraseña/);
  var l = await entrar(h, ADMIN, ADMIN_PASS);
  assert.strictEqual(l.res.status, 200);
  assert.strictEqual(l.res.json.user.mustChange, false);
});

test('R9: con CENTINELA_ADMIN_PASSWORD débil (< 8) se pide cambiarla y no se genera otra', async function () {
  var h = await arrancar({ CENTINELA_ADMIN_PASSWORD: 'corta' });
  assert.strictEqual(h.adminPassword(), null);
  var l = await entrar(h, ADMIN, 'corta');
  assert.strictEqual(l.res.status, 200);
  assert.strictEqual(l.res.json.user.mustChange, true);
  assert.match(h.log(), /no cumple la política/);
});

test('R9: la contraseña generada se muestra una sola vez: al reiniciar con los mismos datos no se vuelve a imprimir', async function () {
  var dir = tmp.mkTmp('centinela-reinicio-');
  try {
    var h1 = await srv.startServer({ dir: dir });
    var pw = h1.adminPassword();
    assert.ok(pw);
    await h1.stop();
    var h2 = await srv.startServer({ dir: dir });
    try {
      assert.strictEqual(h2.adminPassword(), null);
      assert.ok(!/CONTRASEÑA INICIAL/.test(h2.log()));
      assert.strictEqual(h2.log().indexOf(pw), -1);
      assert.strictEqual((await entrar(h2, ADMIN, pw)).res.status, 200, 'la contraseña sigue siendo válida tras reiniciar');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'users.json'), 'utf8').indexOf(pw), -1, 'nunca se guarda en claro');
    } finally { await h2.stop(); }
  } finally { tmp.rmTmp(dir); }
});

/* ---------- /api/auth/me ---------- */

test('R9: /api/auth/me solo muestra el bloque server a administradores (no a operator ni viewer)', async function () {
  var h = await arrancarAdmin();
  var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var yo = await h.request('GET', '/api/auth/me', { cookie: adm });
  assert.ok(yo.json.server && yo.json.server.node === process.version);
  for (var rol of ['operator', 'viewer']) {
    await crearUsuario(h, adm, 'u-' + rol, rol, 'clave-' + rol + '-01');
    var ck = (await entrar(h, 'u-' + rol, 'clave-' + rol + '-01')).cookie;
    var m = await h.request('GET', '/api/auth/me', { cookie: ck });
    assert.strictEqual(m.status, 200);
    assert.strictEqual(m.json.user.role, rol);
    assert.strictEqual('server' in m.json, false, rol);
    assert.strictEqual(m.text.indexOf(process.version), -1);
    assert.strictEqual(m.text.indexOf(os.hostname()) >= 0 && os.hostname().length > 3, false, 'sin nombre del equipo');
  }
});

test('R9: con CENTINELA_AUTH=off /api/auth/me es administrador local y trae server', async function () {
  var h = await arrancar({ CENTINELA_AUTH: 'off' });
  var m = await h.request('GET', '/api/auth/me');
  assert.strictEqual(m.status, 200);
  assert.strictEqual(m.json.authEnabled, false);
  assert.ok(m.json.server);
});

/* ---------- Cookie Secure ---------- */

test('R9: CENTINELA_COOKIE_SECURE=1 añade Secure a la cookie (login y logout); sin la variable, no', async function () {
  var seg = await arrancarAdmin({ CENTINELA_COOKIE_SECURE: '1' });
  var l = await entrar(seg, ADMIN, ADMIN_PASS);
  var sc = l.res.headers['set-cookie'][0];
  assert.match(sc, /; Secure/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  var out = await seg.request('POST', '/api/auth/logout', { cookie: l.cookie, body: {} });
  assert.match(out.headers['set-cookie'][0], /; Secure/);
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  var normal = await arrancarAdmin();
  var l2 = await entrar(normal, ADMIN, ADMIN_PASS);
  assert.doesNotMatch(l2.res.headers['set-cookie'][0], /Secure/);
});

/* ---------- N-02: bloqueo en /api/auth/password ---------- */

test('R9 N-02: 5 contraseñas actuales erróneas => 400 x4, luego 429 y la cookie se borra; la sesión queda cerrada', async function () {
  var h = await arrancarAdmin();
  var ck = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  for (var i = 1; i <= 4; i++) {
    var r = await h.request('POST', '/api/auth/password', { cookie: ck, body: { current: 'incorrecta-' + i, next: 'clave-nueva-ok-1' } });
    assert.strictEqual(r.status, 400, 'intento ' + i);
    assert.strictEqual(r.headers['set-cookie'], undefined);
  }
  var q = await h.request('POST', '/api/auth/password', { cookie: ck, body: { current: 'incorrecta-5', next: 'clave-nueva-ok-1' } });
  assert.strictEqual(q.status, 429, q.text);
  assert.ok(Array.isArray(q.json.errors) && q.json.errors.length);
  var sc = q.headers['set-cookie'] && q.headers['set-cookie'][0];
  assert.ok(sc, 'debe limpiar la cookie');
  assert.match(sc, /centinela_sid=;/);
  assert.match(sc, /Max-Age=0/);
  assert.strictEqual((await h.request('GET', '/api/state', { cookie: ck })).status, 401, 'la sesión ya no es válida');
  // El bloqueo alcanza al login desde la misma IP aunque la clave sea correcta.
  assert.strictEqual((await entrar(h, ADMIN, ADMIN_PASS)).res.status, 429);
});

/* ---------- Semáforo de hashes ---------- */

test('R9: logins simultáneos por encima del semáforo (4) reciben 429 "Servidor ocupado"; los demás entran', async function () {
  var h = await arrancarAdmin();
  var res = await Promise.all(Array.from({ length: 12 }, function () { return entrar(h, ADMIN, ADMIN_PASS); }));
  var estados = res.map(function (x) { return x.res.status; });
  estados.forEach(function (e) { assert.ok(e === 200 || e === 429, 'estado inesperado ' + e); });
  assert.ok(estados.indexOf(200) >= 0, 'al menos uno entra: ' + estados);
  var ocupados = res.filter(function (x) { return x.res.status === 429; });
  assert.ok(ocupados.length >= 1, 'al menos uno recibe 429: ' + estados);
  ocupados.forEach(function (x) { assert.match(x.res.json.error, /ocupado/i); });
  // Pasada la ráfaga, el servicio se recupera.
  assert.strictEqual((await entrar(h, ADMIN, ADMIN_PASS)).res.status, 200);
});

/* ---------- forceChange vía API ---------- */

test('R9: POST /api/users con forceChange obliga a cambiar la contraseña al entrar (403 mustChange)', async function () {
  var h = await arrancarAdmin();
  var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var u = await crearUsuario(h, adm, 'forzado', 'viewer', 'clave-forzada-01', { forceChange: true });
  assert.strictEqual(u.mustChange, true);
  var l = await entrar(h, 'forzado', 'clave-forzada-01');
  assert.strictEqual(l.res.json.user.mustChange, true);
  var st = await h.request('GET', '/api/state', { cookie: l.cookie });
  assert.strictEqual(st.status, 403);
  assert.strictEqual(st.json.mustChange, true);
  // PUT con forceChange sobre un usuario normal.
  var n = await crearUsuario(h, adm, 'normal', 'viewer', 'clave-normal-01');
  assert.strictEqual(n.mustChange, false);
  var up = await h.request('PUT', '/api/users/' + n.id, { cookie: adm, body: { forceChange: true } });
  assert.strictEqual(up.status, 200, up.text);
  assert.strictEqual(up.json.user.mustChange, true);
});

/* ---------- Host malformado / no permitido ---------- */

test('R9: con filtro de Host activo, Host malformado => 400 y Host no permitido => 421', async function () {
  var h = await arrancar({ CENTINELA_AUTH: 'off' });
  function conHost(host) { return srv.rawHttp(h.port, 'GET /api/health HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n'); }
  for (var malo of ['a b', 'ho$t', 'a/b', 'host:abc', 'host:123456', '-', '[::1', 'a..b:', 'ex ample.com:80']) {
    var r = await conHost(malo);
    assert.strictEqual(r.status, 400, 'Host ' + JSON.stringify(malo) + ' => ' + r.status);
  }
  for (var ajeno of ['evil.example', 'evil.example:8080', '10.99.99.99', '[2001:db8::1]:80']) {
    var r2 = await conHost(ajeno);
    assert.strictEqual(r2.status, 421, 'Host ' + ajeno + ' => ' + r2.status);
  }
  for (var bueno of ['127.0.0.1:' + h.port, 'localhost:' + h.port, 'LOCALHOST', '[::1]:' + h.port]) {
    assert.strictEqual((await conHost(bueno)).status, 200, bueno);
  }
});

test('R9: con CENTINELA_ALLOWED_HOSTS: lista exacta (sin puerto), IPv6 con y sin corchetes y 400/421 distintos', async function () {
  var h = await arrancarAdmin({ CENTINELA_ALLOWED_HOSTS: 'centinela.lan, ::1' });
  function conHost(host) { return srv.rawHttp(h.port, 'GET /api/health HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n'); }
  assert.strictEqual((await conHost('centinela.lan')).status, 200);
  assert.strictEqual((await conHost('CENTINELA.LAN:9999')).status, 200, 'sin distinguir mayúsculas ni puerto');
  assert.strictEqual((await conHost('[::1]:' + h.port)).status, 200);
  assert.strictEqual((await conHost('otro.lan')).status, 421);
  // V-01: el loopback (127.0.0.1, localhost, [::1]) se acepta siempre, aunque la lista explícita no lo incluya.
  assert.strictEqual((await conHost('127.0.0.1:' + h.port)).status, 200, 'el loopback siempre se acepta');
  assert.strictEqual((await conHost('localhost:' + h.port)).status, 200);
  assert.strictEqual((await conHost('centinela lan')).status, 400);
  assert.strictEqual((await conHost('centinela.lan:99999999')).status, 400);
});

test('R9: con auth activa y sin CENTINELA_ALLOWED_HOSTS no se filtra el Host (comportamiento documentado)', async function () {
  var h = await arrancarAdmin();
  var r = await srv.rawHttp(h.port, 'GET /api/health HTTP/1.1\r\nHost: cualquier.cosa:1\r\nConnection: close\r\n\r\n');
  assert.strictEqual(r.status, 200);
});

/* ---------- PUT concurrente con borrado ---------- */

test('R9: PUT de un objetivo que se borra mientras llega el cuerpo => 404 (no 500)', async function () {
  var h = await arrancarAdmin();
  var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var c = await h.request('POST', '/api/targets', { cookie: adm, body: { name: 'efimero', kind: 'host', address: '10.0.0.7', enabled: false, checks: { ping: false } } });
  assert.strictEqual(c.status, 201, c.text);
  var id = c.json.target.id;
  var cuerpo = JSON.stringify({ name: 'renombrado', kind: 'host', address: '10.0.0.8', enabled: false, checks: { ping: false } });
  // Expect: 100-continue da la señal observable: el servidor responde "100 Continue" en cuanto despacha la petición y,
  // sin ninguna espera de E/S intermedia, queda leyendo el cuerpo. Al verla, el DELETE llega siempre después.
  var respuesta = await srv.rawHttp(h.port,
    'PUT /api/targets/' + id + ' HTTP/1.1\r\nHost: 127.0.0.1:' + h.port + '\r\nCookie: ' + adm + '\r\nContent-Type: application/json\r\n' +
    'Expect: 100-continue\r\nContent-Length: ' + Buffer.byteLength(cuerpo) + '\r\nConnection: close\r\n\r\n',
    { onOpen: function (sock) {
      var visto = '', lanzado = false;
      // Cabeceras enviadas; el cuerpo se retiene hasta ver el 100 Continue y que el objetivo se borre por otra conexión.
      sock.on('data', function (d) {
        visto += d;
        if (lanzado || visto.indexOf('100 Continue') < 0) return;
        lanzado = true;
        h.request('DELETE', '/api/targets/' + id, { cookie: adm, headers: { 'Content-Type': 'application/json' } })
          .then(function (d2) { assert.strictEqual(d2.status, 200, d2.text); sock.write(cuerpo); }); // el DELETE ya respondió: el borrado es efectivo
      });
    } });
  assert.strictEqual(respuesta.status, 404, respuesta.text);
  assert.ok(h.log().indexOf('[api]') < 0, 'no debe haber errores internos en el log:\n' + h.log());
  assert.strictEqual((await h.request('GET', '/api/targets', { cookie: adm })).json.targets.length, 0, 'el objetivo borrado no resucita');
});

/* ---------- /check con plazo global vencido ---------- */

test('R9: /check de un objetivo cuya verificación excede el plazo global => 200 con resultado DOWN (code timeout)', async function () {
  // Plazo mínimo permitido (5 s) y un servidor HTTP local que acepta y nunca responde (la sonda espera hasta 30 s).
  var mudo = await servidorMudo();
  try {
    var h = await arrancarAdmin({ CENTINELA_CHECK_TIMEOUT_MS: '5000' });
    var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
    var c = await h.request('POST', '/api/targets', { cookie: adm, body: { name: 'colgado', kind: 'url', address: 'http://127.0.0.1:' + mudo.port + '/',
      enabled: false, checks: { ping: false, http: { timeoutMs: 30000 } } } });
    assert.strictEqual(c.status, 201, c.text);
    var t0 = Date.now();
    var r = await h.request('POST', '/api/targets/' + c.json.target.id + '/check', { cookie: adm, body: {} });
    var dt = Date.now() - t0;
    assert.ok(dt >= 4500 && dt < 12000, 'el plazo vence a los ~5 s (' + dt + ' ms)');
    // Con el comportamiento nuevo el planificador RESUELVE con DOWN; no se llega al 504 (ver hallazgo en el reporte).
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.result.status, 'down');
    assert.ok(r.json.result.reasons.some(function (x) { return x.code === 'timeout'; }), r.text);
    // El id sigue "en curso" (la sonda real no terminó): una nueva petición recibe 409 y no lanza otra verificación.
    var r2 = await h.request('POST', '/api/targets/' + c.json.target.id + '/check', { cookie: adm, body: {} });
    assert.strictEqual(r2.status, 409, r2.text);
    assert.strictEqual(r2.json.error, 'Ya hay una verificación en curso para este objetivo');
  } finally { mudo.cerrar(); }
});

/* ---------- SSE ---------- */

test('R9 SSE: 6 flujos con la misma cookie => se cierra el más antiguo y los otros 5 siguen abiertos (sin 429)', async function () {
  var h = await arrancarAdmin();
  var ck = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var flujos = [];
  for (var i = 0; i < 6; i++) {
    var st = await stream(h, ck);
    assert.strictEqual(st.status, 200, 'flujo ' + (i + 1) + ' (nunca 429)');
    assert.match(st.headers['content-type'], /text\/event-stream/);
    flujos.push(st);
  }
  assert.strictEqual(await flujos[0].whenClosed(2000), true, 'el más antiguo se cerró');
  for (i = 1; i < 6; i++) assert.strictEqual(await flujos[i].whenClosed(150), false, 'el flujo ' + (i + 1) + ' sigue abierto');
  // Un séptimo expulsa al segundo, no al nuevo.
  var siete = await stream(h, ck);
  assert.strictEqual(siete.status, 200);
  assert.strictEqual(await flujos[1].whenClosed(2000), true);
  assert.strictEqual(await siete.whenClosed(150), false);
  assert.strictEqual(await flujos[2].whenClosed(150), false);
});

test('R9 SSE: el flujo en vivo entrega eventos (retry inicial y mensajes de difusión)', async function () {
  var h = await arrancarAdmin();
  var ck = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var st = await stream(h, ck);
  await esperar(function () { return /retry: 3000/.test(st.text); }, 5000, 'retry inicial del flujo');
  await h.request('POST', '/api/orgs', { cookie: ck, body: { name: 'Org SSE' } });
  await esperar(function () { return /Org SSE/.test(st.text); }, 5000, 'difusión de la organización nueva');
  assert.match(st.text, /retry: 3000/);
  assert.match(st.text, /event: orgs/);
  assert.match(st.text, /Org SSE/);
});

test('R9 SSE: tope de 15 flujos por usuario entre sesiones distintas; se cierra el más antiguo y otro usuario no se ve afectado', async function () {
  var h = await arrancarAdmin();
  var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  await crearUsuario(h, adm, 'otro-lector', 'viewer', 'clave-lector-01');
  var otro = (await entrar(h, 'otro-lector', 'clave-lector-01')).cookie;
  var ajeno = await stream(h, otro);
  var cookies = [adm];
  for (var k = 0; k < 3; k++) cookies.push((await entrar(h, ADMIN, ADMIN_PASS)).cookie);
  var flujos = [];
  // 4 cookies x 4 flujos = 16: ninguna supera 5 por clave, pero el usuario pasa de 15 al abrir el 16.º.
  for (var c = 0; c < 4; c++) for (var i = 0; i < 4; i++) {
    var st = await stream(h, cookies[c]);
    assert.strictEqual(st.status, 200);
    flujos.push(st);
  }
  assert.strictEqual(await flujos[0].whenClosed(2000), true, 'el flujo más antiguo del usuario se cerró');
  for (i = 1; i < flujos.length; i++) assert.strictEqual(flujos[i].closed(), false, 'flujo ' + (i + 1));
  assert.strictEqual(ajeno.closed(), false, 'el flujo de otro usuario no se toca');
});

test('R9 SSE: el logout, deshabilitar o eliminar al usuario y cambiarle la clave cortan sus flujos al instante', async function () {
  var h = await arrancarAdmin();
  var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  // Logout
  var l1 = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var s1 = await stream(h, l1), s1b = await stream(h, adm);
  assert.strictEqual(s1.status, 200);
  await h.request('POST', '/api/auth/logout', { cookie: l1, body: {} });
  assert.strictEqual(await s1.whenClosed(2000), true, 'el flujo de la sesión cerrada se corta');
  assert.strictEqual(await s1b.whenClosed(150), false, 'otra sesión del mismo usuario sigue');
  // Deshabilitar, cambiar clave y eliminar a un usuario.
  var u1 = await crearUsuario(h, adm, 'victima1', 'viewer', 'clave-victima-1');
  var u2 = await crearUsuario(h, adm, 'victima2', 'viewer', 'clave-victima-2');
  var u3 = await crearUsuario(h, adm, 'victima3', 'viewer', 'clave-victima-3');
  var f = [];
  for (var par of [['victima1', 'clave-victima-1'], ['victima2', 'clave-victima-2'], ['victima3', 'clave-victima-3']]) {
    f.push(await stream(h, (await entrar(h, par[0], par[1])).cookie));
  }
  assert.strictEqual((await h.request('PUT', '/api/users/' + u1.id, { cookie: adm, body: { disabled: true } })).status, 200);
  assert.strictEqual((await h.request('PUT', '/api/users/' + u2.id, { cookie: adm, body: { password: 'clave-victima-22' } })).status, 200);
  assert.strictEqual((await h.request('DELETE', '/api/users/' + u3.id, { cookie: adm, headers: { 'Content-Type': 'application/json' } })).status, 200);
  for (var i = 0; i < 3; i++) assert.strictEqual(await f[i].whenClosed(2000), true, 'flujo ' + (i + 1) + ' cortado');
  assert.strictEqual(s1b.closed(), false);
});

test('R9 SSE: un flujo con cookie inválida o sin sesión => 401 (no se abre)', async function () {
  var h = await arrancarAdmin();
  assert.strictEqual((await srv.openStream(h.port, {})).status, 401);
  assert.strictEqual((await srv.openStream(h.port, { cookie: 'centinela_sid=falsa' })).status, 401);
});

test('R9 SSE: el tope global de 200 flujos => el 201.º recibe 429 y los abiertos no se tocan', async function () {
  var h = await arrancarAdmin();
  var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var total = 0, primero = null, usuarios = 0;
  // 14 usuarios x 15 flujos (3 cookies x 5) y 1 más de 5: llegan a 200 sin pasar los topes por clave ni por usuario.
  while (total < 200) {
    var nombre = 'masivo' + (usuarios++);
    await crearUsuario(h, adm, nombre, 'viewer', 'clave-masiva-01');
    for (var c = 0; c < 3 && total < 200; c++) {
      var ck = (await entrar(h, nombre, 'clave-masiva-01')).cookie;
      for (var i = 0; i < 5 && total < 200; i++) {
        var st = await stream(h, ck);
        assert.strictEqual(st.status, 200, 'flujo ' + (total + 1));
        if (!primero) primero = st;
        total++;
      }
    }
  }
  var extra = await crearUsuario(h, adm, 'extra-global', 'viewer', 'clave-masiva-01');
  var rechazado = await srv.openStream(h.port, { cookie: (await entrar(h, 'extra-global', 'clave-masiva-01')).cookie });
  assert.strictEqual(rechazado.status, 429, 'status ' + rechazado.status);
  assert.match(rechazado.json.error, /flujos/);
  assert.strictEqual(primero.closed(), false, 'el global no expulsa a nadie');
  assert.ok(extra.id);
});

test('R9 SSE (auth off): flujos de IP distintas no se pisan; 6 desde la misma IP cierran el más antiguo', async function (t) {
  var h = await arrancar({ CENTINELA_AUTH: 'off' });
  // Se necesita una segunda dirección de loopback (127.0.0.2). En Linux es automática; en macOS no existe: se omite.
  var seg;
  try { seg = await srv.openStream(h.port, { localAddress: '127.0.0.2' }); }
  catch (e) { return t.skip('no se puede originar tráfico desde 127.0.0.2 (' + e.code + '); la independencia por IP no es verificable aquí'); }
  abiertos.push(seg);
  var deB = [seg];
  for (var i = 0; i < 4; i++) deB.push(await stream(h, null, { localAddress: '127.0.0.2' }));
  var deA = [];
  for (i = 0; i < 6; i++) {
    var st = await stream(h, null);
    assert.strictEqual(st.status, 200, 'IP A flujo ' + (i + 1));
    deA.push(st);
  }
  assert.strictEqual(await deA[0].whenClosed(2000), true, 'el más antiguo de la IP A se cerró');
  for (i = 1; i < 6; i++) assert.strictEqual(deA[i].closed(), false);
  deB.forEach(function (x, k) { assert.strictEqual(x.closed(), false, 'IP B flujo ' + (k + 1) + ' intacto'); });
  // Y la IP B, al pasarse del tope, solo expulsa los suyos.
  var b6 = await stream(h, null, { localAddress: '127.0.0.2' });
  assert.strictEqual(b6.status, 200);
  assert.strictEqual(await deB[0].whenClosed(2000), true);
  deA.slice(1).forEach(function (x) { assert.strictEqual(x.closed(), false); });
});

/* ---------- Traceroute: cupo por IP con auth off ---------- */

// ¿Se puede originar una conexión desde esa dirección de loopback? (Linux sí; macOS solo 127.0.0.1)
function puedeOriginar(ip) {
  return new Promise(function (resolve) {
    var net = require('net');
    var srvNet = net.createServer(function (c) { c.destroy(); });
    srvNet.listen(0, '127.0.0.1', function () {
      var c = net.connect({ host: '127.0.0.1', port: srvNet.address().port, localAddress: ip });
      c.on('connect', function () { c.destroy(); srvNet.close(); resolve(true); });
      c.on('error', function () { srvNet.close(); resolve(false); });
    });
  });
}

// Crea un directorio con un "traceroute" falso que tarda 30 s (sin red, sin comandos reales).
function trazaFalsa() {
  var dir = tmp.mkTmp('centinela-fakebin-');
  var f = path.join(dir, 'traceroute');
  // Cada ejecución deja una marca en 'marcas' para poder esperar a que el servidor ya la haya lanzado.
  fs.writeFileSync(f, '#!/bin/sh\necho x >> "' + path.join(dir, 'marcas') + '"\nexec sleep 30\n', { mode: 0o755 });
  return dir;
}

test('R9: traceroute con auth off: un segundo traceroute de la MISMA IP => 429; otra IP puede; global de 3 en curso', async function (t) {
  if (process.platform === 'win32') return t.skip('el traceroute simulado usa un script de shell');
  var bin = trazaFalsa();
  try {
    var h = await arrancar({ CENTINELA_AUTH: 'off', PATH: bin + path.delimiter + process.env.PATH });
    var pendientes = [];
    function lanzar(localAddress) {
      // La petición queda en curso (el traceroute simulado dura 30 s); se aborta al terminar la prueba.
      var p = h.request('POST', '/api/traceroute', { body: { address: '192.0.2.1' }, localAddress: localAddress });
      p.catch(function () { /* se cancela con el servidor */ });
      pendientes.push(p);
    }
    function lanzados() { try { return fs.readFileSync(path.join(bin, 'marcas'), 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } }
    lanzar(undefined);
    await esperar(function () { return lanzados() >= 1; }, 8000, 'primer traceroute simulado en ejecución');
    var dup = await h.request('POST', '/api/traceroute', { body: { address: '192.0.2.2' } });
    assert.strictEqual(dup.status, 429, dup.text);
    assert.match(dup.json.error, /en curso/);
    // Otras IP tienen su propio cupo (hasta el global de 3), si el sistema permite originar tráfico desde ellas.
    if (!(await puedeOriginar('127.0.0.2')) || !(await puedeOriginar('127.0.0.3')) || !(await puedeOriginar('127.0.0.4'))) {
      return t.diagnostic('no hay direcciones de loopback adicionales: no se verificó el cupo de otra IP ni el tope global de 3');
    }
    lanzar('127.0.0.2'); lanzar('127.0.0.3');
    await esperar(function () { return lanzados() >= 3; }, 8000, 'tres traceroute simulados en ejecución');
    // Hay 3 en curso (127.0.0.1, .2 y .3): una cuarta IP topa con el límite global.
    var cuarta = await h.request('POST', '/api/traceroute', { body: { address: '192.0.2.3' }, localAddress: '127.0.0.4' });
    assert.strictEqual(cuarta.status, 429, cuarta.text);
    assert.match(cuarta.json.error, /demasiados traceroute/);
    // Y la IP .2 sigue con su propio cupo ocupado (no es un 200 ni un 400).
    var dosDup = await h.request('POST', '/api/traceroute', { body: { address: '192.0.2.4' }, localAddress: '127.0.0.2' });
    assert.strictEqual(dosDup.status, 429);
    assert.match(dosDup.json.error, /en curso/);
  } finally { tmp.rmTmp(bin); }
});

/* ---------- Ronda 2: SSE evicted ---------- */

test('R9 SSE (QA-1): el flujo expulsado por tope recibe "event: evicted" {"reason":"tope"} antes del cierre; los demás no', async function () {
  var h = await arrancarAdmin();
  var ck = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var flujos = [];
  for (var i = 0; i < 6; i++) flujos.push(await stream(h, ck));
  assert.strictEqual(await flujos[0].whenClosed(2000), true, 'el más antiguo se cerró');
  var m = /event: evicted\ndata: (\{[^\n]*\})\n\n/.exec(flujos[0].text);
  assert.ok(m, 'el expulsado debe recibir el evento: ' + JSON.stringify(flujos[0].text));
  assert.deepStrictEqual(JSON.parse(m[1]), { reason: 'tope' });
  assert.ok(flujos[0].text.indexOf('retry: 3000') < flujos[0].text.indexOf('event: evicted'), 'evicted llega tras el retry inicial');
  for (i = 1; i < 6; i++) {
    assert.strictEqual(flujos[i].closed(), false, 'flujo ' + (i + 1) + ' abierto');
    assert.doesNotMatch(flujos[i].text, /evicted/, 'flujo ' + (i + 1) + ' no debe recibir evicted');
  }
});

test('R9 SSE (QA-1): logout y revocación NO envían "evicted" (solo el tope)', async function () {
  var h = await arrancarAdmin();
  var l = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var st = await stream(h, l);
  await h.request('POST', '/api/auth/logout', { cookie: l, body: {} });
  assert.strictEqual(await st.whenClosed(2000), true);
  assert.doesNotMatch(st.text, /evicted/);
});

/* ---------- Ronda 2: V-01 filtro de Host con lista explícita ---------- */

test('R9 V-01: con CENTINELA_ALLOWED_HOSTS=192.0.2.1 el loopback se acepta siempre; el host listado, también; evil.com => 421; malformado => 400', async function () {
  var h = await arrancarAdmin({ CENTINELA_ALLOWED_HOSTS: '192.0.2.1' });
  function conHost(host) { return srv.rawHttp(h.port, 'GET /api/health HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n'); }
  for (var ok of ['127.0.0.1', '127.0.0.1:' + h.port, 'localhost:' + h.port, '[::1]:' + h.port, '192.0.2.1', '192.0.2.1:' + h.port]) {
    assert.strictEqual((await conHost(ok)).status, 200, 'Host ' + ok);
  }
  for (var ajeno of ['evil.com', 'evil.com:' + h.port, '192.0.2.2']) assert.strictEqual((await conHost(ajeno)).status, 421, 'Host ' + ajeno);
  for (var malo of ['a b', 'ho$t', '[::1', 'host:abc']) assert.strictEqual((await conHost(malo)).status, 400, 'Host ' + JSON.stringify(malo));
});

/* ---------- Ronda 2: V-02 / V-04 contraseña inicial ---------- */

// Cuenta las apariciones de la línea "Contraseña: <valor>" en el log.
function aparicionesClave(log) { return (log.match(/Contraseña:\s+\S+/g) || []).length; }

test('R9 V-02: si el puerto está ocupado (EADDRINUSE) la contraseña aleatoria se imprime exactamente una vez y el proceso termina', async function () {
  var dir = tmp.mkTmp('centinela-busy-');
  var ocupante = net.createServer();
  var child = null;
  try {
    fs.writeFileSync(path.join(dir, 'targets.json'), '[]');
    await new Promise(function (r) { ocupante.listen(0, '127.0.0.1', r); });
    var puerto = ocupante.address().port;
    var env = Object.assign({}, process.env, { CENTINELA_DATA: dir, PORT: String(puerto), HOST: '127.0.0.1' });
    ['CENTINELA_ADMIN_USER', 'CENTINELA_ADMIN_PASSWORD', 'CENTINELA_AUTH', 'CENTINELA_ALLOWED_HOSTS'].forEach(function (k) { delete env[k]; });
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    var log = '';
    child.stdout.on('data', function (d) { log += d; });
    child.stderr.on('data', function (d) { log += d; });
    var codigo = await new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('el servidor no terminó con el puerto ocupado. Salida:\n' + log)); }, 10000);
      child.once('exit', function (c) { clearTimeout(t); resolve(c); });
    });
    assert.notStrictEqual(codigo, 0, 'debe terminar con error');
    assert.match(log, /EADDRINUSE/);
    assert.strictEqual(aparicionesClave(log), 1, 'la contraseña debe verse una sola vez aunque listen falle:\n' + log);
    assert.match(log, /CONTRASEÑA INICIAL/);
  } finally {
    if (child && child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    ocupante.close();
    tmp.rmTmp(dir);
  }
});

test('R9 V-02/V-04: con arranque normal la contraseña aparece una vez en el log y no se filtra por la API', async function () {
  var h = await srv.startServer();
  servidores.push(h);
  var pw = h.adminPassword();
  assert.ok(pw, 'se generó una contraseña');
  assert.strictEqual(aparicionesClave(h.log()), 1);
  assert.strictEqual(h.log().split(pw).length - 1, 1, 'el valor de la contraseña aparece una sola vez en toda la salida');
  var l = await entrar(h, ADMIN, pw);
  assert.strictEqual(l.res.status, 200);
  var me = await h.request('GET', '/api/auth/me', { cookie: l.cookie });
  assert.strictEqual(me.text.indexOf(pw), -1);
});

/* ---------- Ronda 2: QA-3 / QA-4 forceChange ---------- */

test('R9 QA-3: un admin que cambia su propia contraseña con forceChange:true conserva su sesión y no queda con mustChange', async function () {
  var h = await arrancarAdmin();
  var l = await entrar(h, ADMIN, ADMIN_PASS);
  var adm = l.cookie;
  var yo = l.res.json.user;
  var otra = (await entrar(h, ADMIN, ADMIN_PASS)).cookie; // segunda sesión del mismo usuario
  var up = await h.request('PUT', '/api/users/' + yo.id, { cookie: adm, body: { password: 'clave-admin-nueva-2', forceChange: true } });
  assert.strictEqual(up.status, 200, up.text);
  assert.strictEqual(up.json.user.mustChange, false, 'no se bloquea a sí mismo');
  assert.strictEqual((await h.request('GET', '/api/state', { cookie: adm })).status, 200, 'la sesión actual sigue válida y sin bloqueo');
  assert.strictEqual((await h.request('GET', '/api/auth/me', { cookie: adm })).json.user.mustChange, false);
  assert.strictEqual((await h.request('GET', '/api/state', { cookie: otra })).status, 401, 'las demás sesiones sí se cierran al cambiar la clave');
  var re = await entrar(h, ADMIN, 'clave-admin-nueva-2');
  assert.strictEqual(re.res.status, 200);
  assert.strictEqual(re.res.json.user.mustChange, false);
});

test('R9 QA-3: un admin con forceChange:true sin contraseña sobre sí mismo tampoco se bloquea', async function () {
  var h = await arrancarAdmin();
  var l = await entrar(h, ADMIN, ADMIN_PASS);
  var up = await h.request('PUT', '/api/users/' + l.res.json.user.id, { cookie: l.cookie, body: { forceChange: true } });
  assert.strictEqual(up.status, 200, up.text);
  assert.strictEqual(up.json.user.mustChange, false);
  assert.strictEqual((await h.request('GET', '/api/state', { cookie: l.cookie })).status, 200);
});

test('R9 QA-4: forceChange sin contraseña a otro usuario corta sus flujos SSE, su siguiente petición da 403 mustChange y sus sesiones siguen', async function () {
  var h = await arrancarAdmin();
  var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var u = await crearUsuario(h, adm, 'objetivo-fc', 'viewer', 'clave-objetivo-01');
  var ck = (await entrar(h, 'objetivo-fc', 'clave-objetivo-01')).cookie;
  var ck2 = (await entrar(h, 'objetivo-fc', 'clave-objetivo-01')).cookie;
  var f1 = await stream(h, ck), f2 = await stream(h, ck2);
  var propio = await stream(h, adm);
  assert.strictEqual((await h.request('GET', '/api/state', { cookie: ck })).status, 200);
  var up = await h.request('PUT', '/api/users/' + u.id, { cookie: adm, body: { forceChange: true } });
  assert.strictEqual(up.status, 200, up.text);
  assert.strictEqual(up.json.user.mustChange, true);
  assert.strictEqual(await f1.whenClosed(2000), true, 'flujo 1 cortado');
  assert.strictEqual(await f2.whenClosed(2000), true, 'flujo 2 cortado');
  assert.strictEqual(propio.closed(), false, 'el flujo del admin no se toca');
  for (var c of [ck, ck2]) {
    var st = await h.request('GET', '/api/state', { cookie: c });
    assert.strictEqual(st.status, 403, st.text);
    assert.strictEqual(st.json.mustChange, true);
    var me = await h.request('GET', '/api/auth/me', { cookie: c });
    assert.strictEqual(me.status, 200, 'la sesión sigue existiendo');
    assert.strictEqual(me.json.user.mustChange, true);
  }
  // Y un flujo nuevo tampoco se permite mientras deba cambiar la clave.
  assert.strictEqual((await srv.openStream(h.port, { cookie: ck })).status, 403);
});

/* ---------- Ronda 2: QA-6 settings.json con avisos en 0 ---------- */

test('R9 QA-6: settings.json con avisos en 0 se reescribe saneado al cargar el store', async function () {
  var dir = tmp.mkTmp('centinela-settings-');
  try {
    fs.writeFileSync(path.join(dir, 'targets.json'), '[]');
    var d = JSON.parse(JSON.stringify(Defaults.SETTINGS));
    var roto = JSON.parse(JSON.stringify(d));
    roto.thresholds.latencyWarnMs = 0;
    roto.thresholds.cpuWarnPct = 0;
    roto.thresholds.diskWarnPct = -3;
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(roto));
    var h = await srv.startServer({ dir: dir, env: { CENTINELA_ADMIN_PASSWORD: ADMIN_PASS } });
    try {
      var guardado = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      assert.strictEqual(guardado.thresholds.latencyWarnMs, d.thresholds.latencyWarnMs);
      assert.strictEqual(guardado.thresholds.cpuWarnPct, d.thresholds.cpuWarnPct);
      assert.strictEqual(guardado.thresholds.diskWarnPct, d.thresholds.diskWarnPct);
      var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
      var api = (await h.request('GET', '/api/settings', { cookie: adm })).json;
      assert.strictEqual(api.thresholds.latencyWarnMs, d.thresholds.latencyWarnMs, 'la API ya sirve el valor saneado');
    } finally { await h.stop(); }
  } finally { tmp.rmTmp(dir); }
});

/* ---------- Ronda 2: QA-7 /check concurrente ---------- */

test('R9 QA-7: una segunda POST /check con la verificación en curso => 409 y no lanza otra sonda', async function () {
  var mudo = await servidorMudo();
  try {
    var h = await arrancarAdmin({ CENTINELA_CHECK_TIMEOUT_MS: '5000' });
    var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
    var c = await h.request('POST', '/api/targets', { cookie: adm, body: { name: 'lento', kind: 'url', address: 'http://127.0.0.1:' + mudo.port + '/',
      enabled: false, checks: { ping: false, http: { timeoutMs: 30000 } } } });
    assert.strictEqual(c.status, 201, c.text);
    var ruta = '/api/targets/' + c.json.target.id + '/check';
    var primera = h.request('POST', ruta, { cookie: adm, body: {} });
    await esperar(function () { return mudo.conexiones >= 1; }, 8000, 'la sonda conectó con el servidor mudo');
    var segunda = await h.request('POST', ruta, { cookie: adm, body: {} });
    assert.strictEqual(segunda.status, 409, segunda.text);
    assert.strictEqual(segunda.json.error, 'Ya hay una verificación en curso para este objetivo');
    assert.strictEqual(mudo.conexiones, 1, 'no se lanzó una segunda sonda');
    var r1 = await primera;
    assert.strictEqual(r1.status, 200, r1.text);
  } finally { mudo.cerrar(); }
});

/* ---------- Ronda 2: QA-9 disabled no booleano ---------- */

test('R9 QA-9: PUT /api/users/:id con disabled:"false" => 400; con disabled:false => 200', async function () {
  var h = await arrancarAdmin();
  var adm = (await entrar(h, ADMIN, ADMIN_PASS)).cookie;
  var u = await crearUsuario(h, adm, 'lector-qa9', 'viewer', 'clave-lector-09');
  var mal = await h.request('PUT', '/api/users/' + u.id, { cookie: adm, body: { disabled: 'false' } });
  assert.strictEqual(mal.status, 400, mal.text);
  assert.ok(mal.json.errors.indexOf('Valor no válido para deshabilitado.') >= 0, mal.text);
  for (var v of ['true', 1, 0, {}]) {
    assert.strictEqual((await h.request('PUT', '/api/users/' + u.id, { cookie: adm, body: { disabled: v } })).status, 400, JSON.stringify(v));
  }
  var lista = (await h.request('GET', '/api/users', { cookie: adm })).json.users;
  assert.strictEqual(lista.filter(function (x) { return x.id === u.id; })[0].disabled, false, 'el rechazo no cambia nada');
  var bien = await h.request('PUT', '/api/users/' + u.id, { cookie: adm, body: { disabled: false } });
  assert.strictEqual(bien.status, 200, bien.text);
  assert.strictEqual(bien.json.user.disabled, false);
});

/* ---------- Fase 3 TLS: el token del agente queda atado a la huella (también vía importación PUT /api/targets) ---------- */

test('Fase 3 TLS: importar (PUT /api/targets) conserva el token si la huella solo cambia de mayúsculas o ":" y lo descarta si cambia o se quita', async function () {
  var h = await arrancarAdmin();
  var r = await entrar(h, ADMIN, ADMIN_PASS);
  var cookie = r.cookie;
  var HUELLA = Array(32).fill('AB').join(':'), OTRA = Array(32).fill('CD').join(':');
  function cuerpo(id, agente) {
    return { id: id, name: 'agente', kind: 'host', address: '192.0.2.10', enabled: false,
             checks: { ping: false, agent: Object.assign({ enabled: true, port: 9100, services: [] }, agente) } };
  }
  async function crear() {
    var c = await h.request('POST', '/api/targets', { cookie: cookie, body: cuerpo(undefined, { token: 'SECRETO-TLS', tls: true, fingerprint: HUELLA }) });
    assert.strictEqual(c.status, 201, c.text);
    assert.strictEqual(c.json.target.checks.agent.hasToken, true);
    return c.json.target.id;
  }
  async function importar(id, agente) {
    return h.request('PUT', '/api/targets', { cookie: cookie, body: { targets: [cuerpo(id, agente)] } });
  }
  // Solo mayúsculas/minúsculas y separadores: el token se conserva.
  var id1 = await crear();
  var a = await importar(id1, { tls: true, fingerprint: HUELLA.replace(/:/g, '').toLowerCase() });
  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual(a.json.targets[0].checks.agent.hasToken, true, 'misma huella normalizada => se hereda');
  assert.strictEqual(a.json.targets[0].checks.agent.fingerprint, HUELLA);
  assert.ok(a.text.indexOf('SECRETO-TLS') < 0, 'el token nunca sale en la respuesta');
  // Huella distinta: el token se descarta.
  var b = await importar(id1, { tls: true, fingerprint: OTRA });
  assert.strictEqual(b.status, 200, b.text);
  assert.strictEqual(b.json.targets[0].checks.agent.hasToken, false, 'huella distinta => sin token');
  // Huella quitada con TLS: la importación se rechaza (huella obligatoria) y no toca lo guardado.
  var id2 = (await importar(id1, { tls: true, fingerprint: HUELLA, token: 'SECRETO-TLS' })).json.targets[0].id;
  var c = await importar(id2, { tls: true, fingerprint: '' });
  assert.strictEqual(c.status, 400, c.text);
  assert.match(JSON.stringify(c.json.errors), /huella SHA-256 del certificado del agente es obligatoria/);
  var lista = await h.request('GET', '/api/targets', { cookie: cookie });
  assert.strictEqual(lista.json.targets[0].checks.agent.hasToken, true, 'la importación rechazada no modificó nada');
  // TLS apagado: la huella guardada queda vacía y el token no se hereda.
  var d = await importar(id2, { tls: false, fingerprint: HUELLA });
  assert.strictEqual(d.status, 200, d.text);
  assert.strictEqual(d.json.targets[0].checks.agent.fingerprint, '');
  assert.strictEqual(d.json.targets[0].checks.agent.hasToken, false, 'bajar de TLS descarta el token');
});
