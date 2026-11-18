'use strict';
/* R8: analizadores de salidas de ping/traceroute y utilidades de estadística. */
var test = require('node:test');
var assert = require('node:assert');
var path = require('path');

var PING_PATH = require.resolve('../server/probes/ping.js');

// ping.js fija la plataforma al cargarse: se carga una copia para cada sistema simulando process.platform.
function loadPing(platform) {
  var original = Object.getOwnPropertyDescriptor(process, 'platform');
  delete require.cache[PING_PATH];
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return require(PING_PATH); }
  finally { Object.defineProperty(process, 'platform', original); delete require.cache[PING_PATH]; }
}
var linux = loadPing('linux');
var win = loadPing('win32');

var LINUX_OK = [
  'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.',
  '64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms',
  '64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=13.9 ms',
  '64 bytes from 8.8.8.8: icmp_seq=3 ttl=117 time=0.045 ms',
  '64 bytes from 8.8.8.8: icmp_seq=4 ttl=117 time=15.1 ms',
  '',
  '--- 8.8.8.8 ping statistics ---',
  '4 packets transmitted, 4 received, 0% packet loss, time 3004ms',
  'rtt min/avg/max/mdev = 0.045/10.8/15.1/6.2 ms', ''
].join('\n');

test('R8: ping Linux iputils con 4/4 respuestas', function () {
  var r = linux.parse(LINUX_OK, 4);
  assert.deepStrictEqual(r.samples, [14.2, 13.9, 0.045, 15.1]);
  assert.strictEqual(r.ttl, 117);
});

test('R8: ping Linux con pérdida parcial respeta la posición por icmp_seq', function () {
  var out = [
    'PING 10.0.0.9 (10.0.0.9) 56(84) bytes of data.',
    '64 bytes from 10.0.0.9: icmp_seq=1 ttl=64 time=1.20 ms',
    '64 bytes from 10.0.0.9: icmp_seq=3 ttl=64 time=1.40 ms',
    '--- 10.0.0.9 ping statistics ---',
    '4 packets transmitted, 2 received, 50% packet loss, time 3070ms'
  ].join('\n');
  assert.deepStrictEqual(linux.parse(out, 4).samples, [1.2, null, 1.4, null]);
});

test('R8: ping Linux sin respuestas (100 % pérdida) => todas null y ttl null', function () {
  var out = 'PING 10.9.9.9 (10.9.9.9) 56(84) bytes of data.\n\n--- 10.9.9.9 ping statistics ---\n4 packets transmitted, 0 received, 100% packet loss, time 3070ms\n';
  var r = linux.parse(out, 4);
  assert.deepStrictEqual(r.samples, [null, null, null, null]);
  assert.strictEqual(r.ttl, null);
});

test('R8: ping Linux con icmp_seq que empieza en 0 (busybox) se alinea bien', function () {
  var out = '64 bytes from 1.1.1.1: seq=0 ttl=57 time=9.8 ms\n'.replace('seq=0', 'icmp_seq=0') +
            '64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=10.1 ms\n';
  assert.deepStrictEqual(linux.parse(out, 2).samples, [9.8, 10.1]);
});

test('R8: ping Linux ignora errores de red y líneas ajenas (Destination Host Unreachable)', function () {
  var out = 'PING 192.168.9.9 (192.168.9.9) 56(84) bytes of data.\nFrom 192.168.1.2 icmp_seq=1 Destination Host Unreachable\nFrom 192.168.1.2 icmp_seq=2 Destination Host Unreachable\n';
  assert.deepStrictEqual(linux.parse(out, 2).samples, [null, null]);
});

test('R8: ping Linux no desborda el arreglo si hay más respuestas que muestras', function () {
  var out = '64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms\n64 bytes from 8.8.8.8: icmp_seq=9 ttl=117 time=1 ms\n';
  assert.deepStrictEqual(linux.parse(out, 2).samples, [14.2, null]);
});

test('R8: ping Windows (inglés) con pérdida y time<1ms', function () {
  var out = [
    '', 'Pinging 8.8.8.8 with 32 bytes of data:',
    'Reply from 8.8.8.8: bytes=32 time=14ms TTL=117',
    'Request timed out.',
    'Reply from 8.8.8.8: bytes=32 time<1ms TTL=117',
    'Reply from 8.8.8.8: bytes=32 time=15ms TTL=117',
    '', 'Ping statistics for 8.8.8.8:',
    '    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),',
    'Approximate round trip times in milli-seconds:',
    '    Minimum = 0ms, Maximum = 15ms, Average = 9ms', ''
  ].join('\r\n');
  var r = win.parse(out, 4);
  assert.deepStrictEqual(r.samples, [14, null, 0.5, 15]);
  assert.strictEqual(r.ttl, 117);
});

test('R8: ping Windows (español) con tiempo de espera agotado', function () {
  var out = [
    '', 'Haciendo ping a 8.8.8.8 con 32 bytes de datos:',
    'Respuesta desde 8.8.8.8: bytes=32 tiempo=21ms TTL=116',
    'Tiempo de espera agotado para esta solicitud.',
    'Tiempo de espera agotado para esta solicitud.',
    'Respuesta desde 8.8.8.8: bytes=32 tiempo=22ms TTL=116', ''
  ].join('\r\n');
  var r = win.parse(out, 4);
  assert.deepStrictEqual(r.samples, [21, null, null, 22]);
  assert.strictEqual(r.ttl, 116);
});

test('R8: ping Windows con destino inaccesible cuenta como muestra perdida', function () {
  var out = 'Pinging 10.9.9.9 with 32 bytes of data:\r\nReply from 192.168.1.1: Destination host unreachable.\r\nRequest timed out.\r\n';
  assert.deepStrictEqual(win.parse(out, 2).samples, [null, null]);
});

/* ---------- traceroute ---------- */
var tr = require('../server/probes/traceroute.js');

test('R8: parseTraceroute (Linux, -n) con salto sin respuesta y pérdida parcial', function () {
  var out = [
    'traceroute to 8.8.8.8 (8.8.8.8), 20 hops max, 60 byte packets',
    ' 1  192.168.1.1  1.234 ms  1.100 ms  1.050 ms',
    ' 2  * * *',
    ' 3  10.0.0.1  8.5 ms  9.1 ms *',
    ' 4  8.8.8.8  14.2 ms  14.0 ms  13.8 ms', ''
  ].join('\n');
  var h = tr.parseTraceroute(out);
  assert.strictEqual(h.length, 4);
  assert.deepStrictEqual(h[0], { hop: 1, ip: '192.168.1.1', samples: [1.234, 1.1, 1.05] });
  assert.deepStrictEqual(h[1], { hop: 2, ip: null, samples: [null, null, null] });
  assert.deepStrictEqual(h[2].samples, [8.5, 9.1, null]);
  assert.strictEqual(h[3].ip, '8.8.8.8');
});

test('R8: parseTraceroute con nombres de host entre paréntesis (sin -n)', function () {
  var h = tr.parseTraceroute(' 1  router.lan (192.168.1.1)  0.9 ms  0.8 ms  0.7 ms\n');
  assert.strictEqual(h[0].ip, '192.168.1.1');
  assert.strictEqual(h[0].samples.length, 3);
});

test('R8: parseTraceroute (Windows tracert) con <1 ms y tiempo agotado', function () {
  var out = [
    '', 'Tracing route to dns.google [8.8.8.8]', 'over a maximum of 20 hops:', '',
    '  1    <1 ms    <1 ms    <1 ms  192.168.1.1',
    '  2     *        *        *     Request timed out.',
    '  3    12 ms    11 ms    13 ms  10.0.0.1', '', 'Trace complete.', ''
  ].join('\r\n');
  var h = tr.parseTraceroute(out);
  assert.strictEqual(h.length, 3);
  assert.strictEqual(h[0].ip, '192.168.1.1');
  // "<1 ms" se registra como 0.5, igual que en ping.parse.
  assert.deepStrictEqual(h[0].samples, [0.5, 0.5, 0.5]);
  assert.deepStrictEqual(h[1], { hop: 2, ip: null, samples: [null, null, null] });
  assert.deepStrictEqual(h[2].samples, [12, 11, 13]);
});

test('R8: parseTraceroute con IPv6 y salida vacía o basura', function () {
  var h = tr.parseTraceroute(' 1  2001:db8::1  1.5 ms  1.4 ms  1.6 ms\n');
  assert.strictEqual(h[0].ip, '2001:db8::1');
  assert.deepStrictEqual(tr.parseTraceroute(''), []);
  assert.deepStrictEqual(tr.parseTraceroute('traceroute: unknown host x\n'), []);
});

test('R8: parseTracepath agrupa varias respuestas del mismo salto y reconoce "no reply"', function () {
  var out = [
    ' 1?: [LOCALHOST]                      pmtu 1500',
    ' 1:  192.168.1.1                                           1.234ms',
    ' 1:  192.168.1.1                                           1.100ms',
    ' 2:  no reply',
    ' 3:  10.0.0.1                                              8.500ms asymm  4', ''
  ].join('\n');
  var h = tr.parseTracepath(out);
  assert.strictEqual(h.length, 3);
  assert.deepStrictEqual(h[0], { hop: 1, ip: '192.168.1.1', samples: [1.234, 1.1] });
  assert.deepStrictEqual(h[1], { hop: 2, ip: null, samples: [null] });
  assert.strictEqual(h[2].ip, '10.0.0.1');
});

/* ---------- util.stats ---------- */
var util = require('../server/lib/util.js');

test('R8: stats calcula pérdida, promedio y jitter; sin respuestas devuelve nulos', function () {
  var s = util.stats([10, null, 20, 10]);
  assert.strictEqual(s.sent, 4);
  assert.strictEqual(s.received, 3);
  assert.strictEqual(s.lossPct, 25);
  assert.strictEqual(s.min, 10);
  assert.strictEqual(s.max, 20);
  assert.strictEqual(s.avg, 13.33);
  assert.strictEqual(s.jitter, 10);
  var nada = util.stats([null, null]);
  assert.strictEqual(nada.lossPct, 100);
  assert.strictEqual(nada.avg, null);
  assert.strictEqual(util.stats([5]).jitter, 0);
  assert.strictEqual(util.stats([]).lossPct, 0);
});

// Cantidad de temporizadores activos del proceso (Node >= 17.3; si no existe la API, se omite la comprobación).
function timersActivos() {
  if (typeof process.getActiveResourcesInfo !== 'function') return null;
  return process.getActiveResourcesInfo().filter(function (x) { return x === 'Timeout'; }).length;
}

test('R8: withTimeout rechaza con ETIMEOUT y conserva el mensaje y el valor', async function () {
  await assert.rejects(util.withTimeout(new Promise(function () {}), 20, 'x'), function (e) { return e.code === 'ETIMEOUT' && e.message === 'x'; });
  assert.strictEqual(await util.withTimeout(Promise.resolve(7), 1000), 7);
  await assert.rejects(util.withTimeout(Promise.reject(new Error('original')), 1000), /original/);
});

test('R8: withTimeout no deja temporizadores pendientes (éxito, error original ni vencimiento)', async function (t) {
  var antes = timersActivos();
  if (antes === null) return t.skip('process.getActiveResourcesInfo no existe en este Node');
  // Plazos largos: si el temporizador no se limpiara, seguiría activo después de resolver.
  await util.withTimeout(Promise.resolve(1), 60000);
  await assert.rejects(util.withTimeout(Promise.reject(new Error('x')), 60000));
  await assert.rejects(util.withTimeout(new Promise(function () {}), 15, 'vence'));
  await new Promise(function (r) { setImmediate(r); });
  assert.strictEqual(timersActivos(), antes, 'no debe quedar ningún Timeout nuevo');
});
