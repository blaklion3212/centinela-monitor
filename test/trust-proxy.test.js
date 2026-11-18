'use strict';
/*
 * N-04: CENTINELA_TRUST_PROXY y la IP del cliente (clientIp de server/server.js), observada por sus efectos:
 * bloqueos de login (5 usuario+IP, >20 por IP), cambio de contraseña, cupo de traceroute sin auth y clave SSE sin auth.
 * Cada prueba arranca su servidor hijo en 127.0.0.1; el cliente de prueba siempre llega desde 127.0.0.1, así que
 * "remota confiable" = 127.0.0.1 en la lista y "remota no confiable" = lista sin 127.0.0.1.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var tmp = require('./helpers/tmp');
var srv = require('./helpers/server');

var ADMIN = 'administrador', ADMIN_PASS = 'clave-admin-segura-1';
var servidores = [], abiertos = [], temporales = [];

test.after(async function () {
  abiertos.forEach(function (s) { s.close(); });
  for (var h of servidores) await h.stop();
  temporales.forEach(tmp.rmTmp);
});

async function arrancar(proxies, extra) {
  var env = Object.assign({ CENTINELA_ADMIN_PASSWORD: ADMIN_PASS }, extra || {});
  if (proxies !== undefined) env.CENTINELA_TRUST_PROXY = proxies;
  var h = await srv.startServer({ env: env });
  servidores.push(h);
  return h;
}
// Login con la clave que se indique y X-Forwarded-For opcional (undefined: sin cabecera).
function entrar(h, xff, user, pass) {
  var headers = {};
  if (xff !== undefined) headers['X-Forwarded-For'] = xff;
  return h.request('POST', '/api/auth/login', { headers: headers, body: { username: user || ADMIN, password: pass === undefined ? ADMIN_PASS : pass } });
}
async function fallar(h, xff, veces, user) {
  var ultimo;
  for (var i = 0; i < veces; i++) ultimo = await entrar(h, xff, user || ADMIN, 'mala-' + i);
  return ultimo;
}
// Bloquea (usuario+IP) la IP que corresponda a esa cabecera: 5 fallos seguidos.
async function bloquear(h, xff) {
  var r = await fallar(h, xff, 5);
  assert.strictEqual(r.status, 401, 'el 5.º fallo aún responde 401 (el bloqueo aplica desde el siguiente intento)');
  assert.strictEqual((await entrar(h, xff)).status, 429, 'con la clave correcta ya está bloqueada: ' + xff);
}

test('N-04: remota confiable + X-Forwarded-For: el bloqueo es por la IP del cliente, no por la del proxy', async function () {
  var h = await arrancar('127.0.0.1');
  await bloquear(h, '203.0.113.5');
  assert.strictEqual((await entrar(h, '203.0.113.6')).status, 200, 'otra IP de cliente tras el mismo proxy entra');
  assert.strictEqual((await entrar(h, '203.0.113.5')).status, 429, 'la bloqueada sigue bloqueada');
});

test('N-04: varios saltos: se toma la entrada más a la derecha que no es proxy de confianza', async function () {
  var h = await arrancar('127.0.0.1, 10.0.0.9'); // la lista tolera espacios
  await bloquear(h, '198.51.100.7, 10.0.0.9');
  // Los saltos a la izquierda (falsificables por el cliente) no cambian la clave.
  assert.strictEqual((await entrar(h, '1.1.1.1, 198.51.100.7, 10.0.0.9, 127.0.0.1')).status, 429);
  assert.strictEqual((await entrar(h, '2.2.2.2, 198.51.100.7')).status, 429, 'sin proxies a la derecha la derecha es el cliente');
  // Si el cliente real es otro y el bloqueado queda a la izquierda, no se le arrastra: gana la derecha no confiable.
  assert.strictEqual((await entrar(h, '198.51.100.7, 9.9.9.9')).status, 200);
});

test('N-04: si todas las entradas son proxies de confianza o la cabecera falta, se usa la IP remota', async function () {
  var h = await arrancar('127.0.0.1,10.0.0.9');
  await bloquear(h, undefined); // clave = 127.0.0.1 (remota)
  assert.strictEqual((await entrar(h, '10.0.0.9')).status, 429, 'solo proxies => remota');
  assert.strictEqual((await entrar(h, '10.0.0.9, 127.0.0.1')).status, 429);
  assert.strictEqual((await entrar(h, '')).status, 429, 'cabecera vacía => remota');
  assert.strictEqual((await entrar(h, '203.0.113.50')).status, 200, 'una IP de cliente distinta no está bloqueada');
});

test('N-04: remota NO confiable que envía X-Forwarded-For: se ignora (no sirve para eludir ni para castigar a otro)', async function () {
  var h = await arrancar('10.0.0.1'); // el cliente de prueba (127.0.0.1) no está en la lista
  // Cinco fallos, cada uno con una IP falsa distinta: todos cuentan contra la IP real.
  var r;
  for (var i = 0; i < 5; i++) r = await entrar(h, '203.0.113.' + (10 + i), ADMIN, 'mala-' + i);
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await entrar(h, '203.0.113.99')).status, 429, 'una IP falsa nueva no evita el bloqueo');
  assert.strictEqual((await entrar(h, undefined)).status, 429);
});

test('N-04: sin la variable X-Forwarded-For se ignora por completo', async function () {
  var h = await arrancar(undefined);
  for (var i = 0; i < 5; i++) await entrar(h, '203.0.113.' + (20 + i), ADMIN, 'mala-' + i);
  assert.strictEqual((await entrar(h, '203.0.113.200')).status, 429);
  var h2 = await arrancar(''); // variable vacía = sin proxies de confianza
  for (i = 0; i < 5; i++) await entrar(h2, '203.0.113.' + (20 + i), ADMIN, 'mala-' + i);
  assert.strictEqual((await entrar(h2, '203.0.113.200')).status, 429);
});

test('N-04: la remota se compara normalizada (::ffff:) y la lista tolera entradas vacías o con mayúsculas', async function () {
  var h = await arrancar(' ,::FFFF:127.0.0.1,, ');
  await bloquear(h, '203.0.113.31');
  assert.strictEqual((await entrar(h, '203.0.113.32')).status, 200, 'la lista con ::ffff: sí reconoce 127.0.0.1 como proxy');
});

test('N-04: X-Forwarded-For con IPv6: se normaliza a minúsculas y ::ffff:a.b.c.d equivale a la IPv4', async function () {
  var h = await arrancar('127.0.0.1');
  await bloquear(h, '2001:DB8::1');
  assert.strictEqual((await entrar(h, '2001:db8::1')).status, 429, 'misma IPv6 en minúsculas');
  assert.strictEqual((await entrar(h, '2001:db8::2')).status, 200, 'otra IPv6 no está bloqueada');
  assert.strictEqual((await entrar(h, 'cliente-v6, 2001:db8::1, 127.0.0.1')).status, 429, 'IPv6 también como salto intermedio');
  await bloquear(h, '203.0.113.77');
  assert.strictEqual((await entrar(h, '::ffff:203.0.113.77')).status, 429, 'la forma ::ffff: es la misma IPv4');
});

test('N-04: entradas basura o larguísimas no rompen el servidor: se descartan y cuenta la IP remota (comparten límite)', async function () {
  var h = await arrancar('127.0.0.1');
  var basura = ['<script>alert(1)</script>', '%00%0d%0a', 'unknown', ',,,,', ' , ,  ', '\t', '999.999.999.999', 'a'.repeat(500),
    'x'.repeat(4000) + ', ' + 'y'.repeat(4000)];
  var vistos = [];
  for (var x of basura) {
    var r = await entrar(h, x, ADMIN, 'mala');
    assert.ok(r.status === 401 || r.status === 429, 'cabecera ' + JSON.stringify(x.slice(0, 30)) + ' nunca da 500 => ' + r.status + ' ' + r.text);
    vistos.push(r.status);
  }
  // Todas cuentan contra la IP remota (127.0.0.1): 5 fallos seguidos y el resto ya está bloqueado.
  assert.deepStrictEqual(vistos, [401, 401, 401, 401, 401, 429, 429, 429, 429], 'comparten un único contador: ' + vistos);
  // La clave de bloqueo es la remota: sin cabecera, con la clave correcta y desde la misma remota, también se rechaza.
  assert.strictEqual((await entrar(h, undefined)).status, 429, 'la IP remota quedó bloqueada por la basura');
  assert.strictEqual((await srv.request(h.port, 'GET', '/api/health')).status, 200, 'el servidor sigue vivo');
  assert.ok(h.log().indexOf('[api]') < 0, 'sin errores internos en el log:\n' + h.log());
});

test('N-04: una entrada válida mezclada con basura cuenta como cliente; la basura sola no crea clientes nuevos', async function () {
  var h = await arrancar('127.0.0.1');
  // La parte válida (1.2.3.4) es el cliente: la basura a su derecha se descarta.
  await bloquear(h, '1.2.3.4, ' + 'z'.repeat(300));
  assert.strictEqual((await entrar(h, '1.2.3.4')).status, 429, 'misma clave que 1.2.3.4');
  assert.strictEqual((await entrar(h, '1.2.3.5')).status, 200, 'otra IP no resulta afectada');
  // Una clave distinta cada vez en la basura NO evita el bloqueo: todas valen "la remota".
  var h2 = await arrancar('127.0.0.1');
  for (var i = 0; i < 5; i++) await entrar(h2, 'basura-' + i, ADMIN, 'mala-' + i);
  assert.strictEqual((await entrar(h2, 'otra-basura-distinta')).status, 429, 'no se puede esquivar el límite cambiando la basura');
});

test('N-04: X-Forwarded-For con puerto: "a.b.c.d:puerto" y "[v6]:puerto" equivalen a la IP sin puerto', async function () {
  var h = await arrancar('127.0.0.1');
  await bloquear(h, '203.0.113.50:51234');
  assert.strictEqual((await entrar(h, '203.0.113.50')).status, 429, 'IPv4 con y sin puerto es la misma clave');
  assert.strictEqual((await entrar(h, '203.0.113.50:9')).status, 429, 'otro puerto, misma IP');
  await bloquear(h, '[2001:DB8::7]:443');
  assert.strictEqual((await entrar(h, '2001:db8::7')).status, 429, '[v6]:puerto en mayúsculas = v6 en minúsculas');
  assert.strictEqual((await entrar(h, '[2001:db8::7]')).status, 429, 'con corchetes y sin puerto');
  assert.strictEqual((await entrar(h, '203.0.113.51:51234')).status, 200, 'otra IP con puerto no está bloqueada');
});

test('N-04: CENTINELA_TRUST_PROXY con un CIDR se ignora con aviso y no confía en nadie', async function () {
  var h = await arrancar('127.0.0.0/8');
  assert.match(h.log(), /CENTINELA_TRUST_PROXY: entrada ignorada \(no es una IP\): 127\.0\.0\.0\/8/);
  // Sin proxies de confianza válidos, X-Forwarded-For se ignora: cambiarlo no esquiva el bloqueo.
  for (var i = 0; i < 5; i++) await entrar(h, '203.0.113.' + (60 + i), ADMIN, 'mala-' + i);
  assert.strictEqual((await entrar(h, '203.0.113.200')).status, 429);
  // Una IP válida junto a un CIDR sí se respeta, y solo se avisa del CIDR.
  var h2 = await arrancar('10.0.0.0/8, 127.0.0.1');
  assert.match(h2.log(), /entrada ignorada \(no es una IP\): 10\.0\.0\.0\/8/);
  await bloquear(h2, '203.0.113.90');
  assert.strictEqual((await entrar(h2, '203.0.113.91')).status, 200, 'la IP literal 127.0.0.1 sigue siendo proxy de confianza');
});

test('N-04: dos cabeceras X-Forwarded-For se unen y cuenta la última entrada', async function () {
  var h = await arrancar('127.0.0.1');
  var cuerpo = JSON.stringify({ username: ADMIN, password: 'mala' });
  function crudo(xff1, xff2) {
    return srv.rawHttp(h.port, 'POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1:' + h.port + '\r\nContent-Type: application/json\r\n' +
      'X-Forwarded-For: ' + xff1 + '\r\nX-Forwarded-For: ' + xff2 + '\r\nContent-Length: ' + Buffer.byteLength(cuerpo) + '\r\nConnection: close\r\n\r\n' + cuerpo);
  }
  for (var i = 0; i < 5; i++) assert.strictEqual((await crudo('1.1.1.1', '198.51.100.40')).status, 401);
  assert.strictEqual((await crudo('2.2.2.2', '198.51.100.40')).status, 429, 'misma IP final => bloqueada');
  assert.strictEqual((await crudo('198.51.100.40', '2.2.2.2')).status, 401, 'otra IP final => no bloqueada');
});

test('N-04: el límite de más de 20 fallos por IP se aplica a la IP del cliente (X-Forwarded-For), con usuarios distintos', async function () {
  var h = await arrancar('127.0.0.1');
  var r;
  for (var i = 0; i < 22; i++) r = await entrar(h, '198.51.100.60', 'usuario' + i, 'x');
  assert.strictEqual(r.status, 429, 'el intento 22 desde la IP del cliente se rechaza');
  assert.strictEqual((await entrar(h, '198.51.100.61', 'usuario0', 'x')).status, 401, 'otra IP de cliente no se ve afectada');
  assert.strictEqual((await entrar(h, '198.51.100.61')).status, 200);
});

test('N-04: el cambio de contraseña se bloquea por IP de cliente y no arrastra a otra IP', async function () {
  var h = await arrancar('127.0.0.1');
  var ip1 = '198.51.100.71', ip2 = '198.51.100.72';
  var l1 = await entrar(h, ip1), l2 = await entrar(h, ip2);
  assert.strictEqual(l1.status, 200); assert.strictEqual(l2.status, 200);
  var c1 = srv.cookieOf(l1), c2 = srv.cookieOf(l2);
  function cambiar(ck, xff, actual) {
    return h.request('POST', '/api/auth/password', { cookie: ck, headers: { 'X-Forwarded-For': xff }, body: { current: actual, next: 'clave-nueva-ok-1' } });
  }
  for (var i = 1; i <= 4; i++) assert.strictEqual((await cambiar(c1, ip1, 'mala-' + i)).status, 400, 'intento ' + i);
  assert.strictEqual((await cambiar(c1, ip1, 'mala-5')).status, 429);
  assert.strictEqual((await cambiar(c2, ip2, 'mala-1')).status, 400, 'la otra IP conserva su propio contador');
});

/* ---------- Con autenticación desactivada: cupo de traceroute y clave de los flujos SSE ---------- */

// Directorio con un "traceroute" falso que tarda 30 s y deja una marca por ejecución (sin red).
function trazaFalsa() {
  var dir = tmp.mkTmp('centinela-fakebin-');
  temporales.push(dir);
  fs.writeFileSync(path.join(dir, 'traceroute'), '#!/bin/sh\necho x >> "' + path.join(dir, 'marcas') + '"\nexec sleep 30\n', { mode: 0o755 });
  return dir;
}
function marcas(dir) { try { return fs.readFileSync(path.join(dir, 'marcas'), 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } }
async function esperar(cond, ms, motivo) {
  var fin = Date.now() + (ms || 8000);
  while (Date.now() < fin) { if (cond()) return; await new Promise(function (r) { setTimeout(r, 25); }); }
  assert.fail('plazo agotado esperando: ' + motivo);
}
function trazar(h, xff, direccion) {
  return h.request('POST', '/api/traceroute', { headers: { 'X-Forwarded-For': xff }, body: { address: direccion || '192.0.2.1' } });
}

test('N-04: cupo de traceroute sin auth: con proxy de confianza es por IP de cliente (un traceroute por IP)', async function (t) {
  if (process.platform === 'win32') return t.skip('el traceroute simulado usa un script de shell');
  var bin = trazaFalsa();
  var h = await arrancar('127.0.0.1', { CENTINELA_AUTH: 'off', PATH: bin + path.delimiter + process.env.PATH });
  var p1 = trazar(h, '198.51.100.81');
  p1.catch(function () { /* se cancela al parar el servidor */ });
  await esperar(function () { return marcas(bin) >= 1; }, 8000, 'primer traceroute en ejecución');
  var dup = await trazar(h, '198.51.100.81, 127.0.0.1', '192.0.2.2');
  assert.strictEqual(dup.status, 429, dup.text);
  assert.match(dup.json.error, /en curso/);
  var p2 = trazar(h, '198.51.100.82', '192.0.2.3'); // otra IP de cliente: tiene su propio cupo y arranca
  p2.catch(function () { /* se cancela al parar el servidor */ });
  await esperar(function () { return marcas(bin) >= 2; }, 8000, 'segundo traceroute (otra IP de cliente) en ejecución');
});

test('N-04: cupo de traceroute sin auth: con remota no confiable X-Forwarded-For no da cupo adicional', async function (t) {
  if (process.platform === 'win32') return t.skip('el traceroute simulado usa un script de shell');
  var bin = trazaFalsa();
  var h = await arrancar('10.0.0.1', { CENTINELA_AUTH: 'off', PATH: bin + path.delimiter + process.env.PATH });
  var p1 = trazar(h, '198.51.100.91');
  p1.catch(function () { /* se cancela al parar el servidor */ });
  await esperar(function () { return marcas(bin) >= 1; }, 8000, 'primer traceroute en ejecución');
  var otra = await trazar(h, '198.51.100.92', '192.0.2.2');
  assert.strictEqual(otra.status, 429, otra.text);
  assert.match(otra.json.error, /en curso/, 'misma IP real aunque la cabecera diga otra');
  assert.strictEqual(marcas(bin), 1, 'no se lanzó un segundo traceroute');
});

async function flujo(h, xff) {
  var st = await srv.openStream(h.port, { headers: xff === undefined ? {} : { 'X-Forwarded-For': xff } });
  assert.strictEqual(st.status, 200, st.text);
  abiertos.push(st);
  return st;
}

test('N-04: clave SSE sin auth: con proxy de confianza el tope de 5 flujos es por IP de cliente', async function () {
  var h = await arrancar('127.0.0.1', { CENTINELA_AUTH: 'off' });
  var deB = [];
  for (var i = 0; i < 5; i++) deB.push(await flujo(h, '198.51.100.102'));
  var deA = [];
  for (i = 0; i < 6; i++) deA.push(await flujo(h, '198.51.100.101'));
  assert.strictEqual(await deA[0].whenClosed(2000), true, 'el más antiguo de la IP A se cerró al pasar de 5');
  for (i = 1; i < 6; i++) assert.strictEqual(deA[i].closed(), false);
  deB.forEach(function (x, k) { assert.strictEqual(x.closed(), false, 'IP B flujo ' + (k + 1) + ' intacto'); });
});

test('N-04: clave SSE sin auth: con remota no confiable las IP falsas no multiplican el tope (todos comparten clave)', async function () {
  var h = await arrancar('10.0.0.1', { CENTINELA_AUTH: 'off' });
  var fl = [];
  for (var i = 0; i < 6; i++) fl.push(await flujo(h, '198.51.100.' + (110 + i)));
  assert.strictEqual(await fl[0].whenClosed(2000), true, 'el sexto expulsó al primero aunque las cabeceras difieran');
  for (i = 1; i < 6; i++) assert.strictEqual(fl[i].closed(), false);
});
