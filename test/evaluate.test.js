'use strict';
/* R1: lógica de estado (UP / DEGRADADO / DOWN) de js/core/evaluate.js. */
var test = require('node:test');
var assert = require('node:assert');
var E = require('../js/core/evaluate.js');
var Defaults = require('../js/config/defaults.js');

var TH = Defaults.SETTINGS.thresholds;
var PING_LOST = { sent: 4, received: 0, lossPct: 100 };
function pingOk(o) { return Object.assign({ sent: 4, received: 4, lossPct: 0, avg: 20, jitter: 2 }, o || {}); }
function tgt(extra) { return Object.assign({ checks: { ping: true } }, extra || {}); }

test('R1: ping 0/4 + HTTP 200 dentro de lo esperado no es DOWN (solo aviso ICMP)', function () {
  var t = tgt({ kind: 'url', checks: { ping: true, http: { expectedStatus: '200-399' } } });
  var r = E.evaluate(t, { ping: PING_LOST, http: { status: 200 } }, TH);
  assert.notStrictEqual(r.status, 'down');
  assert.strictEqual(r.status, 'up');
  var icmp = r.reasons.filter(function (x) { return x.code === 'icmp'; })[0];
  assert.ok(icmp, 'debe quedar el aviso de ICMP');
  assert.strictEqual(icmp.level, 'info');
  assert.strictEqual(icmp.down, false);
});

test('R1: ping 0/4 + HTTP 500 es DOWN', function () {
  var t = tgt({ kind: 'url', checks: { ping: true, http: { expectedStatus: '200-399' } } });
  var r = E.evaluate(t, { ping: PING_LOST, http: { status: 500 } }, TH);
  assert.strictEqual(r.status, 'down');
});

test('R1: ping 0/4 + HTTP con error de conexión es DOWN', function () {
  var t = tgt({ kind: 'url', checks: { ping: true, http: { expectedStatus: '200-399' } } });
  var r = E.evaluate(t, { ping: PING_LOST, http: { error: 'conexión rechazada' } }, TH);
  assert.strictEqual(r.status, 'down');
});

test('R1: ping 0/4 + HTTP 200 pero fuera del esperado (solo 204) es DOWN', function () {
  var t = tgt({ kind: 'url', checks: { ping: true, http: { expectedStatus: '204' } } });
  var r = E.evaluate(t, { ping: PING_LOST, http: { status: 200 } }, TH);
  assert.strictEqual(r.status, 'down');
});

test('R1: ping 0/4 + puerto abierto no es DOWN', function () {
  var t = tgt({ checks: { ping: true, ports: [22] } });
  var r = E.evaluate(t, { ping: PING_LOST, ports: [{ port: 22, open: true }] }, TH);
  assert.notStrictEqual(r.status, 'down');
});

test('R1: ping 0/4 + puerto cerrado es DOWN', function () {
  var t = tgt({ checks: { ping: true, ports: [22] } });
  var r = E.evaluate(t, { ping: PING_LOST, ports: [{ port: 22, open: false }] }, TH);
  assert.strictEqual(r.status, 'down');
});

test('R1: ping 0/4 sin otra evidencia es DOWN', function () {
  var r = E.evaluate(tgt(), { ping: PING_LOST }, TH);
  assert.strictEqual(r.status, 'down');
});

test('R1: ping sano => UP', function () {
  var r = E.evaluate(tgt(), { ping: pingOk() }, TH);
  assert.strictEqual(r.status, 'up');
  assert.deepStrictEqual(r.reasons, []);
});

test('R1: latencia sobre el umbral de aviso => DEGRADADO; sobre el crítico también (no DOWN)', function () {
  var w = E.evaluate(tgt(), { ping: pingOk({ avg: TH.latencyWarnMs }) }, TH);
  assert.strictEqual(w.status, 'degraded');
  var c = E.evaluate(tgt(), { ping: pingOk({ avg: TH.latencyCritMs + 1 }) }, TH);
  assert.strictEqual(c.status, 'degraded');
  assert.ok(c.reasons.some(function (x) { return x.level === 'crit'; }));
});

test('R1: pérdida parcial y jitter alto => DEGRADADO', function () {
  var l = E.evaluate(tgt(), { ping: pingOk({ received: 3, lossPct: 25 }) }, TH);
  assert.strictEqual(l.status, 'degraded');
  var j = E.evaluate(tgt(), { ping: pingOk({ jitter: TH.jitterWarnMs }) }, TH);
  assert.strictEqual(j.status, 'degraded');
});

test('R1: justo bajo el umbral de aviso => UP', function () {
  var r = E.evaluate(tgt(), { ping: pingOk({ avg: TH.latencyWarnMs - 0.1, lossPct: TH.lossWarnPct - 0.1, received: 4 }) }, TH);
  assert.strictEqual(r.status, 'up');
});

test('R1: sin datos medidos => UNKNOWN', function () {
  assert.strictEqual(E.evaluate(tgt(), {}, TH).status, 'unknown');
});

test('R1: ping no disponible en el servidor no marca DOWN', function () {
  var r = E.evaluate(tgt(), { ping: { unavailable: true, sent: 4, received: 0 }, ports: [{ port: 80, open: true }] }, TH);
  assert.strictEqual(r.status, 'up');
});

test('R1: DNS con error => DOWN', function () {
  var r = E.evaluate(tgt(), { dns: { error: 'nombre no encontrado' } }, TH);
  assert.strictEqual(r.status, 'down');
});

test('R1: HTTP con TTFB alto => DEGRADADO; texto esperado ausente => DOWN', function () {
  var t = tgt({ kind: 'url', checks: { ping: false, http: { expectedStatus: '200-399' } } });
  assert.strictEqual(E.evaluate(t, { http: { status: 200, ttfbMs: TH.ttfbWarnMs } }, TH).status, 'degraded');
  assert.strictEqual(E.evaluate(t, { http: { status: 200, keywordFound: false } }, TH).status, 'down');
});

test('R1: certificado vencido => DOWN; por vencer => DEGRADADO', function () {
  var t = tgt({ checks: { ping: false } });
  assert.strictEqual(E.evaluate(t, { ssl: { daysLeft: -1 } }, TH).status, 'down');
  assert.strictEqual(E.evaluate(t, { ssl: { daysLeft: TH.sslWarnDays } }, TH).status, 'degraded');
  assert.strictEqual(E.evaluate(t, { ssl: { daysLeft: 365 } }, TH).status, 'up');
});

test('R1: statusMatches interpreta rangos y listas', function () {
  assert.strictEqual(E.statusMatches(200, '200-399'), true);
  assert.strictEqual(E.statusMatches(401, '200-399,401'), true);
  assert.strictEqual(E.statusMatches(500, '200-399,401'), false);
  assert.strictEqual(E.statusMatches('200', '200-399'), false);
  assert.strictEqual(E.statusMatches(200, undefined), true);
});

test('R1: worst elige el peor estado', function () {
  assert.strictEqual(E.worst(['up', 'degraded', 'down']), 'down');
  assert.strictEqual(E.worst(['up', 'degraded']), 'degraded');
  assert.strictEqual(E.worst([]), 'unknown');
});
