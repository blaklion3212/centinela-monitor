'use strict';
/*
 * R7: sonda HTTP (server/probes/http.js) contra un servidor local en 127.0.0.1 (puerto efímero, sin Internet).
 * Cubre el plazo tras las cabeceras, el cuerpo incompleto con palabra clave y el User-Agent.
 */
var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var probe = require('../server/probes/http.js').probe;

var servidor = null, base = '', sockets = new Set(), vistos = [];

test.before(function () {
  return new Promise(function (resolve) {
    servidor = http.createServer(function (req, res) {
      vistos.push(req);
      var p = req.url.split('?')[0];
      if (p === '/ok') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('hola mundo centinela'); }
      if (p === '/colgado') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.flushHeaders(); res.write('parcial'); return; } // nunca termina
      if (p === '/cortado') { // anuncia 1000 bytes, envía 10 y corta la conexión
        res.writeHead(200, { 'Content-Length': '1000' }); res.write('0123456789');
        return setTimeout(function () { req.socket.destroy(); }, 50);
      }
      if (p === '/enorme') { res.writeHead(200); return res.end(Buffer.alloc(600 * 1024, 97)); } // > MAX_BODY (256 KB)
      if (p === '/sin-cabeceras') return; // ni siquiera responde
      res.writeHead(404); res.end('no');
    });
    servidor.on('connection', function (s) { sockets.add(s); s.on('close', function () { sockets.delete(s); }); });
    servidor.listen(0, '127.0.0.1', function () { base = 'http://127.0.0.1:' + servidor.address().port; resolve(); });
  });
});
test.after(function () {
  sockets.forEach(function (s) { s.destroy(); });
  if (servidor) servidor.close();
});

test('R7 http: respuesta normal => status, tiempos y sin error', async function () {
  var r = await probe(base + '/ok', { timeoutMs: 3000 });
  assert.strictEqual(r.http.error, undefined);
  assert.strictEqual(r.http.status, 200);
  assert.ok(r.http.ttfbMs >= 0 && r.http.totalMs >= r.http.ttfbMs);
  assert.strictEqual(r.http.redirects, 0);
  assert.strictEqual(r.tls, null);
});

test('R7 http: el User-Agent es exactamente "Centinela-Monitor" (sin versión)', async function () {
  vistos.length = 0;
  await probe(base + '/ok', { timeoutMs: 3000 });
  assert.strictEqual(vistos[0].headers['user-agent'], 'Centinela-Monitor');
});

test('R7 http: con modo navegador se envía un User-Agent de navegador', async function () {
  vistos.length = 0;
  await probe(base + '/ok', { timeoutMs: 3000, browser: true });
  assert.match(vistos[0].headers['user-agent'], /^Mozilla\//);
});

test('R7 http: plazo agotado DESPUÉS de las cabeceras y sin palabra clave => éxito con el status (no error)', async function () {
  var t0 = Date.now();
  var r = await probe(base + '/colgado', { timeoutMs: 600 });
  assert.strictEqual(r.http.error, undefined, JSON.stringify(r.http));
  assert.strictEqual(r.http.status, 200);
  assert.ok(Date.now() - t0 < 3000, 'no se queda esperando el cuerpo');
});

test('R7 http: plazo agotado DESPUÉS de las cabeceras y con palabra clave => error de tiempo agotado', async function () {
  var r = await probe(base + '/colgado', { timeoutMs: 600, keyword: 'parcial' });
  assert.ok(r.http.error, 'debe ser un error: ' + JSON.stringify(r.http));
  assert.match(r.http.error, /tiempo agotado/);
  assert.strictEqual(r.http.status, undefined);
});

test('R7 http: HEAD con palabra clave no necesita cuerpo y las cabeceras bastan', async function () {
  var r = await probe(base + '/colgado', { timeoutMs: 600, keyword: 'x', method: 'HEAD' });
  assert.strictEqual(r.http.error, undefined, JSON.stringify(r.http));
  assert.strictEqual(r.http.status, 200);
});

test('R7 http: cuerpo incompleto (conexión cortada) con palabra clave => error de respuesta incompleta', async function () {
  var r = await probe(base + '/cortado', { timeoutMs: 3000, keyword: 'abc' });
  assert.ok(r.http.error, JSON.stringify(r.http));
  assert.match(r.http.error, /incompleta/);
});

test('R7 http: cuerpo incompleto SIN palabra clave => las cabeceras bastan (status 200)', async function () {
  var r = await probe(base + '/cortado', { timeoutMs: 3000 });
  assert.strictEqual(r.http.error, undefined, JSON.stringify(r.http));
  assert.strictEqual(r.http.status, 200);
});

test('R7 http: palabra clave presente y ausente en un cuerpo completo', async function () {
  assert.strictEqual((await probe(base + '/ok', { timeoutMs: 3000, keyword: 'centinela' })).http.keywordFound, true);
  assert.strictEqual((await probe(base + '/ok', { timeoutMs: 3000, keyword: 'inexistente' })).http.keywordFound, false);
});

test('R7 http: un cuerpo mayor que el tope no es un fallo (ni con palabra clave)', async function () {
  var a = await probe(base + '/enorme', { timeoutMs: 5000 });
  assert.strictEqual(a.http.error, undefined, JSON.stringify(a.http));
  assert.strictEqual(a.http.status, 200);
  var b = await probe(base + '/enorme', { timeoutMs: 5000, keyword: 'zzz' });
  assert.strictEqual(b.http.error, undefined, JSON.stringify(b.http));
  assert.strictEqual(b.http.keywordFound, false);
});

test('R7 http: si el servidor no envía ni cabeceras antes del plazo => error de tiempo agotado', async function () {
  var r = await probe(base + '/sin-cabeceras', { timeoutMs: 600 });
  assert.match(r.http.error || '', /tiempo agotado/);
});

test('R7 http: puerto cerrado => error legible y URL no válida => "URL no válida"', async function () {
  var cerrado = await new Promise(function (res) {
    var s = http.createServer(); s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { res(p); }); });
  });
  var r = await probe('http://127.0.0.1:' + cerrado + '/', { timeoutMs: 2000 });
  assert.match(r.http.error, /rechazada/);
  assert.strictEqual((await probe('no es url', {})).http.error, 'URL no válida');
});
