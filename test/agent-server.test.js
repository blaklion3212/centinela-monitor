'use strict';
/*
 * R7: proceso del agente (agent/agent.js) como hijo en 127.0.0.1 con puerto libre.
 * Una petición malformada (p. ej. "GET //[") debe dar 400 y el agente debe seguir vivo.
 */
var test = require('node:test');
var assert = require('node:assert');
var net = require('net');
var path = require('path');
var spawn = require('child_process').spawn;
var srv = require('./helpers/server');

var AGENT_JS = path.join(__dirname, '..', 'agent', 'agent.js');
var hijo = null, port = 0, log = '';

// Red de seguridad: si el proceso de prueba muere de forma abrupta no quedan agentes huérfanos.
process.on('exit', function () { if (hijo) { try { hijo.kill('SIGKILL'); } catch (e) { /* ya terminó */ } } });

test.before(async function () {
  port = await srv.freePort();
  var env = Object.assign({}, process.env, { CENTINELA_AGENT_TOKEN: 'token-de-prueba-123' });
  hijo = spawn(process.execPath, [AGENT_JS, '--port', String(port), '--host', '127.0.0.1'], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  hijo.stdout.on('data', function (d) { log += d; });
  hijo.stderr.on('data', function (d) { log += d; });
  await new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('El agente no arrancó. Salida:\n' + log)); }, 8000);
    hijo.once('exit', function (c) { clearTimeout(t); reject(new Error('El agente terminó (' + c + '): ' + log)); });
    (function poll() {
      srv.request(port, 'GET', '/health', { headers: { Authorization: 'Bearer token-de-prueba-123' } })
        .then(function () { clearTimeout(t); resolve(); }, function () { setTimeout(poll, 100); });
    })();
  });
});
test.after(function () {
  return new Promise(function (resolve) {
    if (!hijo || hijo.exitCode !== null || hijo.signalCode) return resolve();
    hijo.once('exit', function () { resolve(); });
    hijo.kill('SIGKILL');
  });
});

// Envía bytes crudos y devuelve la respuesta completa hasta que el servidor cierra o pasan 3 s.
function cruda(bytes) {
  return new Promise(function (resolve) {
    var datos = '', s = net.connect(port, '127.0.0.1', function () { s.write(bytes); });
    var t = setTimeout(function () { s.destroy(); }, 3000);
    s.on('data', function (d) { datos += d; });
    s.on('close', function () { clearTimeout(t); resolve(datos); });
    s.on('error', function () { /* se resuelve en close */ });
  });
}
var AUTH = { Authorization: 'Bearer token-de-prueba-123' };
async function sigueVivo() {
  assert.strictEqual(hijo.exitCode, null, 'el proceso del agente sigue en ejecución');
  var r = await srv.request(port, 'GET', '/health', { headers: AUTH });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
}

test('R7 agente: "GET //[" (URL malformada) => 400 y el agente sigue vivo', async function () {
  var r = await cruda('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  assert.match(r, /^HTTP\/1\.1 400 /, 'respuesta: ' + r.slice(0, 80));
  await sigueVivo();
});

test('R7 agente: otras URLs malformadas no lo tumban', async function () {
  for (var p of ['//[', '//[::1', '//%', '///:::', '//a b']) {
    await cruda('GET ' + p + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  }
  await sigueVivo();
});

test('R7 agente: solicitud HTTP basura (clientError) => 400 y sigue vivo', async function () {
  var r = await cruda('ESTO NO ES HTTP\r\n\r\n');
  assert.match(r, /400/);
  await cruda('\x00\x01\x02\xff\r\n\r\n');
  await sigueVivo();
});

test('R7 agente: cliente que corta a mitad de la petición no lo tumba', async function () {
  await new Promise(function (resolve) {
    var s = net.connect(port, '127.0.0.1', function () { s.write('GET /metrics HTTP/1.1\r\nHost: x\r\n'); s.destroy(); });
    s.on('close', resolve); s.on('error', function () {});
  });
  await sigueVivo();
});

test('R7 agente: sin token => 401, método distinto de GET => 405, ruta desconocida => 404', async function () {
  assert.strictEqual((await srv.request(port, 'GET', '/health')).status, 401);
  assert.strictEqual((await srv.request(port, 'POST', '/health', { headers: AUTH, body: {} })).status, 405);
  assert.strictEqual((await srv.request(port, 'GET', '/nada', { headers: AUTH })).status, 404);
  await sigueVivo();
});
