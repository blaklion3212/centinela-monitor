'use strict';
/*
 * R8: js/ui/charts.js es un script de navegador (IIFE sobre window.NOC). Se carga en un contexto vm
 * con un elemento simulado para inspeccionar el SVG generado, sin DOM real.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function cargar() {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  ['../js/core/util.js', '../js/ui/charts.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
  });
  return ctx.NOC;
}
var NOC = cargar();

function elemento(w, h) {
  var el = { clientWidth: w || 600, clientHeight: h || 200, html: '' };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el.html; },
    set: function (v) { el.html = v; el.firstChild = { querySelector: function () { return { style: {}, setAttribute: function () {} }; }, addEventListener: function () {} }; }
  });
  return el;
}
function pts(estados) {
  // Datos realistas: un punto caído no tiene medición de latencia (lat null), como los genera el planificador.
  return estados.map(function (s, i) { return { t: 1700000000000 + i * 10000, s: s, lat: s === 'down' ? null : 20 }; });
}
// Posiciones x (redondeadas) de los rectángulos de sombreado de caídas.
function sombras(html) {
  var out = [], re = /<rect x="([\d.-]+)" y="[\d.]+" width="([\d.]+)"[^>]*style="fill:var\(--down\);opacity:\.13"/g, m;
  while ((m = re.exec(html))) out.push({ x: parseFloat(m[1]), w: parseFloat(m[2]) });
  return out;
}
function dibujar(estados, extra) {
  var el = elemento();
  NOC.charts.line(el, Object.assign({ points: pts(estados), series: [{ key: 'lat', name: 'Latencia', color: '#09f' }], downBg: true }, extra || {}));
  return el.html;
}
var MARGEN_IZQ = 46, ANCHO_UTIL = 600 - 46 - 8;

test('R8 charts: el sombreado de caídas incluye el primer punto si empieza en DOWN', function () {
  var s = sombras(dibujar(['down', 'down', 'up', 'up', 'up']));
  assert.strictEqual(s.length, 1);
  assert.ok(s[0].x <= MARGEN_IZQ, 'el rectángulo arranca en el primer punto (x=' + s[0].x + ')');
  assert.ok(s[0].w > 4);
});

test('R8 charts: caída en medio y caída al final generan sombreado cada una', function () {
  var s = sombras(dibujar(['up', 'down', 'up', 'up', 'down']));
  assert.strictEqual(s.length, 2);
  assert.ok(s[0].x > MARGEN_IZQ);
  assert.ok(s[1].x + s[1].w >= MARGEN_IZQ + ANCHO_UTIL, 'la última caída llega al borde derecho');
});

test('R8 charts: todo DOWN produce un único rectángulo que cubre todo el ancho', function () {
  var s = sombras(dibujar(['down', 'down', 'down', 'down']));
  assert.strictEqual(s.length, 1);
  assert.ok(s[0].x <= MARGEN_IZQ);
  assert.ok(s[0].x + s[0].w >= MARGEN_IZQ + ANCHO_UTIL);
});

test('R8 charts: una ventana mínima en DOWN (sin medición) también se sombrea', function () {
  var el = elemento();
  NOC.charts.line(el, { points: [{ t: 1, s: 'down', lat: null }, { t: 2, s: 'down', lat: null }], series: [{ key: 'lat', name: 'L', color: '#09f' }], downBg: true });
  assert.strictEqual(sombras(el.html).length, 1);
});

test('R8 charts: sin downBg o sin caídas no hay sombreado', function () {
  assert.strictEqual(sombras(dibujar(['up', 'up', 'up'])).length, 0);
  assert.strictEqual(sombras(dibujar(['down', 'up', 'up'], { downBg: false })).length, 0);
});

test('R8 charts: ventana entera en DOWN con serie toda null NO es estado vacío y se sombrea completa', function () {
  var el = elemento();
  var p = [0, 1, 2].map(function (i) { return { t: 1000 + i * 1000, s: 'down', lat: null }; });
  NOC.charts.line(el, { points: p, series: [{ key: 'lat', name: 'L', color: '#09f' }], downBg: true });
  assert.strictEqual(el.html.indexOf('class="empty"'), -1, 'no debe mostrarse el estado vacío');
  var s = sombras(el.html);
  assert.strictEqual(s.length, 1);
  assert.ok(s[0].x <= MARGEN_IZQ);
  assert.ok(s[0].x + s[0].w >= MARGEN_IZQ + ANCHO_UTIL, 'cubre todo el ancho útil');
  assert.strictEqual((el.html.match(/class="ln"/g) || []).length, 0, 'sin línea: no hay mediciones');
});

test('R8 charts: serie toda null SIN puntos down (ni downBg) sí muestra el estado vacío', function () {
  var el = elemento();
  var p = [0, 1, 2].map(function (i) { return { t: 1000 + i * 1000, s: 'up', lat: null }; });
  NOC.charts.line(el, { points: p, series: [{ key: 'lat', name: 'L', color: '#09f' }], downBg: true });
  assert.ok(el.html.indexOf('class="empty"') >= 0);
  assert.strictEqual(sombras(el.html).length, 0);
  var el2 = elemento();
  var pd = [0, 1, 2].map(function (i) { return { t: 1000 + i * 1000, s: 'down', lat: null }; });
  NOC.charts.line(el2, { points: pd, series: [{ key: 'lat', name: 'L', color: '#09f' }] }); // sin downBg
  assert.strictEqual(sombras(el2.html).length, 0, 'sin downBg no se dibuja sombreado');
});

test('R8 charts: caída intermedia con null en la serie: sombrea la caída y corta la línea', function () {
  var s = sombras(dibujar(['up', 'up', 'down', 'down', 'up', 'up']));
  assert.strictEqual(s.length, 1);
  var el = elemento();
  NOC.charts.line(el, { points: pts(['up', 'up', 'down', 'down', 'up', 'up']), series: [{ key: 'lat', name: 'L', color: '#09f' }], downBg: true });
  assert.strictEqual((el.html.match(/class="ln"/g) || []).length, 2, 'dos tramos de línea a cada lado de la caída');
});

test('R8 charts: sin datos muestra el texto vacío (escapado) y contenedor diminuto no dibuja', function () {
  var el = elemento();
  NOC.charts.line(el, { points: [], series: [{ key: 'lat' }], empty: '<b>nada</b>' });
  assert.ok(el.html.indexOf('&lt;b&gt;nada') >= 0);
  var chico = elemento(20, 20);
  NOC.charts.line(chico, { points: pts(['up', 'up']), series: [{ key: 'lat', name: 'L', color: '#000' }] });
  assert.strictEqual(chico.html, '');
});

test('R8 charts: los huecos (null) cortan la línea en segmentos', function () {
  var el = elemento();
  var p = [10, 20, null, 30, 40].map(function (v, i) { return { t: 1000 + i * 1000, s: 'up', lat: v }; });
  NOC.charts.line(el, { points: p, series: [{ key: 'lat', name: 'L', color: '#09f' }] });
  assert.strictEqual((el.html.match(/class="ln"/g) || []).length, 2);
});

test('R8 charts: niceMax devuelve valores redondos y 1 para entradas no positivas', function () {
  assert.strictEqual(NOC.charts.niceMax(0), 1);
  assert.strictEqual(NOC.charts.niceMax(-3), 1);
  assert.strictEqual(NOC.charts.niceMax(73), 100);
  assert.strictEqual(NOC.charts.niceMax(1.8), 2);
});
