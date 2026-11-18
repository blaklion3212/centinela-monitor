'use strict';
/*
 * R7: consulta al agente remoto (server/lib/checks.js: agentFetch + normalizeAgent) vía checkTarget,
 * contra un servidor HTTP local. Se usa 127.0.0.2 porque 127.0.0.1/localhost se miden en local (sysmetrics).
 */
var test = require('node:test');
var assert = require('node:assert');
var http = require('http');
var checks = require('../server/lib/checks.js');

var HOST = '127.0.0.2';
var SETTINGS = { thresholds: require('../js/config/defaults.js').SETTINGS.thresholds };
var servidor = null, port = 0, handler = null, vistos = [], disponible = true;

test.before(function () {
  return new Promise(function (resolve) {
    servidor = http.createServer(function (req, res) { vistos.push(req); handler(req, res); });
    servidor.on('error', function () { disponible = false; resolve(); });
    servidor.listen(0, HOST, function () { port = servidor.address().port; resolve(); });
  });
});
test.after(function () { if (servidor && servidor.listening) { servidor.closeAllConnections && servidor.closeAllConnections(); servidor.close(); } });

function objetivo(token) {
  return { id: 'ag1', name: 'agente', kind: 'host', address: HOST, enabled: true,
           checks: { ping: false, ports: [], ssl: false, agent: { enabled: true, port: port, token: token || '', services: ['nginx'] } } };
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function omitir(t) { if (!disponible) { t.skip('no se pudo enlazar ' + HOST + ' en este sistema'); return true; } return false; }

test('R7: respuesta correcta se normaliza y llega a r.agent', async function (t) {
  if (omitir(t)) return;
  handler = function (req, res) {
    json(res, 200, { ts: 1, hostname: 'srv', platform: 'linux', uptimeSec: 100,
      cpu: { usagePct: 12.5, ioWaitPct: 1, cores: 4, load: [0.1, 0.2, 0.3] }, mem: { totalMb: 1000, usedMb: 500, usedPct: 50 },
      disks: [{ mount: '/', fs: 'ext4', totalGb: 10, usedGb: 5, usedPct: 50 }], net: { rxBps: 10, txBps: 20 },
      services: [{ name: 'nginx', active: true }] });
  };
  var r = await checks.checkTarget(objetivo(), SETTINGS);
  assert.strictEqual(r.agent.error, undefined);
  assert.strictEqual(r.agent.cpu.cores, 4);
  assert.strictEqual(r.agent.disks[0].mount, '/');
  assert.strictEqual(r.agent.services[0].active, true);
  assert.strictEqual(r.status, 'up');
  assert.match(vistos[vistos.length - 1].url, /^\/metrics\?services=nginx$/);
});

test('R7: campos basura se normalizan (cores no numérico => null, disks no array => [])', async function (t) {
  if (omitir(t)) return;
  handler = function (req, res) {
    json(res, 200, { hostname: { x: 1 }, platform: 42, uptimeSec: 'mucho',
      cpu: { usagePct: 'alto', ioWaitPct: null, cores: 'ocho', load: 'no-es-lista' },
      mem: 'texto', disks: 'no-es-lista', net: 'x', services: { a: 1 } });
  };
  var r = await checks.checkTarget(objetivo(), SETTINGS);
  assert.strictEqual(r.agent.error, undefined);
  assert.strictEqual(r.agent.cpu.cores, null);
  assert.strictEqual(r.agent.cpu.usagePct, null);
  assert.deepStrictEqual(r.agent.cpu.load, []);
  assert.deepStrictEqual(r.agent.disks, []);
  assert.deepStrictEqual(r.agent.services, []);
  assert.strictEqual(r.agent.uptimeSec, null);
  assert.strictEqual(r.agent.hostname, '');
  assert.strictEqual(r.agent.platform, '');
  assert.strictEqual(r.agent.mem.usedPct, null);
  assert.strictEqual(r.agent.net, null);
});

test('R7: elementos basura dentro de disks/services se filtran y los textos largos se recortan', async function (t) {
  if (omitir(t)) return;
  handler = function (req, res) {
    json(res, 200, { cpu: {}, mem: {}, disks: [null, 5, 'x', { mount: 'M'.repeat(500), usedPct: '90' }],
      services: [null, { name: 'a', active: 'true' }, { name: 'b', active: true }] });
  };
  var r = await checks.checkTarget(objetivo(), SETTINGS);
  assert.strictEqual(r.agent.disks.length, 1);
  assert.strictEqual(r.agent.disks[0].mount.length, 200);
  assert.strictEqual(r.agent.disks[0].usedPct, null);
  assert.deepStrictEqual(r.agent.services.map(function (s) { return s.active; }), [false, true]);
});

test('R7: JSON que no es un objeto o no es JSON => error de respuesta no válida', async function (t) {
  if (omitir(t)) return;
  handler = function (req, res) { json(res, 200, [1, 2, 3]); };
  assert.match((await checks.checkTarget(objetivo(), SETTINGS)).agent.error, /no válida/);
  handler = function (req, res) { res.writeHead(200); res.end('<html>no soy json</html>'); };
  assert.match((await checks.checkTarget(objetivo(), SETTINGS)).agent.error, /no válida/);
});

test('R7: códigos 401, 429 y 500 producen errores descriptivos y se envía el token Bearer', async function (t) {
  if (omitir(t)) return;
  handler = function (req, res) { json(res, 401, {}); };
  assert.match((await checks.checkTarget(objetivo('tok-123'), SETTINGS)).agent.error, /token rechazado/);
  assert.strictEqual(vistos[vistos.length - 1].headers.authorization, 'Bearer tok-123');
  handler = function (req, res) { json(res, 429, {}); };
  assert.match((await checks.checkTarget(objetivo(), SETTINGS)).agent.error, /limit/);
  handler = function (req, res) { json(res, 500, {}); };
  assert.match((await checks.checkTarget(objetivo(), SETTINGS)).agent.error, /HTTP 500/);
});

test('R7: sin token no se envía cabecera Authorization', async function (t) {
  if (omitir(t)) return;
  handler = function (req, res) { json(res, 200, { cpu: {}, mem: {} }); };
  await checks.checkTarget(objetivo(''), SETTINGS);
  assert.strictEqual(vistos[vistos.length - 1].headers.authorization, undefined);
});

test('R7: conexión cortada a mitad del cuerpo resuelve con error en menos de 10 s', async function (t) {
  if (omitir(t)) return;
  handler = function (req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '5000' });
    res.write('{"cpu":{"usagePct":');
    setTimeout(function () { req.socket.destroy(); }, 50);
  };
  var t0 = Date.now();
  var r = await checks.checkTarget(objetivo(), SETTINGS);
  assert.ok(Date.now() - t0 < 10000, 'tardó ' + (Date.now() - t0) + ' ms');
  assert.ok(r.agent && r.agent.error, 'debe haber error: ' + JSON.stringify(r.agent));
  // Un fallo del agente degrada pero no marca DOWN.
  assert.strictEqual(r.status, 'degraded');
});

test('R7: cuerpo mayor de 1 MB se corta con error', async function (t) {
  if (omitir(t)) return;
  handler = function (req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(Buffer.alloc(1024 * 1024 + 10, 0x20));
    res.end(Buffer.alloc(1024, 0x20));
  };
  var r = await checks.checkTarget(objetivo(), SETTINGS);
  assert.match(r.agent.error, /demasiado grande/);
});

test('R7: puerto sin servicio => error de conexión rechazada (no cuelga)', async function (t) {
  if (omitir(t)) return;
  var o = objetivo();
  var libre = await new Promise(function (res) {
    var s = http.createServer(); s.listen(0, HOST, function () { var p = s.address().port; s.close(function () { res(p); }); });
  });
  o.checks.agent.port = libre;
  var r = await checks.checkTarget(o, SETTINGS);
  assert.match(r.agent.error, /rechazada/);
});
