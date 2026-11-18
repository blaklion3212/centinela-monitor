'use strict';
/*
 * js/shared/stats.js (NOC.Stats: isSample, round, stats). Carga dual: require (servidor) y vm (navegador, vía U.stats de
 * js/core/util.js). Criterio: solo un número finito es muestra; null, undefined, NaN e Infinity cuentan como pérdida.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var Stats = require('../js/shared/stats.js');
var serverUtil = require('../server/lib/util.js');

function cargarCliente() {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  ['js/shared/stats.js', 'js/core/util.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  });
  return ctx.NOC;
}
var NOC = cargarCliente();

test('ST-01 isSample: solo números finitos', function () {
  [0, 1, -3.5, 1e9, -0].forEach(function (v) { assert.strictEqual(Stats.isSample(v), true, String(v)); });
  [NaN, Infinity, -Infinity, null, undefined, '5', true, {}, [], [1], function () {}].forEach(function (v) {
    assert.strictEqual(Stats.isSample(v), false, String(v));
  });
});

test('ST-02 round: 1 decimal por defecto, d decimales si se indica, d=0 válido', function () {
  assert.strictEqual(Stats.round(1.26), 1.3);
  assert.strictEqual(Stats.round(1.234, 2), 1.23);
  assert.strictEqual(Stats.round(1.6, 0), 2);
  assert.strictEqual(Stats.round(1.26, null), 1.3, 'null equivale a la precisión por defecto');
  assert.strictEqual(Stats.round(-2.5, 0), -2);
});

test('ST-03 serie vacía: sent 0, lossPct 0 y el resto null', function () {
  assert.deepStrictEqual(Stats.stats([]), { sent: 0, received: 0, lossPct: 0, min: null, avg: null, max: null, jitter: null });
});

test('ST-04 todo null: 100 % de pérdida, sin min/avg/max/jitter', function () {
  assert.deepStrictEqual(Stats.stats([null, null, null]), { sent: 3, received: 0, lossPct: 100, min: null, avg: null, max: null, jitter: null });
});

test('ST-05 NaN e Infinity no son muestra: cuentan como pérdida y no contaminan las cifras', function () {
  var s = Stats.stats([10, NaN, 20, Infinity, -Infinity, undefined, null]);
  assert.strictEqual(s.sent, 7);
  assert.strictEqual(s.received, 2);
  assert.strictEqual(s.lossPct, 71.4);
  assert.strictEqual(s.min, 10);
  assert.strictEqual(s.max, 20);
  assert.strictEqual(s.avg, 15);
  assert.strictEqual(s.jitter, 10);
  ['min', 'avg', 'max', 'jitter'].forEach(function (k) { assert.ok(isFinite(s[k]), k); });
});

test('ST-06 solo NaN/Infinity: equivale a todo perdido', function () {
  var s = Stats.stats([NaN, Infinity]);
  assert.strictEqual(s.received, 0);
  assert.strictEqual(s.lossPct, 100);
  assert.strictEqual(s.avg, null);
});

test('ST-07 un solo valor: jitter 0 (no null)', function () {
  assert.deepStrictEqual(Stats.stats([42.567]), { sent: 1, received: 1, lossPct: 0, min: 42.57, avg: 42.57, max: 42.57, jitter: 0 });
  assert.strictEqual(Stats.stats([null, 5, null]).jitter, 0);
});

test('ST-08 jitter: media de |diferencias| entre muestras válidas consecutivas (los huecos no cuentan)', function () {
  assert.strictEqual(Stats.stats([10, 20, 15]).jitter, 7.5);
  assert.strictEqual(Stats.stats([10, null, 30]).jitter, 20, 'se comparan 10 y 30');
  assert.strictEqual(Stats.stats([5, 5, 5]).jitter, 0);
});

test('ST-09 redondeo: pérdida a 1 decimal; min/avg/max/jitter a 2', function () {
  var s = Stats.stats([1, 2, null]);
  assert.strictEqual(s.lossPct, 33.3);
  assert.strictEqual(Stats.stats([1, 1, 2]).avg, 1.33);
});

test('ST-10 no modifica la serie de entrada', function () {
  var a = [3, null, 1];
  Stats.stats(a);
  assert.deepStrictEqual(a, [3, null, 1]);
});

test('ST-11 carga como navegador: NOC.Stats existe y U.stats delega en él', function () {
  assert.ok(NOC.Stats && typeof NOC.Stats.stats === 'function');
  assert.deepStrictEqual(NOC.util.stats([1, null, 3]), NOC.Stats.stats([1, null, 3]));
});

test('ST-12 server util.stats es la misma función que Stats.stats', function () {
  assert.strictEqual(serverUtil.stats, Stats.stats);
});

// Generador pseudoaleatorio determinista (LCG) para que un fallo sea reproducible.
function lcg(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

test('ST-13 igualdad cliente (vm) = servidor en 500 series aleatorias (con null, NaN, Infinity y valores negativos)', function () {
  var rnd = lcg(12345), raros = [null, undefined, NaN, Infinity, -Infinity];
  for (var i = 0; i < 500; i++) {
    var n = Math.floor(rnd() * 30), serie = [];
    for (var j = 0; j < n; j++) {
      serie.push(rnd() < 0.25 ? raros[Math.floor(rnd() * raros.length)] : (rnd() - 0.2) * 1000);
    }
    var c = NOC.util.stats(serie), sv = serverUtil.stats(serie);
    // El objeto del vm pertenece a otro reino: se compara por valores serializados.
    assert.strictEqual(JSON.stringify(c), JSON.stringify(sv), 'serie ' + i + ': ' + JSON.stringify(serie));
  }
});

test('ST-14 lossPct redondea bien en los empates en coma flotante: 23 pérdidas de 80 = 28.8', function () {
  var serie = [];
  for (var i = 0; i < 80; i++) serie.push(i < 23 ? null : 10 + (i % 5));
  var s = Stats.stats(serie);
  assert.strictEqual(s.sent, 80);
  assert.strictEqual(s.received, 57);
  assert.strictEqual(s.lossPct, 28.8);
  assert.strictEqual(NOC.util.stats(serie).lossPct, 28.8, 'igual en el cliente');
  // El resto de campos no cambia: se calculan solo con las 57 muestras válidas.
  var ok = serie.filter(function (v) { return v !== null; });
  assert.strictEqual(s.min, Math.min.apply(null, ok));
  assert.strictEqual(s.max, Math.max.apply(null, ok));
  assert.strictEqual(s.avg, Stats.round(ok.reduce(function (a, b) { return a + b; }, 0) / ok.length, 2));
});

test('ST-15 lossPct: otros casos de redondeo (1 de 8 = 12.5; 1 de 3 = 33.3; 2 de 3 = 66.7)', function () {
  function perdidas(n, total) { var a = []; for (var i = 0; i < total; i++) a.push(i < n ? null : 1); return a; }
  assert.strictEqual(Stats.stats(perdidas(1, 8)).lossPct, 12.5);
  assert.strictEqual(Stats.stats(perdidas(1, 3)).lossPct, 33.3);
  assert.strictEqual(Stats.stats(perdidas(2, 3)).lossPct, 66.7);
});
