'use strict';
/* R9: API de integración. Se arranca server/server.js como proceso hijo (127.0.0.1, puerto libre, datos temporales). */
var test = require('node:test');
var assert = require('node:assert');
var srv = require('./helpers/server');

var ADMIN = 'administrador', NEW_PASS = 'clave-nueva-segura-1';
// Sin CENTINELA_ADMIN_PASSWORD el servidor genera una contraseña aleatoria y la imprime una sola vez en el log de arranque.
var INITIAL_PASS = null;
var s = null, adminCookie = null, viewerCookie = null;

test.before(async function () { s = await srv.startServer(); INITIAL_PASS = s.adminPassword(); });
test.after(async function () { if (s) await s.stop(); }); // child.kill aunque fallen las pruebas

async function login(user, pass, extra) {
  var r = await s.request('POST', '/api/auth/login', Object.assign({ body: { username: user, password: pass } }, extra || {}));
  return r;
}

test('R9: /api/health responde sin exponer la versión', async function () {
  var r = await s.request('GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual('version' in r.json, false);
  assert.ok(!/\d+\.\d+\.\d+/.test(r.text), 'no debe aparecer ningún número de versión: ' + r.text);
});

test('R9: el log de arranque muestra una vez la contraseña inicial aleatoria (sin admin01)', async function () {
  var log = s.log();
  assert.ok(INITIAL_PASS, 'no se encontró "Contraseña:" en el log:\n' + log);
  assert.ok(INITIAL_PASS.length >= 12, 'longitud: ' + INITIAL_PASS.length);
  assert.notStrictEqual(INITIAL_PASS, 'admin01');
  assert.match(log, /CONTRASEÑA INICIAL DEL ADMINISTRADOR/);
  assert.match(log, /Usuario:\s+administrador/);
  assert.strictEqual(log.split(INITIAL_PASS).length - 1, 1, 'la contraseña aparece una sola vez en el log');
  assert.strictEqual((await login(ADMIN, 'admin01')).status, 401, 'admin01 ya no existe');
});

test('R9: sin sesión la API protegida responde 401', async function () {
  assert.strictEqual((await s.request('GET', '/api/state')).status, 401);
  assert.strictEqual((await s.request('GET', '/api/targets')).status, 401);
});

test('R9: login erróneo => 401 genérico; correcto => cookie HttpOnly SameSite=Strict', async function () {
  var mal = await login(ADMIN, 'equivocada');
  assert.strictEqual(mal.status, 401);
  var ok = await login(ADMIN, INITIAL_PASS);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.user.mustChange, true);
  var sc = ok.headers['set-cookie'][0];
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  adminCookie = srv.cookieOf(ok);
  assert.ok(adminCookie);
});

test('R9: con la contraseña inicial generada /api/state da 403 mustChange hasta cambiarla', async function () {
  var r = await s.request('GET', '/api/state', { cookie: adminCookie });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.mustChange, true);
  assert.strictEqual((await s.request('GET', '/api/targets', { cookie: adminCookie })).status, 403);
  assert.strictEqual((await s.request('GET', '/api/users', { cookie: adminCookie })).status, 403);
  // Lo permitido: consultar la sesión.
  var me = await s.request('GET', '/api/auth/me', { cookie: adminCookie });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.user.mustChange, true);
});

test('R9: /api/auth/me incluye el bloque server solo para administradores', async function () {
  var me = await s.request('GET', '/api/auth/me', { cookie: adminCookie });
  assert.ok(me.json.server, 'el administrador ve server');
  assert.strictEqual(typeof me.json.server.host, 'string');
  assert.strictEqual(me.json.server.node, process.version);
  assert.match(me.json.server.version, /^\d+\.\d+\.\d+/);
  assert.strictEqual(me.json.server.platform, process.platform);
  // Que operador y lector NO lo reciben se comprueba en api-extra.test.js (servidor sin contraseña pendiente).
});

test('R9: cambio de contraseña (clave actual errónea => 400) y luego se abre /api/state', async function () {
  var mal = await s.request('POST', '/api/auth/password', { cookie: adminCookie, body: { current: 'otra', next: NEW_PASS } });
  assert.strictEqual(mal.status, 400);
  var ok = await s.request('POST', '/api/auth/password', { cookie: adminCookie, body: { current: INITIAL_PASS, next: NEW_PASS } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.user.mustChange, false);
  var st = await s.request('GET', '/api/state', { cookie: adminCookie });
  assert.strictEqual(st.status, 200);
  assert.ok(Array.isArray(st.json.targets));
  assert.strictEqual(st.json.targets.length, 0);
  // La clave anterior ya no sirve.
  assert.strictEqual((await login(ADMIN, INITIAL_PASS)).status, 401);
});

test('R9: POST sin Content-Type JSON => 415', async function () {
  var r = await s.request('POST', '/api/orgs', { cookie: adminCookie, json: false, headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x"}' });
  assert.strictEqual(r.status, 415);
  var sinTipo = await s.request('POST', '/api/auth/login', { json: false, body: '{"username":"a","password":"b"}' });
  assert.strictEqual(sinTipo.status, 415);
  var form = await s.request('POST', '/api/targets', { cookie: adminCookie, json: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
  assert.strictEqual(form.status, 415);
});

test('R9: Origin ajeno => 403; el mismo origen se acepta', async function () {
  var ajeno = await s.request('POST', '/api/orgs', { cookie: adminCookie, headers: { Origin: 'http://evil.example' }, body: { name: 'Org ajena' } });
  assert.strictEqual(ajeno.status, 403);
  var invalido = await s.request('POST', '/api/orgs', { cookie: adminCookie, headers: { Origin: 'no-es-url' }, body: { name: 'Org rara' } });
  assert.strictEqual(invalido.status, 403);
  var propio = await s.request('POST', '/api/orgs', { cookie: adminCookie, headers: { Origin: 'http://127.0.0.1:' + s.port }, body: { name: 'Org propia' } });
  assert.strictEqual(propio.status, 201);
  // Una org ajena no se creó.
  var orgs = (await s.request('GET', '/api/orgs', { cookie: adminCookie })).json.orgs.map(function (o) { return o.name; });
  assert.ok(orgs.indexOf('Org ajena') < 0);
});

test('R9: cuerpo "null" (y otros JSON que no son objeto) => 400', async function () {
  for (var cuerpo of ['null', '[]', '123', '"texto"', '{ roto']) {
    var r = await s.request('POST', '/api/targets', { cookie: adminCookie, body: cuerpo });
    assert.strictEqual(r.status, 400, 'cuerpo ' + cuerpo);
  }
  assert.strictEqual((await s.request('PUT', '/api/settings', { cookie: adminCookie, body: 'null' })).status, 400);
  assert.strictEqual((await login(null, null, { body: 'null' })).status, 400);
});

test('R9: el administrador crea un objetivo URL (201) sin exponer el token', async function () {
  var r = await s.request('POST', '/api/targets', { cookie: adminCookie, body: {
    name: 'Salud local', kind: 'url', address: 'http://127.0.0.1:' + s.port + '/api/health', enabled: false,
    checks: { ping: false, http: { expectedStatus: '200' }, agent: { token: 'SECRETO-XYZ' } } } });
  assert.strictEqual(r.status, 201, r.text);
  assert.ok(r.json.target.id);
  assert.strictEqual(r.json.target.kind, 'url');
  assert.ok(r.text.indexOf('SECRETO-XYZ') < 0, 'el token no debe salir en la respuesta');
  var lista = await s.request('GET', '/api/targets', { cookie: adminCookie });
  assert.strictEqual(lista.json.targets.length, 1);
  assert.ok(lista.text.indexOf('SECRETO-XYZ') < 0);
  var estado = await s.request('GET', '/api/state', { cookie: adminCookie });
  assert.ok(estado.text.indexOf('SECRETO-XYZ') < 0);
});

test('R9: objetivos inválidos se rechazan con 400 y errores', async function () {
  var r = await s.request('POST', '/api/targets', { cookie: adminCookie, body: { name: 'x', address: '-Hroot@x' } });
  assert.strictEqual(r.status, 400);
  assert.ok(Array.isArray(r.json.errors) && r.json.errors.length > 0);
  var s2 = await s.request('POST', '/api/targets', { cookie: adminCookie, body: { name: 'x', address: '10.0.0.1', checks: { agent: { services: ['-Hroot@x'] } } } });
  assert.strictEqual(s2.status, 400);
});

test('R9: PUT/DELETE/check de un objetivo inexistente => 404', async function () {
  var put = await s.request('PUT', '/api/targets/no-existe', { cookie: adminCookie, body: { name: 'x', address: '10.0.0.1' } });
  assert.strictEqual(put.status, 404);
  // DELETE también exige Content-Type JSON (defensa CSRF), aunque no lleve cuerpo.
  assert.strictEqual((await s.request('DELETE', '/api/targets/no-existe', { cookie: adminCookie })).status, 415);
  assert.strictEqual((await s.request('DELETE', '/api/targets/no-existe', { cookie: adminCookie, headers: { 'Content-Type': 'application/json' } })).status, 404);
  assert.strictEqual((await s.request('POST', '/api/targets/no-existe/check', { cookie: adminCookie, body: {} })).status, 404);
});

test('R9: actualizar un objetivo existente conserva el id', async function () {
  var id = (await s.request('GET', '/api/targets', { cookie: adminCookie })).json.targets[0].id;
  var put = await s.request('PUT', '/api/targets/' + id, { cookie: adminCookie, body: { name: 'Renombrado', kind: 'url', address: 'http://127.0.0.1:' + s.port + '/', enabled: false, checks: { ping: false, http: {} } } });
  assert.strictEqual(put.status, 200, put.text);
  assert.strictEqual(put.json.target.id, id);
  assert.strictEqual(put.json.target.name, 'Renombrado');
});

test('R9: un viewer no puede crear objetivos (403) ni hacer traceroute con dirección libre (403)', async function () {
  var c = await s.request('POST', '/api/users', { cookie: adminCookie, body: { username: 'lector1', role: 'viewer', password: 'clave-lector-1' } });
  assert.strictEqual(c.status, 201, c.text);
  var l = await login('lector1', 'clave-lector-1');
  assert.strictEqual(l.status, 200);
  assert.strictEqual(l.json.user.mustChange, false);
  viewerCookie = srv.cookieOf(l);

  var crea = await s.request('POST', '/api/targets', { cookie: viewerCookie, body: { name: 'x', address: '10.0.0.1' } });
  assert.strictEqual(crea.status, 403);
  var tr = await s.request('POST', '/api/traceroute', { cookie: viewerCookie, body: { address: '127.0.0.1' } });
  assert.strictEqual(tr.status, 403);
  // Lectura permitida; escrituras de configuración no.
  assert.strictEqual((await s.request('GET', '/api/state', { cookie: viewerCookie })).status, 200);
  assert.strictEqual((await s.request('PUT', '/api/settings', { cookie: viewerCookie, body: { intervalSec: 5 } })).status, 403);
  assert.strictEqual((await s.request('POST', '/api/orgs', { cookie: viewerCookie, body: { name: 'z' } })).status, 403);
  assert.strictEqual((await s.request('GET', '/api/users', { cookie: viewerCookie })).status, 403);
  // Traceroute a un objetivo inexistente: pasa el filtro de rol y da 404 (sin ejecutar ningún comando).
  assert.strictEqual((await s.request('POST', '/api/traceroute', { cookie: viewerCookie, body: { targetId: 'no-existe' } })).status, 404);
});

test('R9: traceroute con host inválido => 400 (admin)', async function () {
  var r = await s.request('POST', '/api/traceroute', { cookie: adminCookie, body: { address: '-x; id' } });
  assert.strictEqual(r.status, 400);
});

test('R9: ajustes inválidos => 400 con errors y sin aplicarse; los válidos sí', async function () {
  var antes = (await s.request('GET', '/api/settings', { cookie: adminCookie })).json;
  var orden = await s.request('PUT', '/api/settings', { cookie: adminCookie, body: { thresholds: { latencyWarnMs: 900, latencyCritMs: 100 } } });
  assert.strictEqual(orden.status, 400, orden.text);
  assert.ok(Array.isArray(orden.json.errors) && orden.json.errors.length > 0);
  assert.ok(orden.json.errors.some(function (m) { return m === 'En "Latencia" el aviso (900) debe ser menor que el crítico (100).'; }), orden.text);
  var nonum = await s.request('PUT', '/api/settings', { cookie: adminCookie, body: { intervalSec: 'abc' } });
  assert.strictEqual(nonum.status, 400);
  assert.match(nonum.json.errors[0], /Intervalo por defecto \(s\)/);
  var cero = await s.request('PUT', '/api/settings', { cookie: adminCookie, body: { thresholds: { cpuWarnPct: 0 } } });
  assert.strictEqual(cero.status, 400);
  // Nada de lo rechazado se guardó.
  var despues = (await s.request('GET', '/api/settings', { cookie: adminCookie })).json;
  assert.deepStrictEqual(despues, antes);
  var ok = await s.request('PUT', '/api/settings', { cookie: adminCookie, body: { intervalSec: '30', thresholds: { latencyWarnMs: 120, latencyCritMs: 450 } } });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.json.intervalSec, 30);
  assert.strictEqual(ok.json.thresholds.latencyWarnMs, 120);
  assert.strictEqual(ok.json.thresholds.latencyCritMs, 450);
  assert.strictEqual((await s.request('GET', '/api/settings', { cookie: adminCookie })).json.intervalSec, 30, 'persiste');
});

test('R9: no se sirven archivos fuera de index.html, assets y js', async function () {
  assert.strictEqual((await s.request('GET', '/server/server.js')).status, 404);
  assert.strictEqual((await s.request('GET', '/data/users.json')).status, 404);
  assert.strictEqual((await s.request('GET', '/package.json')).status, 404);
  assert.strictEqual((await s.request('GET', '/js/../server/server.js')).status, 404);
  assert.strictEqual((await s.request('GET', '/%2e%2e/etc/passwd')).status, 404);
  var idx = await s.request('GET', '/');
  assert.strictEqual(idx.status, 200);
  assert.match(idx.headers['content-security-policy'], /default-src 'self'/);
});

test('R9: logout invalida la sesión', async function () {
  var l = await login('lector1', 'clave-lector-1');
  var ck = srv.cookieOf(l);
  assert.strictEqual((await s.request('GET', '/api/state', { cookie: ck })).status, 200);
  assert.strictEqual((await s.request('POST', '/api/auth/logout', { cookie: ck, body: {} })).status, 200);
  assert.strictEqual((await s.request('GET', '/api/state', { cookie: ck })).status, 401);
});

test('R9: con CENTINELA_AUTH=off, un Host ajeno (evil.example) => 421', async function () {
  var off = await srv.startServer({ env: { CENTINELA_AUTH: 'off' } });
  try {
    var malo = await off.request('GET', '/api/health', { headers: { Host: 'evil.example' } });
    assert.strictEqual(malo.status, 421);
    var malo2 = await off.request('GET', '/api/state', { headers: { Host: 'evil.example:' + off.port } });
    assert.strictEqual(malo2.status, 421);
    var bueno = await off.request('GET', '/api/health', { headers: { Host: '127.0.0.1:' + off.port } });
    assert.strictEqual(bueno.status, 200);
    var local = await off.request('GET', '/api/health', { headers: { Host: 'localhost:' + off.port } });
    assert.strictEqual(local.status, 200);
    // Sin autenticación la API opera como administrador local y el login queda desactivado.
    assert.strictEqual((await off.request('GET', '/api/state')).status, 200);
    assert.strictEqual((await off.request('POST', '/api/auth/login', { body: { username: 'a', password: 'b' } })).status, 400);
  } finally { await off.stop(); }
});

test('R9: con autenticación activa, CENTINELA_ALLOWED_HOSTS filtra el Host', async function () {
  var h = await srv.startServer({ env: { CENTINELA_ALLOWED_HOSTS: 'centinela.lan' } });
  try {
    assert.strictEqual((await h.request('GET', '/api/health', { headers: { Host: 'evil.example' } })).status, 421);
    assert.strictEqual((await h.request('GET', '/api/health', { headers: { Host: 'centinela.lan:8080' } })).status, 200);
  } finally { await h.stop(); }
});
