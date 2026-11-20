'use strict';
/*
 * Tipos de alerta seleccionables (2.5.0): panel «Qué avisar» de Ajustes → Alertas (js/views/alerts.js) sobre el DOM mínimo
 * (test/helpers/mini-dom.js) y un fetch simulado. Requisitos: RT-50 (panel de 9 casillas, guardado y bloqueo por entorno),
 * RT-51 (accesibilidad: labels, botones «?» con aria-controls válidos, región role="status") y RT-52 (textos de ayuda de
 * hasta dos frases). Sin red ni servidor.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var L = require('./helpers/alerts-ui-loader');
var D = L.D;

var CLAVES = ['down', 'recovery', 'certExpired', 'certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other'];
var ROTULOS = ['Caída', 'Recuperación', 'Certificado vencido', 'Certificado por vencer', 'Certificado no confiable', 'Alta latencia o pérdida',
  'Recursos del servidor (agente)', 'Espacio en disco (particiones)', 'Otras degradaciones'];
var DEFECTO = { down: true, recovery: true, certExpired: true, certExpiring: false, certTrust: false, latency: false, resources: false, disk: false, other: false };

// Configuración pública de 2.5.0 (sin depender del valor por defecto del cargador compartido).
function cfgN(o) {
  return Object.assign({ enabled: false, blockedByEnv: false, tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel', chatId: '-1001234567890',
    orgChats: {}, detail: 'minimal', failsBeforeAlert: 2, groupWindowSec: 30, notify: Object.assign({}, DEFECTO), notifyRecovery: true, notifyDegraded: false, version: 2 }, o || {});
}
// Configuración de un servidor antiguo (sin notify).
function cfgVieja(o) {
  var c = cfgN(o); delete c.notify; return c;
}
async function montar(cfg, routes) {
  return L.montar({ routes: Object.assign({ 'GET /api/alerts': cfg || cfgN() }, routes || {}) });
}
function casillas(u) { return u.qa('[data-notify]'); }
function casilla(u, k) { return u.q('[data-notify="' + k + '"]'); }
function estado(u) { var o = {}; CLAVES.forEach(function (k) { o[k] = casilla(u, k).checked; }); return o; }
function botonesAyuda(u) { return u.qa('[data-help-for]').filter(function (b) { return /^n-/.test(b.getAttribute('data-help-for')); }); }
function frases(t) { return String(t).split(/[.!?]+(?:\s+|$)/).filter(function (x) { return x.trim().length; }); }
function textoAyuda(u, k) {
  var b = u.q('[data-help-for="n-' + k + '"]');
  var t = u.q('#' + b.getAttribute('aria-controls'));
  return t ? t.textContent : null;
}

/* =============================================================================================
 * RT-50. Panel «Qué avisar»
 * ========================================================================================== */

test('RT-50 hay un fieldset con la leyenda «Qué avisar» que contiene las 9 casillas en el orden de la sección 3', async function () {
  var u = await montar();
  var fs = u.q('fieldset');
  assert.ok(fs, 'hay un fieldset');
  var lg = fs.querySelector('legend');
  assert.ok(lg && lg.textContent.trim() === 'Qué avisar', 'leyenda');
  var dentro = fs.querySelectorAll('[data-notify]');
  assert.strictEqual(dentro.length, 9);
  assert.strictEqual(casillas(u).length, 9, 'ninguna casilla de tipo fuera del fieldset');
  assert.deepStrictEqual(casillas(u).map(function (c) { return c.getAttribute('data-notify'); }), CLAVES);
  casillas(u).forEach(function (c) { assert.strictEqual(c.getAttribute('type'), 'checkbox'); });
});

test('RT-50 cada casilla tiene su rótulo en español, en el orden de la sección 3', async function () {
  var u = await montar();
  var rot = casillas(u).map(function (c) {
    var l = u.qa('label').filter(function (x) { return x.getAttribute('for') === c.id; })[0];
    assert.ok(l, 'label de ' + c.getAttribute('data-notify'));
    return l.textContent.trim();
  });
  assert.deepStrictEqual(rot, ROTULOS);
});

test('RT-50 las casillas parten del estado de cfg.notify', async function () {
  var notify = { down: false, recovery: false, certExpired: false, certExpiring: true, certTrust: true, latency: true, resources: false, disk: true, other: false };
  var u = await montar(cfgN({ notify: notify, notifyRecovery: true, notifyDegraded: false }));
  assert.deepStrictEqual(estado(u), notify, 'manda notify, no los campos derivados');
});

test('RT-50 con los valores por defecto del servidor: down, recovery y certExpired marcadas; las demás no', async function () {
  var u = await montar();
  assert.deepStrictEqual(estado(u), DEFECTO);
});

test('RT-50 compatibilidad: sin notify se usan notifyRecovery y notifyDegraded del servidor antiguo', async function () {
  var u = await montar(cfgVieja({ notifyRecovery: false, notifyDegraded: true }));
  var esperado = { down: true, recovery: false, certExpired: true, certExpiring: true, certTrust: true, latency: true, resources: true, disk: true, other: true };
  assert.deepStrictEqual(estado(u), esperado);
  var u2 = await montar(cfgVieja({ notifyRecovery: true, notifyDegraded: false }));
  assert.deepStrictEqual(estado(u2), DEFECTO);
});

test('RT-50 compatibilidad: sin notify ni campos antiguos se usan los valores por defecto de la sección 3', async function () {
  var c = cfgVieja(); delete c.notifyRecovery; delete c.notifyDegraded;
  var u = await montar(c);
  assert.deepStrictEqual(estado(u), DEFECTO);
});

test('RT-50 sustituye a las casillas antiguas «Avisar de recuperaciones» y «Avisar también de DEGRADADO»', async function () {
  var u = await montar();
  var txt = u.texto();
  assert.ok(!/Avisar de recuperaciones/.test(txt) && !/Avisar también de DEGRADADO/.test(txt), 'sin los rótulos antiguos');
  assert.ok(u.qa('label').every(function (l) { return !/recuperaciones|DEGRADADO/.test(l.textContent); }));
  var ids = u.qa('input').map(function (i) { return i.id; });
  assert.ok(!ids.some(function (i) { return /al\d+-(recovery|degraded)$/.test(i); }), 'sin #recovery ni #degraded: ' + ids.join(', '));
  assert.ok(!u.qa('[data-help-for]').some(function (b) { var k = b.getAttribute('data-help-for'); return k === 'recovery' || k === 'degraded'; }), 'sin sus ayudas');
  assert.strictEqual(u.qa('input[type="checkbox"]').length, 10, '9 tipos + «Enviar alertas por Telegram»');
});

test('RT-50 sin ninguna casilla marcada aparece un aviso no bloqueante: «Ningún tipo seleccionado: no se enviará ningún aviso.»', async function () {
  var sin = {}; CLAVES.forEach(function (k) { sin[k] = false; });
  var u = await montar(cfgN({ notify: sin }));
  var w = u.q('[data-none-warning]');
  assert.ok(w, 'región del aviso');
  assert.ok(/Ningún tipo seleccionado: no se enviará ningún aviso/.test(w.textContent), w.textContent);
});

test('RT-50 el aviso de «ninguno» no aparece con alguna casilla marcada', async function () {
  var u = await montar();
  assert.strictEqual(u.q('[data-none-warning]').textContent.trim(), '');
});

test('RT-50 / RT-51 al desmarcar todas las casillas aparece el aviso (en role=status) y al marcar una desaparece', async function () {
  var u = await montar();
  var w = u.q('[data-none-warning]');
  assert.strictEqual(w.getAttribute('role'), 'status');
  casillas(u).forEach(function (c) { c.checked = false; D.fire(c, 'change'); });
  assert.ok(/Ningún tipo seleccionado/.test(w.textContent), 'aparece: ' + w.textContent);
  casilla(u, 'disk').checked = true; D.fire(casilla(u, 'disk'), 'change');
  assert.strictEqual(w.textContent.trim(), '', 'desaparece');
});

test('RT-50 con el aviso de «ninguno» visible, Guardar sigue funcionando (no bloqueante) y envía los nueve en false', async function () {
  var u = await montar(cfgN(), { 'PUT /api/alerts': function (b) { return cfgN({ notify: b.notify }); } });
  casillas(u).forEach(function (c) { c.checked = false; D.fire(c, 'change'); });
  D.click(u.q('[data-save]'));
  await D.settle();
  var p = u.llamadas('PUT /api/alerts');
  assert.strictEqual(p.length, 1);
  CLAVES.forEach(function (k) { assert.strictEqual(p[0].body.notify[k], false, k); });
});

test('RT-50 Guardar envía notify completo con los 9 booleanos y ya no envía notifyRecovery ni notifyDegraded', async function () {
  var u = await montar(cfgN(), { 'PUT /api/alerts': function (b) { return cfgN({ notify: b.notify }); } });
  casilla(u, 'disk').checked = true; casilla(u, 'recovery').checked = false; casilla(u, 'latency').checked = true;
  D.click(u.q('[data-save]'));
  await D.settle();
  var p = u.llamadas('PUT /api/alerts');
  assert.strictEqual(p.length, 1);
  var n = p[0].body.notify;
  assert.deepStrictEqual(Object.keys(n).sort(), CLAVES.slice().sort(), 'las nueve claves');
  CLAVES.forEach(function (k) { assert.strictEqual(typeof n[k], 'boolean', k); });
  assert.deepStrictEqual(n, Object.assign({}, DEFECTO, { disk: true, recovery: false, latency: true }));
  assert.ok(!('notifyRecovery' in p[0].body) && !('notifyDegraded' in p[0].body), 'sin los campos antiguos: ' + Object.keys(p[0].body));
  assert.ok(!('chatId' in p[0].body), 'el chat no cambió, no se envía');
  assert.ok(u.toasts.some(function (t) { return /Alertas guardadas/.test(t.msg); }));
});

test('RT-50 al guardar, las casillas reflejan lo que devuelve el servidor', async function () {
  var u = await montar(cfgN(), { 'PUT /api/alerts': cfgN({ notify: Object.assign({}, DEFECTO, { other: true, certExpired: false }) }) });
  D.click(u.q('[data-save]'));
  await D.settle();
  assert.strictEqual(casilla(u, 'other').checked, true);
  assert.strictEqual(casilla(u, 'certExpired').checked, false);
});

test('RT-50 un error 400 al guardar se muestra con role=alert y las casillas conservan lo marcado', async function () {
  var u = await montar(cfgN(), { 'PUT /api/alerts': L.http(400, { errors: ['«notify» no admite la clave «dwon».'] }) });
  casilla(u, 'disk').checked = true;
  D.click(u.q('[data-save]'));
  await D.settle();
  var e = u.q('[data-errors] [role="alert"]');
  assert.ok(e && /dwon/.test(e.textContent), 'error visible');
  assert.strictEqual(casilla(u, 'disk').checked, true);
});

test('RT-50 con CENTINELA_ALERTS_DISABLED (blockedByEnv) las 9 casillas aparecen deshabilitadas como el interruptor', async function () {
  var u = await montar(cfgN({ blockedByEnv: true }));
  casillas(u).forEach(function (c) { assert.strictEqual(c.disabled, true, c.getAttribute('data-notify')); });
  assert.strictEqual(L.inputDe(u, 'Enviar alertas por Telegram').disabled, true);
  assert.ok(u.q('[data-blocked]'), 'aviso de bloqueo');
});

test('RT-50 sin bloqueo del entorno las casillas están habilitadas', async function () {
  var u = await montar();
  casillas(u).forEach(function (c) { assert.strictEqual(c.disabled, false, c.getAttribute('data-notify')); });
});

test('RT-50 bloqueadas: las casillas siguen deshabilitadas tras guardar o refrescar el estado', async function () {
  var u = await montar(cfgN({ blockedByEnv: true }));
  D.click(u.q('[data-refresh]'));
  await D.settle();
  casillas(u).forEach(function (c) { assert.strictEqual(c.disabled, true); });
});

test('RT-50 las casillas conservan lo que la persona marca mientras se actualiza solo el estado (sin pisar con el servidor)', async function () {
  var u = await montar();
  casilla(u, 'resources').checked = true;
  D.click(u.q('[data-refresh]'));
  await D.settle();
  // «Actualizar estado» recarga el estado, no el formulario.
  assert.strictEqual(casilla(u, 'resources').checked, true);
});

/* =============================================================================================
 * RT-51. Accesibilidad
 * ========================================================================================== */

test('RT-51 cada casilla tiene un label asociado por for/id y el id es único', async function () {
  var u = await montar();
  var vistos = {};
  casillas(u).forEach(function (c) {
    assert.ok(c.id, 'la casilla tiene id');
    assert.ok(!vistos[c.id], 'id repetido ' + c.id);
    vistos[c.id] = true;
    assert.strictEqual(u.qa('[id="' + c.id + '"]').length, 1);
    assert.strictEqual(u.qa('label').filter(function (l) { return l.getAttribute('for') === c.id; }).length, 1, 'un label para ' + c.id);
  });
});

test('RT-51 hay 9 botones de ayuda «?» con aria-label «Ayuda: …», aria-expanded e aria-controls que apunta a un texto existente', async function () {
  var u = await montar();
  var bs = botonesAyuda(u);
  assert.strictEqual(bs.length, 9);
  assert.deepStrictEqual(bs.map(function (b) { return b.getAttribute('data-help-for'); }), CLAVES.map(function (k) { return 'n-' + k; }));
  bs.forEach(function (b, i) {
    assert.strictEqual(b.tag, 'button');
    assert.strictEqual(b.getAttribute('type'), 'button', 'no envía el formulario');
    assert.strictEqual(b.getAttribute('aria-label'), 'Ayuda: ' + ROTULOS[i]);
    assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
    var ref = b.getAttribute('aria-controls');
    assert.ok(ref, 'aria-controls');
    assert.strictEqual(u.qa('[id="' + ref + '"]').length, 1, 'el id ' + ref + ' existe una sola vez');
    assert.ok(u.q('#' + ref).hidden, 'el texto está oculto al inicio');
    assert.notStrictEqual(b.getAttribute('tabindex'), '-1', 'alcanzable por teclado');
    assert.strictEqual(b.disabled, false);
  });
});

test('RT-51 al pulsar «?» se muestra el texto de ayuda y cambia aria-expanded; al volver a pulsar se oculta', async function () {
  var u = await montar();
  var b = u.q('[data-help-for="n-disk"]'), t = u.q('#' + b.getAttribute('aria-controls'));
  D.click(b);
  assert.strictEqual(b.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(t.hidden, false);
  D.click(b);
  assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(t.hidden, true);
});

test('RT-51 pulsar «?» no cambia ninguna casilla ni envía el formulario', async function () {
  var u = await montar();
  var antes = estado(u);
  botonesAyuda(u).forEach(function (b) { D.click(b); });
  assert.deepStrictEqual(estado(u), antes);
  assert.strictEqual(u.llamadas('PUT /api/alerts').length, 0);
});

test('RT-51 cada casilla se describe con su texto de ayuda (aria-describedby)', async function () {
  var u = await montar();
  CLAVES.forEach(function (k) {
    var c = casilla(u, k);
    var ref = c.getAttribute('aria-describedby');
    assert.ok(ref && u.q('#' + ref), 'aria-describedby de ' + k);
    assert.strictEqual(ref, u.q('[data-help-for="n-' + k + '"]').getAttribute('aria-controls'), 'apunta a la misma ayuda');
  });
});

test('RT-51 el aviso de «ninguno seleccionado» está en una región role="status" que existe siempre (para que se anuncie)', async function () {
  var u = await montar();
  var w = u.q('[data-none-warning]');
  assert.ok(w);
  assert.strictEqual(w.getAttribute('role'), 'status');
  assert.ok(u.q('fieldset').querySelector('[role="status"]'), 'dentro del fieldset');
});

test('RT-51 los ids de dos paneles montados a la vez no chocan (aria-controls y for siguen siendo válidos)', async function () {
  var u = await montar();
  var el2 = D.elemento();
  u.NOC.alertsPanel.mount(el2);
  await D.settle();
  var ids = [];
  [u.el, el2].forEach(function (raiz) { raiz.querySelectorAll('[id]').forEach(function (n) { ids.push(n.id); }); });
  var dup = ids.filter(function (x, i) { return ids.indexOf(x) !== i; });
  assert.deepStrictEqual(dup, [], 'ids repetidos: ' + dup.join(', '));
});

test('RT-51 todo texto se inserta con U.esc: una configuración hostil no inyecta elementos en el panel', async function () {
  var u = await montar(cfgN({ chatId: '"><img src=x onerror=alert(1)><b id="inyectado">', tokenHint: '<i id="inyectado2">' }));
  assert.strictEqual(u.q('#inyectado'), null);
  assert.strictEqual(u.q('#inyectado2'), null);
  assert.strictEqual(u.qa('img').length, 0);
  assert.ok(!/<script/i.test(u.el.innerHTML));
});

test('RT-51 en la ayuda ningún texto contiene marcado HTML sin escapar', async function () {
  var u = await montar();
  CLAVES.forEach(function (k) { assert.ok(!/[<>]/.test(textoAyuda(u, k)), k); });
});

/* =============================================================================================
 * RT-52. Textos de ayuda
 * ========================================================================================== */

var CONTENIDO = {
  down: [/ping/i, /puerto/i, /HTTP/, /DNS/, /palabra clave/i, /servicio detenido/i, /timeout/i],
  recovery: [/cada tipo/i, /recuperaci[oó]n/i],
  certExpired: [/venci/i],
  certExpiring: [/advertencia/i, /cr[ií]ticos?/i, /Ajustes/],
  certTrust: [/confiable/i],
  latency: [/latencia/i, /p[ée]rdida/i, /cr[ií]tic/i, /N fallos/],
  resources: [/CPU/, /memoria/i, /(I\/O|E\/S)/i, /cr[ií]tic/i, /N fallos/],
  disk: [/partici[oó]n/i, /advertencia/i, /cr[ií]tic/i],
  other: [/advertencia/i, /latencia/i, /recursos/i]
};

CLAVES.forEach(function (k) {
  test('RT-52 ayuda de «' + k + '»: existe, está en español, menciona lo exigido y tiene como máximo dos frases', async function () {
    var u = await montar();
    var t = textoAyuda(u, k);
    assert.ok(t && t.trim().length > 20, 'hay texto');
    CONTENIDO[k].forEach(function (re) { assert.ok(re.test(t), 'debe mencionar ' + re + ': «' + t + '»'); });
    assert.ok(frases(t).length >= 1 && frases(t).length <= 2, frases(t).length + ' frases: «' + t + '»');
    assert.ok(t.length <= 260, 'longitud razonable: ' + t.length);
  });
});

test('RT-52 las nueve ayudas son distintas entre sí', async function () {
  var u = await montar();
  var ts = CLAVES.map(function (k) { return textoAyuda(u, k); });
  assert.strictEqual(new Set(ts).size, 9);
});

test('RT-52 la ayuda de «Avisar tras N fallos seguidos» indica que aplica a todos los tipos de aviso', async function () {
  var u = await montar();
  var b = u.q('[data-help-for="fails"]');
  assert.ok(b, 'botón de ayuda de N fallos');
  var t = u.q('#' + b.getAttribute('aria-controls')).textContent;
  assert.ok(/todos los tipos/i.test(t), t);
  assert.ok(frases(t).length <= 2, t);
});

test('RT-52 el panel de ayuda general ya no habla de las casillas antiguas y remite a «Qué avisar»', async function () {
  var u = await montar();
  var pasos = u.q('[data-steps]').textContent;
  assert.ok(/Qué avisar/.test(pasos), pasos);
  assert.ok(!/Avisar de recuperaciones|también de DEGRADADO/.test(pasos));
});

/* =============================================================================================
 * RT-53. Modo demo (sin cambios): el panel «Qué avisar» no se monta ni llama a la API
 * ========================================================================================== */

function ajustesDemo() {
  var RAIZ = path.join(__dirname, '..');
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  function leer(f) { vm.runInContext(fs.readFileSync(path.join(RAIZ, f), 'utf8'), ctx, { filename: f }); }
  leer('js/core/util.js'); leer('js/shared/thresholds.js');
  var NOC = ctx.NOC, th = {}, montajes = [], red = [];
  NOC.Thresholds.PAIRS.forEach(function (p) { th[p.warn] = 1; th[p.crit] = 2; });
  ctx.fetch = function (url) { red.push(url); return Promise.reject(new Error('sin red')); };
  NOC.store = { state: { settings: { thresholds: th, theme: 'dark', intervalSec: 30, historyPoints: 100 }, mode: 'demo', server: {} } };
  NOC.ui = { confirm: function () {}, toast: function () {}, status: function () { return ''; }, icon: function () { return ''; } };
  NOC.auth = { can: function () { return true; } };
  NOC.app = { applyTheme: function () {} };
  NOC.data = { saveSettings: function () { return { then: function () {} }; } };
  NOC.W = { badge: function () { return ''; } };
  NOC.alertsPanel = { mount: function (el) { montajes.push(el); } };
  leer('js/views/settings.js');
  var html = '', panelEl = D.elemento();
  var form = { querySelector: function () { return { value: '' }; }, querySelectorAll: function () { return []; }, addEventListener: function () {} };
  NOC.views.settings.mount({
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelector: function (sel) { if (sel === '#sf') return form; if (sel === '#alerts-panel') return /id="alerts-panel"/.test(html) ? panelEl : null; return { getAttribute: function () { return 'dark'; } }; },
    querySelectorAll: function () { return []; }
  });
  return { panelEl: panelEl, montajes: montajes, red: red };
}

test('RT-53 modo demo: «Disponible solo con el servidor», sin montar «Qué avisar» ni llamar a la API', function () {
  var s = ajustesDemo();
  assert.ok(/Disponible solo con el servidor/.test(s.panelEl.textContent));
  assert.strictEqual(s.montajes.length, 0);
  assert.strictEqual(s.red.length, 0);
  assert.strictEqual(s.panelEl.querySelectorAll('[data-notify]').length, 0);
});
