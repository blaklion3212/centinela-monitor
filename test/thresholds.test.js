'use strict';
/*
 * Umbrales compartidos (js/shared/thresholds.js, módulo UMD). Se comprueba la interfaz pública, su coherencia con
 * js/config/defaults.js (SETTINGS.thresholds) y la carga dual: con require (servidor) y en un contexto vm que simula
 * el navegador (window.NOC.Thresholds).
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var RUTA = path.join(__dirname, '..', 'js', 'shared', 'thresholds.js');
var T = require(RUTA);

function cargarDefaults() {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'config', 'defaults.js'), 'utf8'), ctx, { filename: 'defaults.js' });
  return ctx;
}

test('TH-01 carga con require: expone la API pública', function () {
  ['PAIRS', 'byId', 'isPositiveWarn', 'isOrdered', 'thresholdLabel', 'orderMessage'].forEach(function (k) {
    assert.ok(T[k] !== undefined, k);
  });
  assert.ok(Array.isArray(T.PAIRS));
});

test('TH-02 carga como navegador (vm sin module): crea window.NOC.Thresholds y conserva NOC previo', function () {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('var NOC = { previo: 1 };', ctx);
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx, { filename: 'thresholds.js' });
  assert.strictEqual(ctx.NOC.previo, 1, 'no pisa el NOC existente');
  assert.ok(ctx.NOC.Thresholds);
  assert.strictEqual(ctx.NOC.Thresholds.PAIRS.length, T.PAIRS.length);
  assert.strictEqual(ctx.NOC.Thresholds.isOrdered(ctx.NOC.Thresholds.byId('ssl'), 30, 7), true);
});

test('TH-03 carga como navegador sin NOC previo: lo crea', function () {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx);
  assert.strictEqual(typeof ctx.NOC, 'object');
  assert.strictEqual(typeof ctx.NOC.Thresholds.thresholdLabel, 'function');
});

test('TH-04 carga como navegador con self definido (hilo de trabajo): usa self', function () {
  var ctx = { console: console };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(RUTA, 'utf8'), ctx);
  assert.ok(ctx.NOC && ctx.NOC.Thresholds);
});

test('TH-05 PAIRS: 9 pares con id, label, warn, crit e inverted booleano, sin duplicados', function () {
  assert.strictEqual(T.PAIRS.length, 9);
  var ids = {}, claves = {};
  T.PAIRS.forEach(function (p) {
    assert.ok(p.id && p.label && p.warn && p.crit);
    assert.strictEqual(typeof p.inverted, 'boolean');
    assert.ok(!ids[p.id], 'id repetido ' + p.id); ids[p.id] = 1;
    assert.ok(!claves[p.warn] && !claves[p.crit]); claves[p.warn] = claves[p.crit] = 1;
  });
});

test('TH-06 PAIRS: las claves coinciden exactamente con SETTINGS.thresholds de defaults.js', function () {
  var ctx = cargarDefaults();
  var th = buscarThresholds(ctx.NOC);
  assert.ok(th, 'no se halló SETTINGS.thresholds en defaults.js');
  var deP = [];
  T.PAIRS.forEach(function (p) { deP.push(p.warn, p.crit); });
  assert.deepStrictEqual(deP.slice().sort(), Object.keys(th).sort());
});

function buscarThresholds(o, prof) {
  prof = prof || 0;
  if (!o || typeof o !== 'object' || prof > 4) return null;
  if (o.thresholds && typeof o.thresholds === 'object' && 'latencyWarnMs' in o.thresholds) return o.thresholds;
  for (var k in o) {
    var r = buscarThresholds(o[k], prof + 1);
    if (r) return r;
  }
  return null;
}

test('TH-07 PAIRS: los valores por defecto de cada par respetan su orden (SSL invertido)', function () {
  var th = buscarThresholds(cargarDefaults().NOC);
  T.PAIRS.forEach(function (p) {
    assert.ok(T.isOrdered(p, th[p.warn], th[p.crit]), p.id + ' por defecto fuera de orden');
  });
});

test('TH-08 solo el par SSL está invertido', function () {
  var inv = T.PAIRS.filter(function (p) { return p.inverted; }).map(function (p) { return p.id; });
  assert.deepStrictEqual(inv, ['ssl']);
});

test('TH-09 byId devuelve el par o null si no existe', function () {
  assert.strictEqual(T.byId('cpu').crit, 'cpuCritPct');
  assert.strictEqual(T.byId('ioWait').warn, 'ioWaitWarnPct');
  assert.strictEqual(T.byId('nada'), null);
  assert.strictEqual(T.byId(undefined), null);
  assert.strictEqual(T.byId(''), null);
});

test('TH-10 isPositiveWarn: avisos y críticos en Ms o Pct sí; días no', function () {
  assert.strictEqual(T.isPositiveWarn('latencyWarnMs'), true);
  assert.strictEqual(T.isPositiveWarn('lossWarnPct'), true);
  assert.strictEqual(T.isPositiveWarn('sslWarnDays'), false);
  assert.strictEqual(T.isPositiveWarn('sslCritDays'), false);
  assert.strictEqual(T.isPositiveWarn('latencyCritMs'), false);
  assert.strictEqual(T.isPositiveWarn('cpuCritPct'), false);
  assert.strictEqual(T.isPositiveWarn(''), false);
  assert.strictEqual(T.isPositiveWarn('otraCosa'), false);
});

test('TH-11 isPositiveWarn: el sufijo debe estar al final', function () {
  assert.strictEqual(T.isPositiveWarn('latencyWarnMsX'), false);
  assert.strictEqual(T.isPositiveWarn('WarnMs'), true);
});

test('TH-12 isOrdered normal: aviso < crítico; iguales o invertidos no', function () {
  var p = T.byId('latency');
  assert.strictEqual(T.isOrdered(p, 150, 400), true);
  assert.strictEqual(T.isOrdered(p, 400, 400), false, 'iguales');
  assert.strictEqual(T.isOrdered(p, 500, 400), false, 'invertidos');
  assert.strictEqual(T.isOrdered(p, 0, 1), true);
  assert.strictEqual(T.isOrdered(p, -1, 0), true);
});

test('TH-13 isOrdered SSL: aviso > crítico; iguales o al revés no', function () {
  var p = T.byId('ssl');
  assert.strictEqual(T.isOrdered(p, 30, 7), true);
  assert.strictEqual(T.isOrdered(p, 7, 7), false, 'iguales');
  assert.strictEqual(T.isOrdered(p, 7, 30), false, 'orden de pares normales en SSL');
});

test('TH-14 isOrdered con valores no numéricos: NaN, undefined y null no cumplen el orden estricto', function () {
  var p = T.byId('cpu'), s = T.byId('ssl');
  assert.strictEqual(T.isOrdered(p, NaN, 90), false);
  assert.strictEqual(T.isOrdered(p, 10, NaN), false);
  assert.strictEqual(T.isOrdered(p, undefined, 90), false);
  assert.strictEqual(T.isOrdered(p, 10, undefined), false);
  assert.strictEqual(T.isOrdered(s, NaN, 7), false);
  assert.strictEqual(T.isOrdered(s, 30, undefined), false);
});

test('TH-15 isOrdered con textos usa la comparación de JS: documenta la coerción numérica y la léxica', function () {
  var p = T.byId('cpu');
  assert.strictEqual(T.isOrdered(p, '5', '10'), false, 'dos textos se comparan en orden léxico: "5" > "10"');
  assert.strictEqual(T.isOrdered(p, 5, '10'), true, 'número y texto se coaccionan a número');
  assert.strictEqual(T.isOrdered(p, 'abc', 'abd'), true);
});

test('TH-16 thresholdLabel: etiqueta en español para claves conocidas, aviso y crítico', function () {
  assert.strictEqual(T.thresholdLabel('lossWarnPct'), 'Pérdida de paquetes (aviso)');
  assert.strictEqual(T.thresholdLabel('sslCritDays'), 'SSL: días restantes (crítico)');
  assert.strictEqual(T.thresholdLabel('latencyWarnMs'), 'Latencia (aviso)');
  assert.strictEqual(T.thresholdLabel('ioWaitCritPct'), 'I/O wait (crítico)');
});

test('TH-17 thresholdLabel: toda clave de PAIRS tiene etiqueta distinta de la clave', function () {
  T.PAIRS.forEach(function (p) {
    assert.strictEqual(T.thresholdLabel(p.warn), p.label + ' (aviso)');
    assert.strictEqual(T.thresholdLabel(p.crit), p.label + ' (crítico)');
  });
});

test('TH-18 thresholdLabel: claves desconocidas o mal formadas se devuelven tal cual', function () {
  assert.strictEqual(T.thresholdLabel('desconocidaWarnMs'), 'desconocidaWarnMs');
  assert.strictEqual(T.thresholdLabel('latencyWarn'), 'latencyWarn');
  assert.strictEqual(T.thresholdLabel('latencyWarnSeg'), 'latencyWarnSeg');
  assert.strictEqual(T.thresholdLabel(''), '');
  assert.strictEqual(T.thresholdLabel('WarnMs'), 'WarnMs', 'id vacío no existe');
});

test('TH-19 thresholdLabel: no se confunde con propiedades heredadas del objeto (constructor, toString)', function () {
  assert.strictEqual(T.thresholdLabel('constructorWarnMs'), 'constructorWarnMs');
  assert.strictEqual(T.thresholdLabel('__proto__CritPct'), '__proto__CritPct');
  assert.strictEqual(T.byId('constructor'), null, 'byId no debe devolver Object.prototype.constructor');
  assert.strictEqual(T.byId('toString'), null);
});

test('TH-20 orderMessage normal: pide aviso menor que crítico e incluye etiqueta y valores', function () {
  var m = T.orderMessage(T.byId('latency'), 500, 400);
  assert.strictEqual(m, 'En "Latencia" el aviso (500) debe ser menor que el crítico (400).');
});

test('TH-21 orderMessage SSL: pide aviso mayor que crítico y explica los días de margen', function () {
  var m = T.orderMessage(T.byId('ssl'), 5, 7);
  assert.strictEqual(m, 'En "SSL: días restantes" el aviso (5) debe ser mayor que el crítico (7): se avisa con más días de margen.');
});

test('TH-22 orderMessage con valores no numéricos no lanza y los muestra como texto', function () {
  assert.doesNotThrow(function () { T.orderMessage(T.byId('cpu'), undefined, 'x'); });
  assert.ok(T.orderMessage(T.byId('cpu'), undefined, 'x').indexOf('(undefined)') > 0);
});
