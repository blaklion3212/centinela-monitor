'use strict';
/*
 * Regresión: tras cambiar el servicio de la ventana "Análisis de ruta (traceroute)", "Ejecutar" no mostraba nada hasta
 * recargar. Causa: Grid.prototype.renderOne creaba un ctx NUEVO en cada render, pero init() (que corre una sola vez)
 * registra manejadores de clic que capturan el primero; run() usaba así el objetivo original y descartaba el resultado.
 *
 * Los scripts de navegador (grid.js y network.js) se cargan en un contexto vm con un NOC simulado. Montar Grid completo
 * exige demasiado DOM (rejilla, ResizeObserver, arrastre), así que se usa el renderOne REAL con un `this` mínimo
 * (items, states, resolveTarget, syncTargetSelect, queueRender) y un cuerpo de ventana simulado con manejadores reales.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var A = { id: 'a', name: 'Servicio A', enabled: true };
var B = { id: 'b', name: 'Servicio B', enabled: true };

function cargar() {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  function leer(f) { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f }); }
  leer('js/shared/stats.js');
  leer('js/core/util.js');
  var NOC = ctx.NOC, registrados = {}, llamadas = [], respuesta = {};
  NOC.store = {}; NOC.bus = {};
  NOC.ui = { icon: function () { return ''; } };
  NOC.widgets = { register: function (w) { registrados[w.type] = w; } };
  NOC.W = {
    level: function () { return ''; },
    note: function (tipo, titulo, texto) { return '<note>' + titulo + ' ' + texto + '</note>'; }
  };
  // Traceroute falso: registra el targetId y responde con saltos propios de cada objetivo.
  NOC.data = {
    traceroute: function (o) {
      llamadas.push(o.targetId);
      return Promise.resolve({ hops: [{ hop: 1, ip: respuesta[o.targetId], samples: [5, 6] }] });
    }
  };
  leer('js/ui/grid.js');
  leer('js/widgets/network.js');
  return { NOC: NOC, Grid: NOC.Grid, def: registrados.traceroute, llamadas: llamadas, respuesta: respuesta };
}

// Cuerpo de ventana simulado: guarda los manejadores registrados y permite disparar un clic sobre [data-run] o [data-clear].
function cuerpoSimulado() {
  var oyentes = {};
  return {
    innerHTML: '', style: {}, clientWidth: 400, clientHeight: 300, scrollTop: 0,
    addEventListener: function (ev, fn) { (oyentes[ev] = oyentes[ev] || []).push(fn); },
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    clic: function (selector) {
      var e = { target: { closest: function (s) { return s === selector ? {} : null; }, matches: function () { return false; } } };
      (oyentes.click || []).forEach(function (fn) { fn(e); });
    }
  };
}

// `this` mínimo para el renderOne real. `objetivo.actual` decide qué servicio resuelve la ventana.
function montar(h, def) {
  var objetivo = { actual: A }, pendientes = [];
  var cuerpo = cuerpoSimulado();
  var grid = {
    items: [{ id: 'w1', type: 'traceroute', config: {} }],
    states: { w1: { def: def, body: cuerpo, state: {}, win: {} } },
    resolveTarget: function () { return objetivo.actual; },
    syncTargetSelect: function () {},
    // El real usa requestAnimationFrame; aquí se acumulan y se vacían a mano para controlar el orden.
    queueRender: function (id) { if (pendientes.indexOf(id) < 0) pendientes.push(id); },
    changed: function () {}
  };
  return {
    grid: grid, body: cuerpo, st: grid.states.w1,
    render: function () { h.Grid.prototype.renderOne.call(grid, 'w1'); },
    vaciar: function () { var ids = pendientes.splice(0); ids.forEach(function (i) { h.Grid.prototype.renderOne.call(grid, i); }); },
    cambiarA: function (t) { objetivo.actual = t; }
  };
}

// Deja que se resuelvan las promesas pendientes (el traceroute falso resuelve en microtareas).
function asentar() { return new Promise(function (r) { setImmediate(r); }); }

test('Regresión traceroute: Grid.renderOne reutiliza el mismo ctx y actualiza su objetivo', function () {
  var h = cargar(), recibidos = [];
  var def = { target: 'required', init: function (c) { recibidos.push(c); }, render: function (c) { recibidos.push(c); } };
  var m = montar(h, def);
  m.render();
  var primero = recibidos[0];
  assert.strictEqual(primero.target, A);
  m.cambiarA(B);
  m.render();
  recibidos.forEach(function (c) { assert.strictEqual(c, primero, 'init y render reciben siempre el mismo ctx'); });
  assert.strictEqual(primero.target, B, 'el ctx que capturó init ve el objetivo actual');
  assert.strictEqual(m.st.ctx, primero);
});

test('Regresión traceroute: Grid.renderOne mantiene al día config, tamaño y setConfig', function () {
  var h = cargar(), vistos = [];
  var def = { target: 'required', init: function (c) { vistos.push(c); }, render: function () {} };
  var m = montar(h, def);
  m.render();
  var c = vistos[0];
  m.grid.items[0].config = { targetId: 'b' };
  m.body.clientWidth = 640; m.body.clientHeight = 480;
  m.render();
  assert.strictEqual(c.config.targetId, 'b');
  assert.strictEqual(c.width, 640);
  assert.strictEqual(c.height, 480);
  c.setConfig({ x: 1 });
  assert.strictEqual(c.config.x, 1);
  assert.strictEqual(m.grid.items[0].config.targetId, 'b', 'setConfig conserva lo previo');
});

test('Regresión traceroute: tras cambiar de servicio, "Ejecutar" traza el servicio nuevo y muestra sus saltos', async function () {
  var h = cargar();
  h.respuesta.a = '10.0.0.1'; h.respuesta.b = '10.9.9.9';
  var m = montar(h, h.def);

  // Objetivo A: ejecutar y ver sus saltos.
  m.render();
  assert.match(m.body.innerHTML, /Sin datos de ruta/);
  m.body.clic('[data-run]');
  await asentar(); m.vaciar(); await asentar(); m.vaciar();
  assert.deepStrictEqual(h.llamadas, ['a']);
  assert.match(m.body.innerHTML, /10\.0\.0\.1/);

  // Limpiar vuelve a "Sin datos de ruta".
  m.body.clic('[data-clear]');
  m.vaciar();
  assert.match(m.body.innerHTML, /Sin datos de ruta/);

  // Cambio de servicio (nuevo render con B) y nueva ejecución.
  m.cambiarA(B);
  m.render();
  m.body.clic('[data-run]');
  await asentar(); m.vaciar(); await asentar(); m.vaciar();
  assert.deepStrictEqual(h.llamadas, ['a', 'b'], 'el traceroute recibe el targetId del objetivo actual');
  assert.match(m.body.innerHTML, /10\.9\.9\.9/, 'se ven los saltos de B');
  assert.doesNotMatch(m.body.innerHTML, /Sin datos de ruta/);
  assert.match(m.body.innerHTML, /Servicio B/);
});
