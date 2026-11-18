'use strict';
/*
 * H-17: POST /api/targets/:id/check. 409 si ya hay una verificación en curso (tiene prioridad) y, si hubo una
 * verificación manual de ese objetivo hace menos de 5 s, 429 con Retry-After. Servidor hijo en 127.0.0.1 con datos
 * temporales y objetivos que no salen a Internet (loopback, sin ping).
 */
var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var srv = require('./helpers/server');

var ADMIN = 'administrador', ADMIN_PASS = 'clave-admin-segura-1';
var MENSAJE_429 = 'Espera unos segundos antes de volver a verificar este objetivo';
var servidores = [], mudos = [];

test.after(async function () {
  mudos.forEach(function (m) { m.cerrar(); });
  for (var h of servidores) await h.stop();
});

async function arrancar(env) {
  var h = await srv.startServer({ env: Object.assign({ CENTINELA_ADMIN_PASSWORD: ADMIN_PASS }, env || {}) });
  servidores.push(h);
  var r = await h.request('POST', '/api/auth/login', { body: { username: ADMIN, password: ADMIN_PASS } });
  assert.strictEqual(r.status, 200, r.text);
  h.cookie = srv.cookieOf(r);
  return h;
}
// Objetivo sin sondas pesadas: la verificación termina en milisegundos.
async function objetivoRapido(h, nombre) {
  var c = await h.request('POST', '/api/targets', { cookie: h.cookie, body: { name: nombre, kind: 'host', address: '127.0.0.1', enabled: false, checks: { ping: false } } });
  assert.strictEqual(c.status, 201, c.text);
  return c.json.target.id;
}
function verificar(h, id) { return h.request('POST', '/api/targets/' + id + '/check', { cookie: h.cookie, body: {} }); }
// Servidor HTTP local que acepta conexiones y nunca responde (la verificación queda en curso).
async function servidorMudo() {
  var socks = new Set(), m = { conexiones: 0 };
  // Solo cuentan las peticiones de la sonda (User-Agent 'Centinela-Monitor'), no cualquier conexión TCP ajena.
  var s = http.createServer(function (req) { if (req.headers['user-agent'] === 'Centinela-Monitor') m.conexiones++; /* no responde */ });
  s.on('connection', function (c) { socks.add(c); c.on('close', function () { socks.delete(c); }); });
  await new Promise(function (r) { s.listen(0, '127.0.0.1', r); });
  m.port = s.address().port;
  m.cerrar = function () { socks.forEach(function (c) { c.destroy(); }); s.close(); };
  mudos.push(m);
  return m;
}

test('H-17: la primera verificación manual responde 200 y la segunda inmediata 429 con Retry-After y mensaje', async function () {
  var h = await arrancar();
  var id = await objetivoRapido(h, 'rapido');
  var a = await verificar(h, id);
  assert.strictEqual(a.status, 200, a.text);
  assert.ok(a.json.result && a.json.result.id === id);
  var b = await verificar(h, id);
  assert.strictEqual(b.status, 429, b.text);
  assert.strictEqual(b.json.error, MENSAJE_429);
  var ra = b.headers['retry-after'];
  assert.match(ra, /^[1-5]$/, 'Retry-After es un entero de segundos entre 1 y 5: ' + ra);
  assert.strictEqual(b.headers['cache-control'], 'no-store');
  // Una tercera inmediata sigue limitada (la 429 no reinicia ni consume la ventana de forma indebida).
  assert.strictEqual((await verificar(h, id)).status, 429);
});

test('H-17: el límite es por objetivo: otro objetivo se puede verificar de inmediato', async function () {
  var h = await arrancar();
  var a = await objetivoRapido(h, 'uno'), b = await objetivoRapido(h, 'dos');
  assert.strictEqual((await verificar(h, a)).status, 200);
  assert.strictEqual((await verificar(h, a)).status, 429);
  assert.strictEqual((await verificar(h, b)).status, 200, 'el otro objetivo no se ve afectado');
});

test('H-17: objetivo inexistente => 404 (no 429) y no reserva ventana alguna', async function () {
  var h = await arrancar();
  assert.strictEqual((await verificar(h, 'no-existe')).status, 404);
  assert.strictEqual((await verificar(h, 'no-existe')).status, 404);
});

test('H-17: pasada la ventana de 5 s la verificación manual vuelve a aceptarse (y Retry-After no miente)', async function () {
  var h = await arrancar();
  var id = await objetivoRapido(h, 'ventana');
  var t0 = Date.now();
  assert.strictEqual((await verificar(h, id)).status, 200);
  var r = await verificar(h, id);
  assert.strictEqual(r.status, 429);
  var espera = Number(r.headers['retry-after']);
  // Espera activa (sondeo cada 250 ms) hasta que el servidor acepte de nuevo; nunca antes de lo que prometió.
  var fin = Date.now() + 9000, ultimo;
  while (Date.now() < fin) {
    await new Promise(function (res) { setTimeout(res, 250); });
    ultimo = await verificar(h, id);
    if (ultimo.status !== 429) break;
  }
  assert.strictEqual(ultimo.status, 200, 'tras la ventana vuelve a responder 200');
  var dt = Date.now() - t0;
  assert.ok(dt >= 4500, 'la ventana mínima es de ~5 s (' + dt + ' ms)');
  assert.ok(espera >= 1 && espera <= 5);
});

test('H-17: con una verificación en curso la respuesta es 409 (tiene prioridad sobre el 429 aunque la ventana esté activa)', async function () {
  var mudo = await servidorMudo();
  var h = await arrancar();
  var c = await h.request('POST', '/api/targets', { cookie: h.cookie, body: { name: 'colgado', kind: 'url', address: 'http://127.0.0.1:' + mudo.port + '/',
    enabled: false, checks: { ping: false, http: { timeoutMs: 30000 } } } });
  assert.strictEqual(c.status, 201, c.text);
  var id = c.json.target.id;
  // La primera verificación queda en curso (el servidor mudo no responde); no se espera su final: se corta al parar el servidor.
  var primera = verificar(h, id);
  primera.catch(function () { /* se cancela al parar el servidor */ });
  var fin = Date.now() + 8000;
  while (mudo.conexiones < 1 && Date.now() < fin) await new Promise(function (r) { setTimeout(r, 25); });
  assert.ok(mudo.conexiones >= 1, 'la sonda HTTP llegó al servidor mudo (verificación en curso)');
  // En este momento la ventana de 5 s también está activa: aun así debe ganar el 409.
  var r = await verificar(h, id);
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.json.error, /en curso/);
  assert.strictEqual(r.headers['retry-after'], undefined, 'el 409 no lleva Retry-After');
  assert.strictEqual(mudo.conexiones, 1, 'el 409 no lanzó otra verificación');
});

/* ---------- Cupo de verificaciones manuales por usuario (o por IP sin autenticación) ---------- */

var MENSAJE_CUPO = 'Demasiadas verificaciones manuales; espera un momento';
async function varios(h, n, prefijo) {
  var ids = [];
  for (var i = 0; i < n; i++) ids.push(await objetivoRapido(h, prefijo + i));
  return ids;
}
// Crea un objetivo que usa el servidor mudo (la verificación queda en curso hasta que se pare el servidor).
async function objetivoColgado(h, mudo, nombre) {
  var c = await h.request('POST', '/api/targets', { cookie: h.cookie, body: { name: nombre, kind: 'url', address: 'http://127.0.0.1:' + mudo.port + '/',
    enabled: false, checks: { ping: false, http: { timeoutMs: 30000 } } } });
  assert.strictEqual(c.status, 201, c.text);
  return c.json.target.id;
}
async function esperarCond(cond, ms, motivo) {
  var fin = Date.now() + ms;
  while (!cond() && Date.now() < fin) await new Promise(function (r) { setTimeout(r, 25); });
  assert.ok(cond(), 'plazo agotado esperando: ' + motivo);
}

test('H-17 cupo: la 4.ª verificación manual simultánea del mismo usuario es 429 con Retry-After y mensaje de cupo', async function () {
  var mudo = await servidorMudo();
  var h = await arrancar();
  var ids = [];
  for (var i = 0; i < 4; i++) ids.push(await objetivoColgado(h, mudo, 'colgado' + i));
  // Tres verificaciones en curso (el servidor mudo no responde); se cortan al parar el servidor.
  for (i = 0; i < 3; i++) verificar(h, ids[i]).catch(function () { /* se cancela al parar el servidor */ });
  await esperarCond(function () { return mudo.conexiones >= 3; }, 8000, 'las 3 sondas llegaron al servidor mudo');
  var r = await verificar(h, ids[3]);
  assert.strictEqual(r.status, 429, r.text);
  assert.strictEqual(r.json.error, MENSAJE_CUPO);
  assert.match(r.headers['retry-after'], /^\d+$/, 'lleva Retry-After entero: ' + r.headers['retry-after']);
  assert.ok(Number(r.headers['retry-after']) >= 1);
  assert.strictEqual(mudo.conexiones, 3, 'la rechazada no lanzó otra sonda');
  // La ventana por objetivo (5 s) sigue vigente aparte: la 4.ª, ya rechazada por cupo, no reservó la ventana de su objetivo.
  var otra = await verificar(h, ids[0]);
  assert.strictEqual(otra.status, 409, 'un objetivo en curso sigue dando 409: ' + otra.text);
});

test('H-17 cupo: el cupo es por usuario: otro usuario sigue pudiendo verificar mientras el primero está al tope', async function () {
  var mudo = await servidorMudo();
  var h = await arrancar();
  var ids = [];
  for (var i = 0; i < 4; i++) ids.push(await objetivoColgado(h, mudo, 'colgado' + i));
  var libre = await objetivoRapido(h, 'libre');
  var op = await h.request('POST', '/api/users', { cookie: h.cookie, body: { username: 'operador1', role: 'operator', password: 'otra-clave-segura-2' } });
  assert.strictEqual(op.status, 201, op.text);
  var l = await h.request('POST', '/api/auth/login', { body: { username: 'operador1', password: 'otra-clave-segura-2' } });
  assert.strictEqual(l.status, 200, l.text);
  var cookieOp = srv.cookieOf(l);
  for (i = 0; i < 3; i++) verificar(h, ids[i]).catch(function () { /* se cancela al parar */ });
  await esperarCond(function () { return mudo.conexiones >= 3; }, 8000, '3 en curso');
  assert.strictEqual((await verificar(h, ids[3])).status, 429, 'el administrador está al tope');
  var r = await h.request('POST', '/api/targets/' + libre + '/check', { cookie: cookieOp, body: {} });
  assert.strictEqual(r.status, 200, 'el operador tiene su propio cupo: ' + r.text);
});

test('H-17 cupo: la 31.ª verificación manual en un minuto es 429 (30 por minuto por usuario) con Retry-After de 1 a 60 s', async function () {
  var h = await arrancar();
  var ids = await varios(h, 31, 'm');
  for (var i = 0; i < 30; i++) {
    var ok = await verificar(h, ids[i]);
    assert.strictEqual(ok.status, 200, 'verificación ' + (i + 1) + ': ' + ok.text);
  }
  var r = await verificar(h, ids[30]);
  assert.strictEqual(r.status, 429, r.text);
  assert.strictEqual(r.json.error, MENSAJE_CUPO);
  var ra = Number(r.headers['retry-after']);
  assert.ok(ra >= 1 && ra <= 60, 'Retry-After dentro de la ventana de 60 s: ' + r.headers['retry-after']);
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  // Distinto del mensaje por objetivo: el intervalo de 5 s sigue siendo otra regla.
  var repetida = await verificar(h, ids[0]);
  assert.strictEqual(repetida.status, 429);
  assert.strictEqual(repetida.json.error, MENSAJE_429, 'la del mismo objetivo conserva su propio mensaje (se evalúa antes)');
});

test('H-17 cupo: sin autenticación el cupo es por IP (3 simultáneas)', async function () {
  var mudo = await servidorMudo();
  var h = await srv.startServer({ env: { CENTINELA_AUTH: 'off' } });
  servidores.push(h);
  var ids = [];
  for (var i = 0; i < 4; i++) {
    var c = await h.request('POST', '/api/targets', { body: { name: 'colgado' + i, kind: 'url', address: 'http://127.0.0.1:' + mudo.port + '/',
      enabled: false, checks: { ping: false, http: { timeoutMs: 30000 } } } });
    assert.strictEqual(c.status, 201, c.text);
    ids.push(c.json.target.id);
  }
  for (i = 0; i < 3; i++) h.request('POST', '/api/targets/' + ids[i] + '/check', { body: {} }).catch(function () { /* se cancela al parar */ });
  await esperarCond(function () { return mudo.conexiones >= 3; }, 8000, '3 en curso');
  var r = await h.request('POST', '/api/targets/' + ids[3] + '/check', { body: {} });
  assert.strictEqual(r.status, 429, r.text);
  assert.strictEqual(r.json.error, MENSAJE_CUPO);
  assert.ok(r.headers['retry-after']);
});
