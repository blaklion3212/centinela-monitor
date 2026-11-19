'use strict';
/*
 * Alertas por Telegram: ajuste «Esperar antes de enviar» (groupWindowSec, versión 2.4.0). Valores permitidos 0, 10, 30 y 60 s;
 * por defecto 30 (comportamiento previo). Cubre configuración (server/lib/alerts-config.js), motor (server/lib/notify.js, con
 * reloj y canal falsos), API (servidor real con datos temporales y simulador de Telegram) e interfaz (js/views/alerts.js sobre
 * el DOM mínimo). Ninguna prueba espera tiempo real ni usa la red.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var cfgMod = require('../server/lib/alerts-config');
var H = require('./helpers/alerts-harness');
var A = require('./helpers/alerts-server');
var D = require('./helpers/mini-dom');

var MSG = 'La espera antes de enviar debe ser 0, 10, 30 o 60 segundos.';
var PERMITIDOS = [0, 10, 30, 60];
var INVALIDOS = [15, -1, '10', null, 1e9, 5, 61, 10.5, NaN, Infinity, true, [], {}, '', undefined];

test.after(async function () { await A.limpiar(); });

function fakeStore(initial) {
  var s = { files: {}, writes: 0 };
  if (initial !== undefined) s.files['alerts.json'] = JSON.parse(JSON.stringify(initial));
  s.read = function (n) { return Object.prototype.hasOwnProperty.call(s.files, n) ? { exists: true, value: JSON.parse(JSON.stringify(s.files[n])) } : { exists: false }; };
  s.write = function (n, o) { s.writes++; s.files[n] = JSON.parse(JSON.stringify(o)); };
  return s;
}
function base(extra) { return Object.assign(JSON.parse(JSON.stringify(cfgMod.DEFAULTS)), extra || {}); }

/* =============================================================================================
 * 1. Configuración
 * ========================================================================================== */

test('espera: valor por defecto 30 y lista de permitidos 0, 10, 30, 60', function () {
  assert.strictEqual(cfgMod.DEFAULTS.groupWindowSec, 30);
  assert.deepStrictEqual(cfgMod.GROUP_WINDOWS, PERMITIDOS);
});

test('espera: load conserva 0, 10, 30 y 60 y no reescribe el archivo', function () {
  PERMITIDOS.forEach(function (v) {
    var st = fakeStore(base({ groupWindowSec: v }));
    assert.strictEqual(cfgMod.load(st, ['default']).groupWindowSec, v);
    assert.strictEqual(st.writes, 0, 'sin reescritura para ' + v);
  });
});

test('espera: load normaliza a 30 los valores no permitidos y reescribe el archivo saneado', function () {
  [15, -1, '10', null, 1e9, 61, 10.5, true].forEach(function (v) {
    var st = fakeStore(base({ groupWindowSec: v }));
    assert.strictEqual(cfgMod.load(st, ['default']).groupWindowSec, 30, 'valor ' + JSON.stringify(v));
    assert.strictEqual(st.files['alerts.json'].groupWindowSec, 30);
  });
});

test('espera: un archivo antiguo sin el campo se carga con 30', function () {
  var viejo = base(); delete viejo.groupWindowSec;
  var st = fakeStore(viejo);
  assert.strictEqual(cfgMod.load(st, ['default']).groupWindowSec, 30);
  assert.strictEqual(cfgMod.load(fakeStore(), ['default']).groupWindowSec, 30, 'sin archivo: por defecto');
});

test('espera: validateUpdate acepta cada valor permitido y lo aplica sin tocar el resto', function () {
  PERMITIDOS.forEach(function (v) {
    var r = cfgMod.validateUpdate({ groupWindowSec: v }, base({ failsBeforeAlert: 4 }), {});
    assert.ok(!r.errors, 'error con ' + v + ': ' + JSON.stringify(r.errors));
    assert.strictEqual(r.value.groupWindowSec, v);
    assert.strictEqual(r.value.failsBeforeAlert, 4);
  });
});

test('espera: validateUpdate rechaza los valores no permitidos con el mensaje exacto (incluidos strings y no numéricos)', function () {
  INVALIDOS.forEach(function (v) {
    var r = cfgMod.validateUpdate({ groupWindowSec: v }, base(), {});
    assert.deepStrictEqual(r.errors, [MSG], 'valor ' + String(v));
    assert.strictEqual(r.value, undefined);
  });
});

test('espera: sin la clave en el cuerpo, validateUpdate conserva el valor actual; un rechazo no cambia nada (todo o nada)', function () {
  var r = cfgMod.validateUpdate({ detail: 'full' }, base({ groupWindowSec: 60 }), {});
  assert.strictEqual(r.value.groupWindowSec, 60);
  var x = cfgMod.validateUpdate({ detail: 'full', groupWindowSec: 15 }, base({ groupWindowSec: 60 }), {});
  assert.deepStrictEqual(x.errors, [MSG]);
});

test('espera: publicView incluye groupWindowSec (y 30 si falta o es inválido)', function () {
  PERMITIDOS.forEach(function (v) { assert.strictEqual(cfgMod.publicView(base({ groupWindowSec: v }), {}).groupWindowSec, v); });
  assert.strictEqual(cfgMod.publicView(base({ groupWindowSec: 15 }), {}).groupWindowSec, 30);
  var sin = base(); delete sin.groupWindowSec;
  assert.strictEqual(cfgMod.publicView(sin, {}).groupWindowSec, 30);
  assert.strictEqual(cfgMod.publicView(null, {}).groupWindowSec, 30);
});

/* =============================================================================================
 * 2. Motor (reloj falso; no se pasa consts.GROUP_WINDOW_MS salvo en la prueba que lo comprueba)
 * ========================================================================================== */

test('espera motor: con 0 el aviso sale sin avanzar el reloj (solo ceder el turno)', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 0 } });
  h.down();
  await h.clock.advance(0);
  assert.strictEqual(h.chan.calls.length, 1, 'enviado de inmediato');
  assert.strictEqual(h.chan.calls[0].t, h.clock.now(), 'sin tiempo transcurrido');
});

test('espera motor: con 10 el aviso sale a los 10 s y no antes', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 10 } });
  h.down();
  await h.clock.advance(9999);
  assert.strictEqual(h.chan.calls.length, 0, 'a los 9,999 s aún no');
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 1, 'a los 10 s sale');
});

test('espera motor: con 60 el aviso sale a los 60 s y no antes', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 60 } });
  h.down();
  await h.clock.advance(59999);
  assert.strictEqual(h.chan.calls.length, 0);
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 1);
});

test('espera motor: con 30 (por defecto) sigue enviando a los 30 s, como antes', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  assert.strictEqual(h.disk.cfg.groupWindowSec, 30);
  h.down();
  await h.clock.advance(29999);
  assert.strictEqual(h.chan.calls.length, 0);
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 1);
});

test('espera motor: dos caídas dentro de la ventana de 10 s se agrupan en un solo mensaje', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 10 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.down('a');
  await h.clock.advance(6000);
  h.down('b');
  await h.clock.advance(3999);
  assert.strictEqual(h.chan.calls.length, 0);
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 1, 'un solo mensaje: ' + JSON.stringify(h.chan.texts()));
  assert.ok(/Alfa/.test(h.chan.calls[0].text) && /Beta/.test(h.chan.calls[0].text));
  assert.strictEqual(h.chan.calls[0].t - 1700000000000, 10000, 'sale 10 s después de la primera caída');
});

test('espera motor: una caída fuera de la ventana de 10 s abre un grupo nuevo y sale en otro mensaje', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 10 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.down('a');
  await h.clock.advance(10000);
  h.down('b');
  await h.clock.advance(10000);
  assert.strictEqual(h.chan.calls.length, 2);
  assert.ok(/Alfa/.test(h.chan.calls[0].text) && !/Beta/.test(h.chan.calls[0].text));
  assert.ok(/Beta/.test(h.chan.calls[1].text));
});

// Comportamiento real documentado: con 0 el grupo se abre con un temporizador de 0 ms. Los resultados que llegan en el mismo turno
// síncrono (antes de que el reloj ejecute temporizadores) entran al mismo grupo y salen en UN mensaje; los que llegan en un
// turno posterior (tras ceder al reloj) salen en mensajes distintos, separados por el ritmo mínimo por chat (TG_MIN_GAP_CHAT_MS).
test('espera motor: con 0, dos objetivos que caen en el mismo turno salen agrupados en un solo mensaje', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 0 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.down('a'); h.down('b');
  await h.clock.advance(0);
  assert.strictEqual(h.chan.calls.length, 1, JSON.stringify(h.chan.texts()));
  assert.ok(/Alfa/.test(h.chan.calls[0].text) && /Beta/.test(h.chan.calls[0].text));
});

test('espera motor: con 0, caídas en turnos distintos salen en mensajes separados que respetan el ritmo por chat', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 0 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.down('a');
  await h.clock.advance(0);
  h.down('b');
  await h.clock.advance(0);
  assert.strictEqual(h.chan.calls.length, 1, 'el segundo espera el ritmo mínimo del chat');
  await h.clock.advance(1000);
  var c = h.chan.calls;
  assert.strictEqual(c.length, 2);
  assert.ok(/Alfa/.test(c[0].text) && /Beta/.test(c[1].text));
  assert.ok(c[1].t - c[0].t >= 1000, 'separación ' + (c[1].t - c[0].t) + ' ms');
});

test('espera motor: con 0 se mantienen los reintentos ante un fallo transitorio', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 0 } });
  h.chan.program({ ok: false, code: 'network', message: 'Sin red', transient: true });
  h.down();
  await h.clock.advance(0);
  assert.strictEqual(h.chan.calls.length, 1);
  await h.clock.advance(120000);
  assert.ok(h.chan.calls.length >= 2, 'reintentó: ' + h.chan.calls.length);
  assert.strictEqual(h.notifier.status().sentTotal, 1);
});

test('espera motor: consts.GROUP_WINDOW_MS explícito manda sobre el ajuste', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 60 }, consts: { GROUP_WINDOW_MS: 2000 } });
  h.down();
  await h.clock.advance(1999);
  assert.strictEqual(h.chan.calls.length, 0);
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 1, 'salió a los 2 s y no a los 60 s del ajuste');
});

test('espera motor: tras reload() con otro valor, los grupos nuevos usan el valor nuevo', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 60 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.disk.cfg.groupWindowSec = 10;
  h.notifier.reload();
  h.down('a');
  await h.clock.advance(9999);
  assert.strictEqual(h.chan.calls.length, 0);
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 1, 'el grupo nuevo usó 10 s');
  h.disk.cfg.groupWindowSec = 0;
  h.notifier.reload();
  h.down('b');
  await h.clock.advance(0);
  assert.strictEqual(h.chan.calls.length >= 1, true);
  await h.clock.advance(1000);
  assert.strictEqual(h.chan.calls.length, 2, 'con 0 el siguiente sale sin esperar la ventana (solo el ritmo del chat)');
  assert.ok(h.chan.calls[1].t - h.chan.calls[0].t < 5000);
});

test('espera motor: un grupo ya abierto conserva la ventana con la que se abrió aunque cambie el ajuste', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, groupWindowSec: 60 } });
  h.down();
  await h.clock.advance(1000);
  h.disk.cfg.groupWindowSec = 10;
  h.notifier.reload();
  await h.clock.advance(20000);
  assert.strictEqual(h.chan.calls.length, 0, 'sigue esperando los 60 s originales (o más): ' + h.chan.calls.length);
});

/* =============================================================================================
 * 3. API (servidor real con datos temporales)
 * ========================================================================================== */

var ctxApi = null;
async function api() {
  if (ctxApi) return ctxApi;
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ enabled: false }) });
  ctxApi = { h: h, sim: sim, op: await A.nuevoUsuario(h, 'operador1', 'operator'), lec: await A.nuevoUsuario(h, 'lector1', 'viewer') };
  return ctxApi;
}

test('espera API: sin el campo en el archivo, GET devuelve 30', async function () {
  var p = await api();
  var g = await p.h.api('GET', '/api/alerts');
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.json.groupWindowSec, 30);
});

test('espera API: PUT con cada valor permitido responde 200 y GET lo devuelve; persiste en alerts.json', async function () {
  var p = await api();
  for (var v of [10, 0, 60, 30]) {
    var r = await p.h.api('PUT', '/api/alerts', { groupWindowSec: v });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.groupWindowSec, v);
    var g = await p.h.api('GET', '/api/alerts');
    assert.strictEqual(g.json.groupWindowSec, v);
    assert.strictEqual(A.leerAlerts(p.h.dir).groupWindowSec, v, 'guardado en disco');
  }
});

test('espera API: PUT con valores no permitidos responde 400 con el mensaje y no cambia el valor guardado', async function () {
  var p = await api();
  await p.h.api('PUT', '/api/alerts', { groupWindowSec: 10 });
  for (var v of [15, -1, '10', null, 1e9, 61]) {
    var r = await p.h.api('PUT', '/api/alerts', { groupWindowSec: v });
    assert.strictEqual(r.status, 400, JSON.stringify(v) + ' => ' + r.text);
    assert.ok(JSON.stringify(r.json).indexOf(MSG) >= 0, 'mensaje en la respuesta: ' + r.text);
  }
  var g = await p.h.api('GET', '/api/alerts');
  assert.strictEqual(g.json.groupWindowSec, 10);
});

test('espera API: un operador y un lector no pueden cambiarlo (403) y el valor no varía', async function () {
  var p = await api();
  await p.h.api('PUT', '/api/alerts', { groupWindowSec: 30 });
  for (var quien of [p.op, p.lec]) {
    var r = await p.h.request('PUT', '/api/alerts', { cookie: quien, body: { groupWindowSec: 0 } });
    assert.strictEqual(r.status, 403, r.text);
    var g = await p.h.request('GET', '/api/alerts', { cookie: quien });
    assert.strictEqual(g.status, 403);
  }
  assert.strictEqual((await p.h.api('GET', '/api/alerts')).json.groupWindowSec, 30);
});

/* =============================================================================================
 * 4. Interfaz (DOM mínimo + fetch simulado)
 * ========================================================================================== */

var RAIZ = path.join(__dirname, '..');
function cfgUi(o) {
  return Object.assign({ enabled: false, blockedByEnv: false, tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel', chatId: '-1001234567890',
    orgChats: {}, detail: 'minimal', failsBeforeAlert: 2, groupWindowSec: 30, notifyRecovery: true, notifyDegraded: false, version: 1 }, o || {});
}
function resp(status, json) {
  return { status: status, ok: status >= 200 && status < 300, headers: { get: function () { return null; } }, json: function () { return Promise.resolve(json); } };
}
async function montar(cfg, putResp) {
  var ctx = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
  ctx.window = ctx;
  var alm = {};
  ctx.localStorage = { getItem: function (k) { return k in alm ? alm[k] : null; }, setItem: function (k, v) { alm[k] = String(v); }, removeItem: function (k) { delete alm[k]; } };
  var u = { calls: [], toasts: [] };
  ctx.fetch = function (url, o) {
    o = o || {};
    var method = o.method || 'GET';
    u.calls.push({ key: method + ' ' + url, body: o.body ? JSON.parse(o.body) : undefined });
    if (method + ' ' + url === 'GET /api/alerts') return Promise.resolve(resp(200, cfg));
    if (method + ' ' + url === 'GET /api/alerts/status') return Promise.resolve(resp(200, { state: 'off', lastSentAt: null, lastError: null, queued: 0, inWindow: 0, sentTotal: 0, failedTotal: 0, droppedTotal: 0, tokenSource: 'panel', note: '' }));
    if (method + ' ' + url === 'PUT /api/alerts') return Promise.resolve(resp(200, putResp || cfg));
    return Promise.resolve(resp(404, { error: 'Ruta no encontrada' }));
  };
  vm.createContext(ctx);
  function leer(f) { vm.runInContext(fs.readFileSync(path.join(RAIZ, f), 'utf8'), ctx, { filename: f }); }
  leer('js/core/util.js');
  ctx.NOC.ui = { icon: function (n) { return '<svg data-icon="' + n + '"></svg>'; }, statusIcon: function (k) { return '<svg data-kind="' + k + '"></svg>'; },
    toast: function (m, k) { u.toasts.push({ msg: m, kind: k }); }, confirm: function (t, m, l, cb) { cb(); } };
  ctx.NOC.auth = { can: function () { return true; }, onUnauthorized: function () {}, requireChange: function () {} };
  leer('js/views/alerts.js');
  var el = D.elemento();
  ctx.NOC.alertsPanel.mount(el);
  await D.settle();
  u.el = el;
  u.q = function (s) { return el.querySelector(s); };
  u.qa = function (s) { return el.querySelectorAll(s); };
  return u;
}
function selectEspera(u) {
  var l = u.qa('label').filter(function (x) { return x.textContent.indexOf('Esperar antes de enviar') >= 0; })[0];
  assert.ok(l, 'no hay label «Esperar antes de enviar»');
  var sel = u.q('#' + l.getAttribute('for'));
  assert.ok(sel && sel.tag === 'select', 'la label apunta a un select');
  return sel;
}
function seleccionada(sel) {
  var o = sel.querySelectorAll('option').filter(function (x) { return x.hasAttribute('selected'); });
  assert.strictEqual(o.length, 1, 'exactamente una opción seleccionada');
  return o[0].getAttribute('value');
}

test('espera UI: el select ofrece 0, 10, 30 y 60 y marca el valor guardado', async function () {
  for (var v of PERMITIDOS) {
    var u = await montar(cfgUi({ groupWindowSec: v }));
    var sel = selectEspera(u);
    assert.deepStrictEqual(sel.querySelectorAll('option').map(function (o) { return o.getAttribute('value'); }), ['0', '10', '30', '60']);
    assert.strictEqual(seleccionada(sel), String(v));
  }
});

test('espera UI: si el servidor no envía el campo, queda seleccionado 30', async function () {
  var c = cfgUi(); delete c.groupWindowSec;
  var u = await montar(c);
  assert.strictEqual(seleccionada(selectEspera(u)), '30');
});

test('espera UI: tiene label asociada y una ayuda breve (máximo dos frases) enlazada con aria-describedby', async function () {
  var u = await montar(cfgUi());
  var sel = selectEspera(u);
  var btn = u.q('[data-help-for="wait"]');
  assert.ok(btn, 'botón de ayuda');
  assert.strictEqual(btn.tag, 'button');
  assert.ok(/^Ayuda: /.test(btn.getAttribute('aria-label') || ''));
  var region = u.q('#' + btn.getAttribute('aria-controls'));
  assert.ok(region && region.getAttribute('data-help-text') === 'wait');
  assert.ok(sel.getAttribute('aria-describedby').indexOf(region.id) >= 0, 'el select referencia su ayuda');
  var frases = region.textContent.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.ok(frases.length >= 1 && frases.length <= 2, 'frases: ' + frases.length);
});

test('espera UI: Guardar envía el número elegido (no el texto)', async function () {
  for (var v of [0, 10, 60]) {
    var u = await montar(cfgUi());
    selectEspera(u).value = String(v);
    D.click(u.q('[data-save]'));
    await D.settle();
    var c = u.calls.filter(function (x) { return x.key === 'PUT /api/alerts'; });
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].body.groupWindowSec, v);
    assert.strictEqual(typeof c[0].body.groupWindowSec, 'number');
  }
});
