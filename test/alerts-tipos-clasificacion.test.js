'use strict';
/*
 * Tipos de alerta seleccionables (2.5.0): clasificación de motivos y claves del estado avisado.
 * Requisitos: RT-01 (mapeo motivo -> tipo), RT-02 (certificado vencido no es «caída»), RT-05 (campo `sub` del evaluador),
 * RT-10 y RT-11 (forma de la clave y recorte de subclaves) y RT-61 (entradas hostiles).
 * Pruebas puras: sin red, sin disco y sin esperas. Se derivan de docs/requisitos/alertas-tipos.md (sección 4) y de la
 * interfaz pública de server/lib/alert-types.js (arquitectura-alertas-tipos.md, sección 2).
 */
var test = require('node:test');
var assert = require('node:assert');
var AT = require('../server/lib/alert-types');
var E = require('../js/core/evaluate.js');
var Defaults = require('../js/config/defaults.js');

var TH = Defaults.SETTINGS.thresholds;

function motivo(code, level, down, sub) {
  var o = { level: level, text: 'texto de ' + code, down: !!down, code: code };
  if (sub !== undefined) o.sub = sub;
  return o;
}

/* =============================================================================================
 * RT-01. Una fila por celda de la tabla
 * ========================================================================================== */

// [descripción, motivo, tipo esperado, subclave esperada, nivel esperado]
var TABLA = [];
['dns', 'ping', 'port', 'http', 'keyword', 'service', 'timeout'].forEach(function (c) {
  TABLA.push(['RT-01 «' + c + '» crit con down:true -> down', motivo(c, 'crit', true), 'down', '', 'on']);
});
TABLA.push(['RT-01 code inventado con down:true -> down', motivo('inventado-xyz', 'crit', true), 'down', '', 'on']);
TABLA.push(['RT-01 code inventado con down:true y nivel warn -> down', motivo('inventado-xyz', 'warn', true), 'down', '', 'on']);
TABLA.push(['RT-01 ssl vencido (sub expired, crit, down:true) -> certExpired', motivo('ssl', 'crit', true, 'expired'), 'certExpired', '', 'on']);
TABLA.push(['RT-01 ssl por vencer warn -> certExpiring warn', motivo('ssl', 'warn', false, 'expiring'), 'certExpiring', '', 'warn']);
TABLA.push(['RT-01 ssl por vencer crit -> certExpiring crit', motivo('ssl', 'crit', false, 'expiring'), 'certExpiring', '', 'crit']);
TABLA.push(['RT-01 ssl-trust warn -> certTrust', motivo('ssl-trust', 'warn', false), 'certTrust', '', 'on']);
['latency', 'loss', 'jitter', 'ttfb'].forEach(function (c) {
  TABLA.push(['RT-01 «' + c + '» crit -> latency con subclave ' + c, motivo(c, 'crit', false), 'latency', c, 'on']);
  TABLA.push(['RT-01 «' + c + '» warn -> other con subclave ' + c, motivo(c, 'warn', false), 'other', c, 'on']);
});
['cpu', 'mem', 'io'].forEach(function (c) {
  TABLA.push(['RT-01 «' + c + '» crit -> resources con subclave ' + c, motivo(c, 'crit', false), 'resources', c, 'on']);
  TABLA.push(['RT-01 «' + c + '» warn -> other con subclave ' + c, motivo(c, 'warn', false), 'other', c, 'on']);
});
TABLA.push(['RT-01 disk warn -> disk con el punto de montaje', motivo('disk', 'warn', false, '/var'), 'disk', '/var', 'warn']);
TABLA.push(['RT-01 disk crit -> disk con el punto de montaje', motivo('disk', 'crit', false, '/var'), 'disk', '/var', 'crit']);
TABLA.push(['RT-01 disk con montaje de Windows -> disk', motivo('disk', 'warn', false, 'C:\\'), 'disk', 'C:\\', 'warn']);
TABLA.push(['RT-01 ssl no legible (warn, sub unreadable) -> other con subclave ssl', motivo('ssl', 'warn', false, 'unreadable'), 'other', 'ssl', 'on']);
TABLA.push(['RT-01 agent warn (agente sin respuesta) -> other con subclave agent', motivo('agent', 'warn', false), 'other', 'agent', 'on']);
TABLA.push(['RT-01 code inventado warn con down:false -> other', motivo('inventado-xyz', 'warn', false), 'other', 'inventado-xyz', 'on']);
TABLA.push(['RT-01 code inventado crit con down:false -> other', motivo('inventado-xyz', 'crit', false), 'other', 'inventado-xyz', 'on']);

TABLA.forEach(function (fila) {
  test(fila[0], function () {
    var k = AT.classify(fila[1]);
    assert.ok(k, 'debe clasificarse');
    assert.strictEqual(k.type, fila[2], 'tipo');
    assert.strictEqual(k.sub || '', fila[3], 'subclave');
    assert.strictEqual(k.level, fila[4], 'nivel de aviso');
  });
});

test('RT-01 level info (icmp) no tiene tipo: classify devuelve null', function () {
  assert.strictEqual(AT.classify(motivo('icmp', 'info', false)), null);
  assert.strictEqual(AT.classify(motivo('inventado-xyz', 'info', false)), null);
});

test('RT-01 / S6 entradas que no son motivos no se clasifican ni lanzan excepciones', function () {
  [null, undefined, 0, 'texto', [], true].forEach(function (x) {
    assert.strictEqual(AT.classify(x), null, JSON.stringify(x));
  });
  assert.strictEqual(AT.classify({}), null);
});

test('RT-01 la familia es «down», el code o «disk|<montaje>» (contrato de classify)', function () {
  assert.strictEqual(AT.classify(motivo('port', 'crit', true)).family, 'down');
  assert.strictEqual(AT.classify(motivo('latency', 'crit', false)).family, 'latency');
  assert.strictEqual(AT.classify(motivo('cpu', 'warn', false)).family, 'cpu');
  assert.strictEqual(AT.classify(motivo('disk', 'warn', false, '/var')).family, 'disk|/var');
  assert.strictEqual(AT.classify(motivo('disk', 'crit', false, '/home')).family, 'disk|/home');
});

test('RT-01 la clasificación es estática: no depende de nada externo y es idempotente', function () {
  var m = motivo('latency', 'crit', false);
  var a = AT.classify(m), b = AT.classify(m);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(m, motivo('latency', 'crit', false), 'no muta el motivo');
});

test('RT-01 un mismo code cambia de tipo según el nivel (latency crit -> latency, warn -> other)', function () {
  assert.strictEqual(AT.classify(motivo('latency', 'crit', false)).type, 'latency');
  assert.strictEqual(AT.classify(motivo('latency', 'warn', false)).type, 'other');
});

test('RT-01 la clasificación coincide con la salida real del evaluador (integración evaluate -> classify)', function () {
  var tgt = { checks: { ping: true } };
  function tipos(raw) { return E.evaluate(tgt, raw, TH).reasons.map(function (x) { var k = AT.classify(x); return k && k.type + (k.sub ? ':' + k.sub : ''); }); }
  assert.deepStrictEqual(tipos({ ssl: { daysLeft: -3 } }), ['certExpired']);
  assert.deepStrictEqual(tipos({ ssl: { daysLeft: 5 } }), ['certExpiring']);
  assert.deepStrictEqual(tipos({ ssl: { daysLeft: 20 } }), ['certExpiring']);
  assert.deepStrictEqual(tipos({ ssl: { daysLeft: 200, authorized: false } }), ['certTrust']);
  assert.deepStrictEqual(tipos({ ssl: { error: 'timeout' } }), ['other:ssl']);
  assert.deepStrictEqual(tipos({ agent: { error: 'x' } }), ['other:agent']);
  assert.deepStrictEqual(tipos({ ping: { sent: 4, received: 4, lossPct: 0, avg: 500, jitter: 1 } }), ['latency:latency']);
  assert.deepStrictEqual(tipos({ ping: { sent: 4, received: 4, lossPct: 0, avg: 200, jitter: 1 } }), ['other:latency']);
  assert.deepStrictEqual(tipos({ ping: { sent: 4, received: 0, lossPct: 100 } }), ['down']);
  assert.deepStrictEqual(tipos({ ping: { sent: 4, received: 4, lossPct: 0, avg: 5, jitter: 1 }, agent: { disks: [{ mount: '/var', usedPct: 91 }] } }), ['disk:/var']);
});

/* =============================================================================================
 * RT-02. Certificado vencido: tipo propio y nunca «down»
 * ========================================================================================== */

test('RT-02 el certificado vencido (down:true) se clasifica solo como certExpired, nunca como down', function () {
  var k = AT.classify(motivo('ssl', 'crit', true, 'expired'));
  assert.strictEqual(k.type, 'certExpired');
  assert.notStrictEqual(k.type, 'down');
});

test('RT-02 un puerto cerrado y un certificado vencido dan dos clasificaciones de tipos distintos', function () {
  var r = E.evaluate({ checks: { ping: true } }, { ports: [{ port: 443, open: false }], ssl: { daysLeft: -1 } }, TH);
  var tipos = r.reasons.map(function (x) { return AT.classify(x).type; }).sort();
  assert.deepStrictEqual(tipos, ['certExpired', 'down']);
});

/* =============================================================================================
 * RT-05. Campo `sub` en js/core/evaluate.js
 * ========================================================================================== */

var TGT = { checks: { ping: true } };
function razon(raw, code) { return E.evaluate(TGT, raw, TH).reasons.filter(function (x) { return x.code === code; }); }

test('RT-05 certificado vencido: sub «expired» y el resto del motivo intacto', function () {
  var m = razon({ ssl: { daysLeft: -4 } }, 'ssl')[0];
  assert.strictEqual(m.sub, 'expired');
  assert.strictEqual(m.level, 'crit');
  assert.strictEqual(m.down, true);
  assert.strictEqual(m.code, 'ssl');
  assert.strictEqual(m.text, 'Certificado vencido hace 4 días');
});

test('RT-05 certificado por vencer en nivel crítico: sub «expiring»', function () {
  var m = razon({ ssl: { daysLeft: TH.sslCritDays } }, 'ssl')[0];
  assert.strictEqual(m.sub, 'expiring');
  assert.strictEqual(m.level, 'crit');
  assert.strictEqual(m.down, false);
});

test('RT-05 certificado por vencer en nivel de advertencia: sub «expiring»', function () {
  var m = razon({ ssl: { daysLeft: TH.sslWarnDays } }, 'ssl')[0];
  assert.strictEqual(m.sub, 'expiring');
  assert.strictEqual(m.level, 'warn');
  assert.strictEqual(m.text, 'Certificado vence en ' + TH.sslWarnDays + ' días');
});

test('RT-05 certificado ilegible: sub «unreadable» y sigue siendo warn sin down', function () {
  var m = razon({ ssl: { error: 'ECONNRESET' } }, 'ssl')[0];
  assert.strictEqual(m.sub, 'unreadable');
  assert.strictEqual(m.level, 'warn');
  assert.strictEqual(m.down, false);
  assert.strictEqual(m.text, 'No se pudo leer el certificado (ECONNRESET)');
});

test('RT-05 disco: sub es el punto de montaje, en nivel warn y crit, con montajes especiales', function () {
  var raw = { agent: { disks: [{ mount: '/var', usedPct: TH.diskWarnPct }, { mount: '/mnt/a b', usedPct: TH.diskCritPct }, { mount: 'D:\\', usedPct: 99 }, { mount: '/ok', usedPct: 10 }] } };
  var m = razon(raw, 'disk');
  assert.deepStrictEqual(m.map(function (x) { return x.sub; }), ['/var', '/mnt/a b', 'D:\\']);
  assert.deepStrictEqual(m.map(function (x) { return x.level; }), ['warn', 'crit', 'crit']);
  assert.strictEqual(m[0].text, 'Disco /var al ' + TH.diskWarnPct + ' %');
});

test('RT-05 el estado no cambia por añadir sub: vencido es DOWN, por vencer y disco son DEGRADED', function () {
  assert.strictEqual(E.evaluate(TGT, { ssl: { daysLeft: -1 } }, TH).status, 'down');
  assert.strictEqual(E.evaluate(TGT, { ssl: { daysLeft: 3 } }, TH).status, 'degraded');
  assert.strictEqual(E.evaluate(TGT, { ssl: { error: 'x' } }, TH).status, 'degraded');
  assert.strictEqual(E.evaluate(TGT, { agent: { disks: [{ mount: '/', usedPct: 99 }] } }, TH).status, 'degraded');
  assert.strictEqual(E.evaluate(TGT, { ssl: { daysLeft: 300 } }, TH).status, 'up');
});

test('RT-05 los demás motivos no llevan sub (campo opcional)', function () {
  var r = E.evaluate({ checks: { ping: true } }, {
    ports: [{ port: 22, open: false }], ping: { sent: 4, received: 4, lossPct: 50, avg: 900, jitter: 90 },
    ssl: { daysLeft: 100, authorized: false, authError: 'self signed' },
    agent: { cpu: { usagePct: 99, ioWaitPct: 50 }, mem: { usedPct: 99 }, services: [{ name: 'nginx', active: false }] }
  }, TH);
  assert.ok(r.reasons.length >= 8);
  r.reasons.forEach(function (x) { assert.strictEqual(x.sub, undefined, 'el motivo «' + x.code + '» no debe llevar sub'); });
});

test('RT-05 el agente sin respuesta y el HTTP no llevan sub', function () {
  assert.strictEqual(razon({ agent: { error: 'caído' } }, 'agent')[0].sub, undefined);
  assert.strictEqual(razon({ http: { error: 'refused' } }, 'http')[0].sub, undefined);
});

/* =============================================================================================
 * RT-10, RT-11, RT-61. Claves: encodeKey y parseKey
 * ========================================================================================== */

test('RT-10 encodeKey: ejemplos del requisito (down, latency|ttfb, disk|%2Fvar, certExpiring)', function () {
  assert.strictEqual(AT.encodeKey('abc123', 'down'), 'abc123|down');
  assert.strictEqual(AT.encodeKey('abc123', 'latency', 'ttfb'), 'abc123|latency|ttfb');
  assert.strictEqual(AT.encodeKey('abc123', 'disk', '/var'), 'abc123|disk|%2Fvar');
  assert.strictEqual(AT.encodeKey('abc123', 'certExpiring'), 'abc123|certExpiring');
});

test('RT-10 encodeKey: una subclave vacía, nula o ausente no añade tercer segmento', function () {
  assert.strictEqual(AT.encodeKey('t1', 'down', ''), 't1|down');
  assert.strictEqual(AT.encodeKey('t1', 'down', null), 't1|down');
  assert.strictEqual(AT.encodeKey('t1', 'down', undefined), 't1|down');
});

test('RT-10 parseKey: ida y vuelta con y sin subclave', function () {
  var p = AT.parseKey('abc123|disk|%2Fvar');
  assert.strictEqual(p.id, 'abc123'); assert.strictEqual(p.type, 'disk'); assert.strictEqual(p.sub, '/var');
  var q = AT.parseKey('abc123|down');
  assert.strictEqual(q.id, 'abc123'); assert.strictEqual(q.type, 'down'); assert.ok(!q.sub);
  ['/var', '/mnt/a b/ñ', 'C:\\Datos', 'ttfb', '/a%b', '日本語'].forEach(function (m) {
    var k = AT.encodeKey('t1', 'disk', m), pp = AT.parseKey(k);
    assert.strictEqual(pp.sub, m, 'ida y vuelta de «' + m + '»');
    assert.strictEqual(pp.type, 'disk'); assert.strictEqual(pp.id, 't1');
  });
});

test('RT-10 parseKey: claves mal formadas devuelven null y no lanzan', function () {
  ['', 'solo', '|down', 'a|b|c|d', 'a|disk|%E0%A4%A', 42, null, undefined, {}, ['a|b']].forEach(function (k) {
    assert.doesNotThrow(function () { AT.parseKey(k); });
    assert.strictEqual(AT.parseKey(k), null, 'clave ' + JSON.stringify(k));
  });
});

test('RT-61 una subclave con «|» no rompe la clave: queda codificada y la clave tiene 3 segmentos', function () {
  var k = AT.encodeKey('t1', 'disk', '/a|b|c');
  assert.strictEqual(k.split('|').length, 3);
  assert.strictEqual(AT.parseKey(k).sub, '/a|b|c');
});

test('RT-61 «<», «%00» literal y comillas se codifican; la clave no contiene caracteres peligrosos', function () {
  var k = AT.encodeKey('t1', 'disk', '/<script>%00"\'');
  var sub = k.split('|')[2];
  assert.ok(!/[<>" ]/.test(sub), 'sin caracteres especiales sin codificar: ' + sub);
  assert.strictEqual(AT.parseKey(k).sub, '/<script>%00"\'');
});

test('RT-61 / RT-11 los caracteres de control (salto de línea, NUL, tabulación, DEL) se limpian de la subclave', function () {
  var k = AT.encodeKey('t1', 'disk', '/a\nb\u0000c\td\u007Fe\u2028f');
  assert.ok(!/%0A|%00|%09|%7F/i.test(k), 'sin controles: ' + k);
  assert.strictEqual(AT.parseKey(k).sub, '/abcdef');
  assert.strictEqual(k.split('|').length, 3);
});

test('RT-11 / RT-61 un punto de montaje de 10 000 caracteres se recorta a 100 antes de codificar y cabe en 200 codificados', function () {
  var largo = new Array(10001).join('x');
  var k = AT.encodeKey('t1', 'disk', largo);
  var sub = k.split('|')[2];
  assert.strictEqual(AT.parseKey(k).sub.length, 100);
  assert.ok(sub.length <= 200);
  // Con caracteres que se expanden al codificar (9 caracteres por carácter) el resultado sigue acotado.
  var k2 = AT.encodeKey('t1', 'disk', new Array(10001).join('日'));
  assert.ok(k2.split('|')[2].length <= 200, 'subclave codificada <= 200: ' + k2.split('|')[2].length);
  assert.notStrictEqual(AT.parseKey(k2), null, 'la clave recortada sigue siendo decodificable');
});

test('RT-61 un sustituto Unicode suelto no hace lanzar encodeURIComponent', function () {
  var k;
  assert.doesNotThrow(function () { k = AT.encodeKey('t1', 'disk', '/a\uD800b'); });
  assert.notStrictEqual(AT.parseKey(k), null);
});

test('RT-61 classify con montajes hostiles no lanza y deja el montaje limpio y acotado en la subclave', function () {
  ['/a|b', '<b>x</b>', '/a\nb', '%00', new Array(10001).join('m')].forEach(function (m) {
    var k;
    assert.doesNotThrow(function () { k = AT.classify(motivo('disk', 'warn', false, m)); });
    assert.strictEqual(k.type, 'disk');
    assert.ok(k.sub.length <= 100, 'subclave <= 100 caracteres');
    assert.ok(!/[\u0000-\u001F]/.test(k.sub), 'sin caracteres de control');
  });
});

/* =============================================================================================
 * Constantes del contrato (sección 3 de los requisitos)
 * ========================================================================================== */

test('RT-01 / sección 3: tipos, orden de las 9 claves, valores por defecto y tipos de degradación', function () {
  assert.deepStrictEqual(AT.NOTIFY_KEYS, ['down', 'recovery', 'certExpired', 'certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other']);
  assert.deepStrictEqual(AT.TYPES, ['down', 'certExpired', 'certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other']);
  assert.deepStrictEqual(AT.DEFAULT_NOTIFY, { down: true, recovery: true, certExpired: true, certExpiring: false, certTrust: false, latency: false, resources: false, disk: false, other: false });
  assert.deepStrictEqual(AT.DEGRADE_TYPES, ['certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other']);
  assert.strictEqual(AT.DISK_HYST_PCT, 2);
});
