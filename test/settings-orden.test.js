'use strict';
/*
 * Mensajes de orden aviso/crítico: js/views/settings.js usa NOC.Thresholds.orderMessage (js/shared/thresholds.js).
 * La vista se carga en un contexto vm con un DOM mínimo simulado (solo lo que usa el submit del formulario) y se compara el
 * texto mostrado con el que devuelve la API real (PUT /api/settings -> 400 { errors }) para los mismos valores.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var T = require('../js/shared/thresholds.js');
var srv = require('./helpers/server');

var ADMIN = 'administrador', ADMIN_PASS = 'clave-admin-segura-1';

// Carga util.js, thresholds.js y settings.js; devuelve una función que envía el formulario con los umbrales dados y
// devuelve los textos de los <li> mostrados (ya sin escapar HTML) y los envíos que habrían llegado al servidor.
function cargarVista() {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  function leer(f) { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f }); }
  leer('js/core/util.js');
  leer('js/shared/thresholds.js');
  var NOC = ctx.NOC, guardados = [];
  var th = {};
  T.PAIRS.forEach(function (p) { th[p.warn] = 1; th[p.crit] = 2; });
  NOC.store = { state: { settings: { thresholds: th, theme: 'dark', intervalSec: 30, historyPoints: 100 }, mode: 'live', server: {} } };
  NOC.ui = { confirm: function () {}, toast: function () {}, status: function () { return ''; } };
  NOC.auth = { can: function () { return true; } };
  NOC.app = { applyTheme: function () {} };
  NOC.data = { saveSettings: function (o) { guardados.push(o); return { then: function () {} }; } };
  NOC.W = { badge: function () { return ''; } };
  leer('js/views/settings.js');

  return {
    enviar: function (valores) {
      var inputs = Object.keys(valores).map(function (k) {
        return { value: String(valores[k]), getAttribute: function (a) { return a === 'data-k' ? k : null; } };
      });
      guardados.length = 0;
      var box = { innerHTML: '' };
      var form = {
        querySelector: function (sel) { return sel === '[data-errors]' ? box : { value: '' }; },
        querySelectorAll: function (sel) { return sel === '[data-k]' ? inputs : []; },
        addEventListener: function (ev, fn) { if (ev === 'submit') form.onSubmit = fn; }
      };
      var root = {
        set innerHTML(v) { /* el HTML generado no se inspecciona */ },
        querySelector: function (sel) {
          if (sel === '#sf') return form;
          return { getAttribute: function () { return 'dark'; } };
        },
        querySelectorAll: function () { return []; }
      };
      NOC.views.settings.mount(root);
      form.onSubmit({ preventDefault: function () {} });
      var mensajes = [], re = /<li>(.*?)<\/li>/g, m;
      while ((m = re.exec(box.innerHTML))) {
        mensajes.push(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      }
      return { mensajes: mensajes, guardados: guardados.slice(), html: box.innerHTML };
    }
  };
}
var vista = cargarVista();

// Valores que violan el orden: avisos iguales/mayores al crítico (y en SSL, menores o iguales).
function desordenados() {
  var v = {};
  T.PAIRS.forEach(function (p) { v[p.warn] = p.inverted ? 5 : 90; v[p.crit] = p.inverted ? 10 : 50; });
  return v;
}

// Etiquetas con unidades que debe mostrar la vista de Ajustes (las de la API son las de pair.label, sin unidades).
var ETIQUETAS_VISTA = { latency: 'Latencia (ms)', loss: 'Pérdida de paquetes (%)', jitter: 'Jitter (ms)', ttfb: 'TTFB HTTP (ms)',
                        ssl: 'SSL: días restantes (menor = peor)', disk: 'Disco usado (%)', cpu: 'CPU (%)', mem: 'Memoria RAM (%)', ioWait: 'I/O wait (%)' };

test('OR-01 la vista muestra, por cada par desordenado, el mensaje de orderMessage con la etiqueta con unidades y no envía nada', function () {
  var r = vista.enviar(desordenados());
  var v = desordenados();
  var esperado = T.PAIRS.map(function (p) { return T.orderMessage(p, v[p.warn], v[p.crit], ETIQUETAS_VISTA[p.id]); });
  assert.deepStrictEqual(r.mensajes, esperado);
  assert.ok(r.mensajes.indexOf('En "Latencia (ms)" el aviso (90) debe ser menor que el crítico (50).') >= 0, 'texto literal con unidades');
  assert.strictEqual(r.guardados.length, 0, 'con errores no se llama a saveSettings');
  assert.ok(/role="alert"/.test(r.html));
});

test('OR-01b orderMessage: usa label si se pasa, si no pair.label; en pares normales e invertidos', function () {
  var normal = T.byId('latency'), inv = T.byId('ssl');
  assert.strictEqual(T.orderMessage(normal, 9, 5), 'En "Latencia" el aviso (9) debe ser menor que el crítico (5).');
  assert.strictEqual(T.orderMessage(normal, 9, 5, 'Latencia (ms)'), 'En "Latencia (ms)" el aviso (9) debe ser menor que el crítico (5).');
  assert.ok(T.orderMessage(inv, 3, 7).indexOf('En "SSL: días restantes" el aviso (3) debe ser mayor que el crítico (7)') === 0);
  assert.ok(T.orderMessage(inv, 3, 7, 'X (d)').indexOf('En "X (d)" el aviso (3) debe ser mayor que el crítico (7)') === 0);
  assert.strictEqual(T.orderMessage(normal, 9, 5, undefined), T.orderMessage(normal, 9, 5), 'label ausente = pair.label');
});

test('OR-02 pares iguales (aviso = crítico) también se rechazan, en normales e invertidos', function () {
  var v = {};
  T.PAIRS.forEach(function (p) { v[p.warn] = 7; v[p.crit] = 7; });
  assert.strictEqual(vista.enviar(v).mensajes.length, T.PAIRS.length);
});

test('OR-03 SSL (invertido): el mensaje es el de "debe ser mayor", los demás el de "debe ser menor"', function () {
  var r = vista.enviar(desordenados());
  var ssl = T.byId('ssl');
  assert.ok(ssl && ssl.inverted);
  assert.ok(r.mensajes.some(function (m) { return /debe ser mayor que el crítico/.test(m); }));
  assert.ok(r.mensajes.some(function (m) { return /debe ser menor que el crítico/.test(m); }));
});

test('OR-04 un solo valor del par (o ninguno) no genera mensaje de orden: se envía al servidor', function () {
  var r = vista.enviar({ latencyWarnMs: 500 });
  assert.deepStrictEqual(r.mensajes, []);
  assert.strictEqual(r.guardados.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.guardados[0].thresholds)), { latencyWarnMs: 500 });
});

test('OR-05 vista y API coinciden en regla y valores; solo cambia la etiqueta (con unidades en la vista)', async function () {
  var h = await srv.startServer({ env: { CENTINELA_ADMIN_USER: ADMIN, CENTINELA_ADMIN_PASSWORD: ADMIN_PASS } });
  try {
    var l = await h.request('POST', '/api/auth/login', { body: { username: ADMIN, password: ADMIN_PASS } });
    var cookie = srv.cookieOf(l);
    var valores = desordenados();
    var api = await h.request('PUT', '/api/settings', { cookie: cookie, body: { thresholds: valores } });
    assert.strictEqual(api.status, 400, api.text);
    var vistaMsgs = vista.enviar(valores).mensajes;
    var delOrden = api.json.errors.filter(function (e) { return /el aviso \(/.test(e); });
    assert.strictEqual(vistaMsgs.length, T.PAIRS.length);
    assert.strictEqual(delOrden.length, T.PAIRS.length);
    // La API usa pair.label; la vista, la etiqueta con unidades.
    T.PAIRS.forEach(function (p) {
      var enApi = delOrden.filter(function (e) { return e.indexOf('En "' + p.label + '" ') === 0; });
      var enVista = vistaMsgs.filter(function (e) { return e.indexOf('En "' + ETIQUETAS_VISTA[p.id] + '" ') === 0; });
      assert.strictEqual(enApi.length, 1, 'API ' + p.id);
      assert.strictEqual(enVista.length, 1, 'vista ' + p.id);
      // Quitando la etiqueta, el resto (regla y valores) es idéntico.
      assert.strictEqual(enVista[0].slice(('En "' + ETIQUETAS_VISTA[p.id] + '"').length), enApi[0].slice(('En "' + p.label + '"').length), p.id);
    });
  } finally { await h.stop(); }
});
