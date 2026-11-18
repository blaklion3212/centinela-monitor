'use strict';
/*
 * Plazo absoluto de la consulta al agente (checks.agentFetch, 10 s): un agente que envía un byte cada ~1 s esquiva el
 * 'timeout' de inactividad del socket (6 s), así que solo el plazo absoluto lo corta. Servidor falso en 127.0.0.2
 * (127.0.0.1/localhost se miden en local con sysmetrics); si el sistema no permite enlazarlo, se omite.
 * Esta prueba dura ~10 s reales: vive en su propio archivo para correr en paralelo con el resto de la suite.
 */
var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var checks = require('../server/lib/checks.js');

var HOST = '127.0.0.2';
var SETTINGS = { thresholds: require('../js/config/defaults.js').SETTINGS.thresholds };
var cierres = [];
test.after(function () { cierres.forEach(function (f) { f(); }); });

function puedeEnlazar(ip) {
  return new Promise(function (resolve) {
    var s = http.createServer();
    s.once('error', function () { resolve(false); });
    s.listen(0, ip, function () { s.close(function () { resolve(true); }); });
  });
}
function esperar(cond, ms, motivo) {
  return new Promise(function (resolve, reject) {
    var fin = Date.now() + ms;
    (function poll() {
      if (cond()) return resolve();
      if (Date.now() > fin) return reject(new Error('plazo agotado esperando: ' + motivo));
      setTimeout(poll, 25);
    })();
  });
}

test('Plazo del agente: un agente con goteo (1 byte/s) se corta a los 10 s con "El agente tardó demasiado en responder" y el socket se destruye', async function (t) {
  if (!(await puedeEnlazar(HOST))) return t.skip('no se puede enlazar ' + HOST + ' en este sistema');
  var estado = { conexiones: 0, cerradas: 0, bytes: 0 }, socks = new Set(), gotero = null;
  var s = http.createServer(function (req, res) {
    // Cabeceras ya enviadas y luego un byte por segundo: nunca hay 6 s de inactividad ni se completa el cuerpo.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
    estado.bytes++;
    gotero = setInterval(function () { estado.bytes++; res.write(' '); }, 1000);
    res.on('close', function () { clearInterval(gotero); });
  });
  s.on('connection', function (c) {
    estado.conexiones++; socks.add(c);
    c.on('close', function () { estado.cerradas++; socks.delete(c); });
    c.on('error', function () { /* el cliente lo destruye */ });
  });
  await new Promise(function (r) { s.listen(0, HOST, r); });
  cierres.push(function () { clearInterval(gotero); socks.forEach(function (c) { c.destroy(); }); s.close(); });

  var objetivo = { id: 'ag-goteo', name: 'goteo', kind: 'host', address: HOST, enabled: true,
                   checks: { ping: false, ports: [], ssl: false, agent: { enabled: true, port: s.address().port, token: 'tok', tls: false, services: [] } } };
  var ini = Date.now();
  var r = await checks.checkTarget(objetivo, SETTINGS);
  var dur = Date.now() - ini;
  assert.strictEqual(r.agent.error, 'El agente tardó demasiado en responder', JSON.stringify(r.agent));
  assert.strictEqual(r.agent.cpu, undefined, 'sin datos parciales');
  assert.ok(dur >= 9500 && dur < 13000, 'el corte llega cerca de los 10 s, no a los 6 s de inactividad ni más tarde: ' + dur + ' ms');
  assert.ok(estado.bytes >= 5, 'el agente sí iba enviando bytes (el goteo evitó el timeout de inactividad): ' + estado.bytes);
  await esperar(function () { return estado.cerradas === estado.conexiones && estado.conexiones === 1; }, 3000, 'el socket del agente quedó destruido');
  var antes = estado.bytes;
  await new Promise(function (res) { setTimeout(res, 1500); }); // control negativo: ya no debe seguir goteando
  assert.strictEqual(estado.bytes, antes, 'tras la destrucción del socket no se envía nada más');
});
