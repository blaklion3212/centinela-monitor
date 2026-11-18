'use strict';
/*
 * Fase 3 (frontend): advertencias del agente en js/widgets/infrastructure.js. agentWarn es privada, así que se prueba
 * por el widget "cpu-ram" (su render la incluye) cargando el script de navegador en un contexto vm con un NOC simulado
 * (sin DOM real ni red). Acepta `warning` (texto) y `warnings` (lista) y siempre escapa el HTML.
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
  function leer(f) { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f }); }
  leer('js/core/util.js');
  var NOC = ctx.NOC, registrados = {}, agente = null;
  NOC.store = { result: function () { return { agent: agente }; }, series: function () { return []; } };
  NOC.ui = {};
  NOC.charts = { line: function () {} };
  NOC.widgets = { register: function (w) { registrados[w.type] = w; } };
  NOC.W = {
    th: function () { return {}; }, head: function () { return ''; }, rangeButtons: function () { return ''; }, range: function () { return 0; },
    stat: function () { return ''; }, level: function () { return ''; }, waiting: function () { return '<i>esperando</i>'; },
    note: function (tipo, titulo, texto) { return '<note>' + titulo + ' ' + texto + '</note>'; },
    bindRange: function () {}, withAgent: function () { return true; }
  };
  leer('js/widgets/infrastructure.js');
  return {
    // Renderiza el widget con el objeto `agent` dado y devuelve el HTML resultante.
    render: function (a) {
      agente = a;
      var ctxW = { target: { id: 't1', name: 'srv' }, state: {}, body: { innerHTML: '', querySelector: function () { return {}; } } };
      registrados['cpu-ram'].render(ctxW);
      return ctxW.body.innerHTML;
    }
  };
}
var W = cargar();

function agenteOk(extra) {
  return Object.assign({ cpu: { usagePct: 10, ioWaitPct: 1, cores: 4, load: [0.1, 0.2, 0.3] }, mem: { usedPct: 40, usedMb: 400, totalMb: 1000 }, uptimeSec: 100 }, extra || {});
}
var RE_AVISO = /<div class="hint" role="status"[^>]*>(.*?)<\/div>/;

test('agentWarn: sin warning ni warnings no se muestra ningún aviso', function () {
  var html = W.render(agenteOk());
  assert.doesNotMatch(html, /class="hint"/);
  assert.match(html, /data-chart/, 'el resto del widget sigue pintándose');
});

test('agentWarn: warning (texto) se muestra como aviso con role="status"', function () {
  var html = W.render(agenteOk({ warning: 'TLS sin huella fijada' }));
  var m = RE_AVISO.exec(html);
  assert.ok(m, html);
  assert.strictEqual(m[1], 'TLS sin huella fijada');
});

test('agentWarn: warnings (lista) se muestran unidos con " · " y se combinan con warning', function () {
  var m = RE_AVISO.exec(W.render(agenteOk({ warnings: ['uno', 'dos'] })));
  assert.strictEqual(m[1], 'uno · dos');
  var m2 = RE_AVISO.exec(W.render(agenteOk({ warning: 'primero', warnings: ['segundo', 'tercero'] })));
  assert.strictEqual(m2[1], 'primero · segundo · tercero');
});

test('agentWarn: escapa el HTML de warning y de warnings (no se inyecta marcado)', function () {
  var html = W.render(agenteOk({ warning: '<img src=x onerror=alert(1)>', warnings: ['"comillas" & <b>negrita</b>', "it's"] }));
  var m = RE_AVISO.exec(html);
  assert.ok(m, html);
  assert.doesNotMatch(m[1], /<img|<b>|<\/b>/);
  assert.match(m[1], /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(m[1], /&quot;comillas&quot; &amp; &lt;b&gt;negrita&lt;\/b&gt;/);
  assert.match(m[1], /it&#39;s|it&#039;s/);
});

test('agentWarn: lectura defensiva (tipos inesperados, vacíos y entradas que no son cadena se ignoran)', function () {
  [{ warning: 42 }, { warning: '' }, { warning: null }, { warnings: 'no es lista' }, { warnings: [] }, { warnings: [null, 5, {}, '', []] },
   { warnings: { 0: 'x', length: 1 } }].forEach(function (extra) {
    assert.doesNotMatch(W.render(agenteOk(extra)), /class="hint"/, JSON.stringify(extra));
  });
  var m = RE_AVISO.exec(W.render(agenteOk({ warnings: [null, 'valido', 7, '', 'otro'] })));
  assert.strictEqual(m[1], 'valido · otro', 'se conservan solo las cadenas no vacías');
});

test('agentWarn: con error del agente se muestra el aviso de error y no se renderiza el widget normal', function () {
  var html = W.render({ error: 'tiempo agotado', warning: 'TLS sin huella fijada' });
  assert.match(html, /El agente no responde/);
  assert.doesNotMatch(html, /class="hint"/);
});
