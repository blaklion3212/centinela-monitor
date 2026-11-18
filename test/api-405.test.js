'use strict';
/*
 * Fase 4: 405 coherente en la API (server/server.js `api()` y `allowed()` de server/lib/routes.js).
 * Orden esperado: 415 -> 403 Origin -> pública -> 401 -> 403 mustChange -> 403 admin (/api/users*) -> 405 -> 404.
 * Cada grupo arranca su propio servidor hijo con datos temporales (nunca data/ del repo).
 */
var test = require('node:test');
var assert = require('node:assert');
var routes = require('../server/lib/routes');
var srv = require('./helpers/server');

var ADMIN = 'administrador', ADMIN_PASS = 'clave-admin-segura-1';
var servidores = [];
test.after(async function () { for (var h of servidores) await h.stop(); });

async function arrancar(env) {
  var h = await srv.startServer({ env: env || {} });
  servidores.push(h);
  return h;
}
async function entrar(h, user, pass) {
  var r = await h.request('POST', '/api/auth/login', { body: { username: user, password: pass } });
  assert.strictEqual(r.status, 200, r.text);
  return srv.cookieOf(r);
}
async function crearUsuario(h, cookie, nombre, rol, clave) {
  var r = await h.request('POST', '/api/users', { cookie: cookie, body: { username: nombre, role: rol, password: clave } });
  assert.strictEqual(r.status, 201, r.text);
}
// Servidor con administrador, un operador y un lector, ya con sesión iniciada. Se comparte entre pruebas (solo lectura de rutas).
var ctx = null;
async function entorno() {
  if (ctx) return ctx;
  var h = await arrancar({ CENTINELA_ADMIN_USER: ADMIN, CENTINELA_ADMIN_PASSWORD: ADMIN_PASS });
  var adm = await entrar(h, ADMIN, ADMIN_PASS);
  await crearUsuario(h, adm, 'operador1', 'operator', 'clave-operador-01');
  await crearUsuario(h, adm, 'lector1', 'viewer', 'clave-lector-0001');
  ctx = { h: h, adm: adm, op: await entrar(h, 'operador1', 'clave-operador-01'), lec: await entrar(h, 'lector1', 'clave-lector-0001') };
  return ctx;
}
function allow(r) { return r.headers.allow; }

test('M405-01 DELETE /api/layout: 405 con Allow GET, HEAD, PUT y cuerpo de error', async function () {
  var e = await entorno();
  var r = await e.h.request('DELETE', '/api/layout', { cookie: e.adm, body: {} });
  assert.strictEqual(r.status, 405);
  assert.deepStrictEqual(r.json, { error: 'Método no permitido' });
  assert.strictEqual(allow(r), 'GET, HEAD, PUT');
});

test('M405-02 POST /api/state: 405 con Allow GET, HEAD', async function () {
  var e = await entorno();
  var r = await e.h.request('POST', '/api/state', { cookie: e.adm, body: {} });
  assert.strictEqual(r.status, 405);
  assert.strictEqual(allow(r), 'GET, HEAD');
});

test('M405-03 GET /api/orgs/:id: 405 Allow PUT, DELETE sin mirar el id (también con id inexistente)', async function () {
  var e = await entorno();
  var r = await e.h.request('GET', '/api/orgs/noexiste', { cookie: e.adm });
  assert.strictEqual(r.status, 405);
  assert.strictEqual(allow(r), 'PUT, DELETE');
  assert.strictEqual((await e.h.request('GET', '/api/orgs/default', { cookie: e.adm })).status, 405);
});

test('M405-04 GET /api/targets/:id/check: 405 Allow POST', async function () {
  var e = await entorno();
  var r = await e.h.request('GET', '/api/targets/t_1/check', { cookie: e.adm });
  assert.strictEqual(r.status, 405);
  assert.strictEqual(allow(r), 'POST');
});

test('M405-05 Allow: sin "*", sin duplicados y con HEAD solo justo después de GET', async function () {
  var e = await entorno();
  var rutas = [['DELETE', '/api/layout'], ['POST', '/api/state'], ['GET', '/api/orgs/x'], ['PATCH', '/api/targets'], ['GET', '/api/traceroute']];
  for (var i = 0; i < rutas.length; i++) {
    var r = await e.h.request(rutas[i][0], rutas[i][1], { cookie: e.adm, body: {} });
    assert.strictEqual(r.status, 405, rutas[i].join(' '));
    var lista = allow(r).split(', ');
    assert.ok(allow(r).indexOf('*') < 0, allow(r));
    assert.strictEqual(new Set(lista).size, lista.length, 'sin duplicados: ' + allow(r));
    var iG = lista.indexOf('GET'), iH = lista.indexOf('HEAD');
    if (iG >= 0) assert.strictEqual(iH, iG + 1, 'HEAD justo después de GET: ' + allow(r));
    else assert.strictEqual(iH, -1, 'sin GET no hay HEAD: ' + allow(r));
  }
});

test('M405-06 /api/health: HEAD público 200 sin cuerpo; POST anónimo 401; con sesión POST 405 Allow GET, HEAD', async function () {
  var e = await entorno();
  var hd = await e.h.request('HEAD', '/api/health');
  assert.strictEqual(hd.status, 200);
  assert.strictEqual(hd.text, '', 'HEAD no lleva cuerpo');
  var anonP = await e.h.request('POST', '/api/health', { body: {} });
  assert.strictEqual(anonP.status, 401);
  assert.strictEqual(allow(anonP), undefined);
  var p = await e.h.request('POST', '/api/health', { cookie: e.adm, body: {} });
  assert.strictEqual(p.status, 405);
  assert.strictEqual(allow(p), 'GET, HEAD');
  assert.strictEqual((await e.h.request('GET', '/api/health')).status, 200);
});

test('M405-06b HEAD anónimo a rutas protegidas: 401; con sesión HEAD /api/state da 200 sin cuerpo', async function () {
  var e = await entorno();
  for (var ruta of ['/api/state', '/api/orgs', '/api/settings', '/api/users', '/api/stream', '/api/auth/me']) {
    var r = await e.h.request('HEAD', ruta);
    assert.strictEqual(r.status, 401, ruta);
  }
  var ok = await e.h.request('HEAD', '/api/state', { cookie: e.adm });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.text, '');
  // HEAD sobre una ruta sin GET (solo POST): 405 con Allow POST.
  var sinGet = await e.h.request('HEAD', '/api/traceroute', { cookie: e.adm });
  assert.strictEqual(sinGet.status, 405);
  assert.strictEqual(allow(sinGet), 'POST');
});

test('M405-06c HEAD /api/stream: 405 con Allow GET y no deja ningún flujo abierto', async function () {
  var e = await entorno();
  var r = await e.h.request('HEAD', '/api/stream', { cookie: e.adm });
  assert.strictEqual(r.status, 405);
  assert.strictEqual(allow(r), 'GET');
  // El SSE de GET sigue funcionando: se abre y se cierra (si el HEAD hubiera dejado un flujo, contaría en los topes).
  var st = await srv.openStream(e.h.port, { cookie: e.adm });
  try { assert.strictEqual(st.status, 200); } finally { st.close(); }
  // HEAD de un no admin en /api/users: 403, no 405 ni datos.
  assert.strictEqual((await e.h.request('HEAD', '/api/users', { cookie: e.lec })).status, 403);
});

test('M405-07 GET /api/auth/login anónimo: 401 (no 405) para no revelar rutas; con sesión sí 405 Allow POST', async function () {
  var e = await entorno();
  var anon = await e.h.request('GET', '/api/auth/login');
  assert.strictEqual(anon.status, 401);
  assert.strictEqual(allow(anon), undefined);
  var ses = await e.h.request('GET', '/api/auth/login', { cookie: e.adm });
  assert.strictEqual(ses.status, 405);
  assert.strictEqual(allow(ses), 'POST');
});

test('M405-08 anónimo con método no declarado en rutas privadas: 401, nunca 405', async function () {
  var e = await entorno();
  var r = await e.h.request('DELETE', '/api/layout', { body: {} });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(allow(r), undefined);
});

test('M405-09 lector con DELETE /api/layout: 405 (no 403 de solo lectura)', async function () {
  var e = await entorno();
  var r = await e.h.request('DELETE', '/api/layout', { cookie: e.lec, body: {} });
  assert.strictEqual(r.status, 405);
  assert.strictEqual(allow(r), 'GET, HEAD, PUT');
});

test('M405-10 lector en ruta inexistente con escritura: 403 solo lectura (no 404)', async function () {
  var e = await entorno();
  var r = await e.h.request('POST', '/api/no-existe', { cookie: e.lec, body: {} });
  assert.strictEqual(r.status, 403);
  assert.deepStrictEqual(r.json, { error: 'Tu usuario es de solo lectura' });
  // Un administrador en la misma ruta recibe 404.
  var a = await e.h.request('POST', '/api/no-existe', { cookie: e.adm, body: {} });
  assert.strictEqual(a.status, 404);
});

test('M405-11 lector con método existente en ruta existente sigue con 403 solo lectura (PUT /api/layout)', async function () {
  var e = await entorno();
  var r = await e.h.request('PUT', '/api/settings', { cookie: e.lec, body: {} });
  assert.strictEqual(r.status, 403);
  assert.deepStrictEqual(r.json, { error: 'Tu usuario es de solo lectura' });
});

test('M405-12 /api/users: no admin recibe 403 (no 405) con método no declarado; admin recibe 405 Allow GET, HEAD, POST', async function () {
  var e = await entorno();
  var msg = { error: 'Solo un administrador puede gestionar usuarios' };
  for (var cookie of [e.op, e.lec]) {
    var r = await e.h.request('PATCH', '/api/users', { cookie: cookie, body: {} });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.json, msg);
    assert.strictEqual(allow(r), undefined);
  }
  var a = await e.h.request('PATCH', '/api/users', { cookie: e.adm, body: {} });
  assert.strictEqual(a.status, 405);
  assert.strictEqual(allow(a), 'GET, HEAD, POST');
  var b = await e.h.request('GET', '/api/users/alguien', { cookie: e.adm });
  assert.strictEqual(b.status, 405);
  assert.strictEqual(allow(b), 'PUT, DELETE');
  var c = await e.h.request('GET', '/api/users/alguien', { cookie: e.op });
  assert.strictEqual(c.status, 403);
});

test('M405-13 método declarado con id inexistente sigue siendo 404 con su mensaje', async function () {
  var e = await entorno();
  var o = await e.h.request('PUT', '/api/orgs/noexiste', { cookie: e.adm, body: { name: 'X' } });
  assert.strictEqual(o.status, 404);
  assert.deepStrictEqual(o.json, { error: 'Organización no encontrada' });
  var od = await e.h.request('DELETE', '/api/orgs/noexiste', { cookie: e.adm, body: {} });
  assert.strictEqual(od.status, 404);
  assert.deepStrictEqual(od.json, { error: 'Organización no encontrada' });
  var t = await e.h.request('POST', '/api/targets/t_inexistente/check', { cookie: e.adm, body: {} });
  assert.strictEqual(t.status, 404);
  assert.deepStrictEqual(t.json, { error: 'Objetivo no encontrado' });
  var td = await e.h.request('DELETE', '/api/targets/t_inexistente', { cookie: e.adm, body: {} });
  assert.strictEqual(td.status, 404);
  assert.deepStrictEqual(td.json, { error: 'Objetivo no encontrado' });
});

test('M405-14 ruta inexistente: 404 "Ruta no encontrada" sin cabecera Allow', async function () {
  var e = await entorno();
  var r = await e.h.request('GET', '/api/no-existe', { cookie: e.adm });
  assert.strictEqual(r.status, 404);
  assert.deepStrictEqual(r.json, { error: 'Ruta no encontrada' });
  assert.strictEqual(allow(r), undefined);
  var r2 = await e.h.request('GET', '/api/orgs/a/b', { cookie: e.adm });
  assert.strictEqual(r2.status, 404, 'un id con barra no coincide con ningún patrón');
});

test('M405-15 id que no cumple el formato del patrón: ni 405 ni coincidencia, 404 de ruta', async function () {
  var e = await entorno();
  // ID_ORG solo admite [a-z0-9]: con mayúsculas el patrón no coincide, así que no hay "ruta existente".
  var r = await e.h.request('GET', '/api/orgs/ABC', { cookie: e.adm });
  assert.strictEqual(r.status, 404);
  assert.deepStrictEqual(r.json, { error: 'Ruta no encontrada' });
});

test('M405-16 orden: 415 antes que 401/405 (escritura sin JSON)', async function () {
  var e = await entorno();
  var r = await e.h.request('DELETE', '/api/layout', { cookie: e.adm, body: 'x', json: false, headers: { 'Content-Type': 'text/plain' } });
  assert.strictEqual(r.status, 415);
  var anon = await e.h.request('POST', '/api/health', { body: 'x', json: false, headers: { 'Content-Type': 'text/plain' } });
  assert.strictEqual(anon.status, 415);
});

test('M405-17 orden: 403 de Origin antes que 405', async function () {
  var e = await entorno();
  var r = await e.h.request('DELETE', '/api/layout', { cookie: e.adm, body: {}, headers: { Origin: 'http://otro.example' } });
  assert.strictEqual(r.status, 403);
  assert.deepStrictEqual(r.json, { error: 'Origen no permitido' });
});

test('M405-18 mustChange + método no declarado: 403 de cambio de contraseña (antes que 405)', async function () {
  // Sin CENTINELA_ADMIN_PASSWORD el servidor genera una contraseña aleatoria con cambio obligatorio.
  var h = await arrancar({});
  var pass = h.adminPassword();
  assert.ok(pass, 'se esperaba contraseña generada en el log');
  var user = /Usuario:\s+(\S+)/.exec(h.log());
  var cookie = await entrar(h, user ? user[1] : 'admin', pass);
  var r = await h.request('DELETE', '/api/layout', { cookie: cookie, body: {} });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.mustChange, true);
  assert.strictEqual(allow(r), undefined);
  // También en una ruta mustChange con método no declarado: no hay ruta que lo exima, así que manda el 403.
  var m = await h.request('GET', '/api/auth/logout', { cookie: cookie });
  assert.strictEqual(m.status, 403);
  assert.strictEqual(m.json.mustChange, true);
  // Con el método declarado (GET /api/auth/me) sí se permite.
  assert.strictEqual((await h.request('GET', '/api/auth/me', { cookie: cookie })).status, 200);
  // Y una ruta inexistente también es 403 mustChange, no 404.
  var n = await h.request('GET', '/api/no-existe', { cookie: cookie });
  assert.strictEqual(n.status, 403);
});

test('M405-19 con AUTH desactivada: 405 y 404 igual de coherentes', async function () {
  var h = await arrancar({ CENTINELA_AUTH: 'off' });
  var r = await h.request('DELETE', '/api/layout', { body: {} });
  assert.strictEqual(r.status, 405);
  assert.strictEqual(allow(r), 'GET, HEAD, PUT');
  assert.strictEqual((await h.request('GET', '/api/no-existe')).status, 404);
});

// ---------- Unitarias de allowed() ----------

test('M405-20 allowed(): métodos en orden de tabla sin repetir, HEAD tras GET, y primera ruta del patrón', function () {
  var a = { method: 'GET', pattern: '/x/:id' }, b = { method: 'PUT', pattern: '/x/:id' }, c = { method: 'GET', pattern: '/x/:id' };
  var rt = routes.createRouter([a, b, c]);
  var r = rt.allowed('/x/7');
  assert.deepStrictEqual(r.methods, ['GET', 'HEAD', 'PUT']);
  assert.strictEqual(r.route, a);
});

test('M405-21 allowed(): null si ningún patrón coincide y con tabla vacía', function () {
  var rt = routes.createRouter([{ method: 'GET', pattern: '/x' }]);
  assert.strictEqual(rt.allowed('/y'), null);
  assert.strictEqual(rt.allowed(''), null);
  assert.strictEqual(routes.createRouter([]).allowed('/x'), null);
});

test('M405-22 createRouter rechaza el método "*" (ya no existe como respaldo)', function () {
  assert.throws(function () { routes.createRouter([{ method: '*', pattern: '/x' }]); }, /"\*"/);
  assert.throws(function () { routes.createRouter([{ method: 'POST', pattern: '/x' }, { method: '*', pattern: '/x' }]); }, /"\*"/);
});

test('M405-23 allowed(): respeta params personalizados y no cruza barras', function () {
  var rt = routes.createRouter([{ method: 'GET', pattern: '/o/:id', params: { id: '[a-z]+' } }]);
  assert.strictEqual(rt.allowed('/o/abc').methods[0], 'GET');
  assert.strictEqual(rt.allowed('/o/ABC'), null);
  assert.strictEqual(rt.allowed('/o/a/b'), null);
});

test('M405-24 allowed() es coherente con match(): lo que match no sirve, allowed lo lista aparte', function () {
  var r = { method: 'GET', pattern: '/x' };
  var rt = routes.createRouter([r]);
  assert.strictEqual(rt.match('POST', '/x'), null);
  assert.deepStrictEqual(rt.allowed('/x').methods, ['GET', 'HEAD']);
  assert.strictEqual(rt.match('HEAD', '/x').route, r, 'todo método de Allow lo sirve match');
  var noHead = routes.createRouter([{ method: 'GET', pattern: '/s', noHead: true }]);
  assert.deepStrictEqual(noHead.allowed('/s').methods, ['GET']);
  assert.strictEqual(noHead.match('HEAD', '/s'), null);
});
