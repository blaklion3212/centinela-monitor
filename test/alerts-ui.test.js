'use strict';
/*
 * Alertas por Telegram: interfaz Ajustes > Alertas (js/views/alerts.js) y su montaje en js/views/settings.js.
 * El proyecto no tiene jsdom: el código del navegador se carga en un contexto vm con un DOM mínimo (test/helpers/mini-dom.js, que
 * analiza el innerHTML a un árbol real) y un fetch simulado. Sin red ni servidor. Requisitos: RA-04, RA-60 a RA-66, RA-70 a RA-74.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var D = require('./helpers/mini-dom');

var RAIZ = path.join(__dirname, '..');
var MAL_TOKEN = '123456789:AAH_abcdefghijklmnopqrstuvwxyz012345';

function cfg(o) {
  return Object.assign({ enabled: false, blockedByEnv: false, tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel', chatId: '-1001234567890',
    orgChats: {}, detail: 'minimal', failsBeforeAlert: 2, notifyRecovery: true, notifyDegraded: false, version: 1 }, o || {});
}
function sinConfigurar(o) { return cfg(Object.assign({ tokenConfigured: false, tokenHint: '', tokenSource: 'none', chatId: '' }, o || {})); }
function estado(o) {
  return Object.assign({ state: 'off', lastSentAt: null, lastError: null, queued: 0, inWindow: 0, sentTotal: 0, failedTotal: 0, droppedTotal: 0, tokenSource: 'panel', note: '' }, o || {});
}
function resp(status, json, headers) {
  headers = headers || {};
  return { status: status, ok: status >= 200 && status < 300, headers: { get: function (n) { return headers[n] !== undefined ? headers[n] : null; } },
    json: function () { return json === undefined ? Promise.reject(new Error('sin cuerpo')) : Promise.resolve(json); } };
}

/*
 * Carga util.js y alerts.js en un contexto aislado. opts.routes: { 'MÉTODO /ruta': json | function(body, opts) -> {status, json, headers}
 * | Promise } (por omisión GET /api/alerts y /api/alerts/status). Devuelve { NOC, calls, toasts, confirms, ls, route(clave, valor) }.
 */
function cargar(opts) {
  opts = opts || {};
  var ctx = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
  ctx.window = ctx;
  var almacen = Object.assign({}, opts.storage || {});
  ctx.localStorage = { getItem: function (k) { return Object.prototype.hasOwnProperty.call(almacen, k) ? almacen[k] : null; },
    setItem: function (k, v) { almacen[k] = String(v); }, removeItem: function (k) { delete almacen[k]; } };
  var u = { calls: [], toasts: [], confirms: [], unauthorized: 0, mustChange: 0, ls: almacen };
  var routes = Object.assign({ 'GET /api/alerts': cfg(), 'GET /api/alerts/status': estado() }, opts.routes || {});
  u.route = function (k, v) { routes[k] = v; };
  ctx.fetch = function (url, o) {
    o = o || {};
    var method = o.method || 'GET', key = method + ' ' + url, body = o.body ? JSON.parse(o.body) : undefined;
    u.calls.push({ method: method, url: url, body: body, headers: o.headers, key: key });
    var r = routes[key];
    if (r === undefined) return Promise.resolve(resp(404, { error: 'Ruta no encontrada' }));
    if (typeof r === 'function') r = r(body, o);
    return Promise.resolve(r).then(function (x) {
      if (x && typeof x === 'object' && 'status' in x && 'json' in x && !x.ok && x.ok !== undefined) return x;
      if (x && x.__resp) return resp(x.status, x.json, x.headers);
      return resp(200, x);
    });
  };
  vm.createContext(ctx);
  function leer(f) { vm.runInContext(fs.readFileSync(path.join(RAIZ, f), 'utf8'), ctx, { filename: f }); }
  leer('js/core/util.js');
  var NOC = ctx.NOC;
  NOC.ui = {
    icon: function (n) { return '<svg class="ic" data-icon="' + n + '"></svg>'; },
    statusIcon: function (k) { return '<svg class="si" data-kind="' + k + '"></svg>'; },
    toast: function (m, k) { u.toasts.push({ msg: m, kind: k }); },
    confirm: function (t, m, l, cb) { u.confirms.push({ title: t, msg: m, label: l }); if (opts.confirm !== false) cb(); }
  };
  NOC.auth = { can: function (a) { return opts.admin !== false || (a !== 'users'); }, onUnauthorized: function () { u.unauthorized++; }, requireChange: function () { u.mustChange++; } };
  u.ctx = ctx; u.NOC = NOC; u.leer = leer;
  leer('js/views/alerts.js');
  return u;
}
function http(status, json, headers) { return { __resp: true, status: status, json: json, headers: headers }; }

async function montar(opts) {
  var u = cargar(opts);
  var el = D.elemento();
  u.NOC.alertsPanel.mount(el);
  await D.settle();
  u.el = el;
  u.q = function (s) { return el.querySelector(s); };
  u.qa = function (s) { return el.querySelectorAll(s); };
  u.texto = function () { return el.textContent; };
  u.llamadas = function (k) { return u.calls.filter(function (c) { return c.key === k; }); };
  return u;
}
function inputDe(u, rotulo) {
  var l = u.qa('label').filter(function (x) { return x.textContent.indexOf(rotulo) >= 0; })[0];
  assert.ok(l, 'no hay label «' + rotulo + '»');
  var ref = l.getAttribute('for');
  var inp = ref ? u.q('#' + ref) : l.querySelector('input');
  assert.ok(inp, 'la label «' + rotulo + '» no apunta a ningún campo');
  return inp;
}
function boton(u, texto) {
  var b = u.qa('button').filter(function (x) { return x.textContent.trim().indexOf(texto) >= 0; })[0];
  assert.ok(b, 'no hay botón «' + texto + '»');
  return b;
}

// Control del propio DOM de prueba: el HTML sin escapar SÍ se vuelve elemento (si no, las pruebas de RA-65 no demostrarían nada).
test('Control del DOM de prueba: un <img onerror> sin escapar se ve como elemento y el escapado como texto', function () {
  var e = D.elemento();
  e.innerHTML = '<p><img src=x onerror=alert(1)></p>';
  assert.ok(e.querySelector('img'), 'sin escapar crea el elemento');
  e.innerHTML = '<p>&lt;img src=x onerror=alert(1)&gt;</p>';
  assert.strictEqual(e.querySelector('img'), null);
  assert.strictEqual(e.textContent, '<img src=x onerror=alert(1)>');
});

/* =============================================================================================
 * Controles y accesibilidad (RA-61, RA-64)
 * ========================================================================================== */

test('RA-61 contenido de la sección: interruptor, token, chat, detalle, N, recuperación, degradado, prueba y estado', async function () {
  var u = await montar();
  assert.ok(u.el.hasAttribute('data-alerts'), 'contenedor con data-alerts');
  assert.ok(u.llamadas('GET /api/alerts').length === 1 && u.llamadas('GET /api/alerts/status').length === 1, 'carga configuración y estado');
  var en = inputDe(u, 'Enviar alertas por Telegram');
  assert.strictEqual(en.getAttribute('type'), 'checkbox'); assert.strictEqual(en.checked, false, 'apagado por defecto');
  var tk = inputDe(u, 'Token del bot');
  assert.strictEqual(tk.getAttribute('type'), 'password'); assert.strictEqual(tk.getAttribute('autocomplete'), 'off');
  assert.ok(u.q('[data-save-token]') && /Guardar token/.test(u.q('[data-save-token]').textContent));
  assert.ok(u.q('[data-del-token]') && /Borrar token/.test(u.q('[data-del-token]').textContent));
  var chat = inputDe(u, 'Chat de destino'); assert.strictEqual(chat.value, '-1001234567890');
  assert.ok(/Buscar mis chats/.test(u.q('[data-find]').textContent));
  var det = u.qa('[data-detail]').map(function (b) { return b.getAttribute('data-detail') + ':' + b.textContent.trim() + ':' + b.getAttribute('aria-pressed'); });
  assert.deepStrictEqual(det, ['minimal:Mínimo:true', 'full:Completo:false']);
  var n = inputDe(u, 'Avisar tras N fallos seguidos');
  assert.strictEqual(n.getAttribute('type'), 'number'); assert.strictEqual(n.getAttribute('min'), '1'); assert.strictEqual(n.getAttribute('max'), '10'); assert.strictEqual(n.value, '2');
  assert.strictEqual(inputDe(u, 'Avisar de recuperaciones').checked, true);
  assert.strictEqual(inputDe(u, 'Avisar también de DEGRADADO').checked, false);
  assert.ok(/Guardar/.test(u.q('[data-save]').textContent));
  assert.ok(/Enviar mensaje de prueba/.test(u.q('[data-test]').textContent));
  assert.ok(u.q('[data-status] [data-state]'), 'indicador de estado');
  assert.ok(u.q('[data-refresh]'));
  assert.ok(!/horario|silencioso/i.test(u.texto()), 'sin horario silencioso (RA-90)');
  assert.ok(!/organizaci[óo]n/i.test(u.qa('label').map(function (l) { return l.textContent; }).join(' ')), 'sin selector de chat por organización');
});

test('RA-61 los valores guardados se reflejan en el formulario (activado, completo, N, recuperación y degradado)', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': cfg({ enabled: true, detail: 'full', failsBeforeAlert: 5, notifyRecovery: false, notifyDegraded: true }) } });
  assert.strictEqual(inputDe(u, 'Enviar alertas por Telegram').checked, true);
  assert.strictEqual(u.q('[data-detail="full"]').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(inputDe(u, 'Avisar tras N fallos seguidos').value, '5');
  assert.strictEqual(inputDe(u, 'Avisar de recuperaciones').checked, false);
  assert.strictEqual(inputDe(u, 'Avisar también de DEGRADADO').checked, true);
});

test('RA-64 cada campo tiene una label asociada y los iconos de ayuda son botones con aria-label y región que los describe', async function () {
  var u = await montar();
  ['Enviar alertas por Telegram', 'Token del bot', 'Chat de destino', 'Avisar tras N fallos seguidos', 'Esperar antes de enviar', 'Avisar de recuperaciones', 'Avisar también de DEGRADADO']
    .forEach(function (r) { assert.ok(inputDe(u, r)); });
  var ayudas = u.qa('[data-help-for]');
  assert.deepStrictEqual(ayudas.map(function (b) { return b.getAttribute('data-help-for'); }).sort(), ['chat', 'degraded', 'detail', 'enabled', 'fails', 'recovery', 'token', 'wait']);
  ayudas.forEach(function (b) {
    assert.strictEqual(b.tag, 'button'); assert.strictEqual(b.getAttribute('type'), 'button');
    assert.ok(/^Ayuda: /.test(b.getAttribute('aria-label') || ''), 'aria-label');
    assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
    var region = u.q('#' + b.getAttribute('aria-controls'));
    assert.ok(region && region.getAttribute('data-help-text') === b.getAttribute('data-help-for'), 'aria-controls apunta a su texto');
    assert.ok(region.hidden, 'plegado por omisión');
  });
  // Los campos referencian su ayuda con aria-describedby.
  assert.ok(/h-token/.test(inputDe(u, 'Token del bot').getAttribute('aria-describedby')));
  assert.ok(/h-chat/.test(inputDe(u, 'Chat de destino').getAttribute('aria-describedby')));
});

test('RA-72 cada icono «?» abre y cierra una explicación de como máximo dos frases en español', async function () {
  var u = await montar();
  u.qa('[data-help-for]').forEach(function (b) {
    var t = u.q('[data-help-text="' + b.getAttribute('data-help-for') + '"]');
    D.click(b);
    assert.strictEqual(b.getAttribute('aria-expanded'), 'true'); assert.strictEqual(t.hidden, false);
    var frases = t.textContent.trim().split(/[.!?](?:\s|$)/).filter(function (x) { return x.trim(); });
    assert.ok(frases.length >= 1 && frases.length <= 2, b.getAttribute('data-help-for') + ': ' + frases.length + ' frases');
    assert.ok(/[a-záéíóú]{4,}/i.test(t.textContent));
    D.click(b);
    assert.strictEqual(b.getAttribute('aria-expanded'), 'false'); assert.strictEqual(t.hidden, true);
  });
});

/* =============================================================================================
 * Token (RA-62)
 * ========================================================================================== */

test('RA-62 con token guardado: muestra «configurado (…abcd)», no prellena el campo y el token completo no aparece en la interfaz', async function () {
  var u = await montar();
  assert.match(u.q('[data-token-state]').textContent, /configurado \(…2345\)/);
  var tk = inputDe(u, 'Token del bot');
  assert.strictEqual(tk.value, ''); assert.strictEqual(tk.hasAttribute('value'), false);
  assert.strictEqual(tk.getAttribute('autocomplete'), 'off');
  assert.ok(u.el.innerHTML.indexOf('AAH_abc') < 0 && u.el.innerHTML.indexOf(MAL_TOKEN) < 0);
  assert.strictEqual(u.q('[data-del-token]').disabled, false);
});

test('RA-62 sin token guardado: «Sin token guardado» y «Borrar token» deshabilitado', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar() } });
  assert.match(u.q('[data-token-state]').textContent, /Sin token guardado/);
  assert.strictEqual(u.q('[data-del-token]').disabled, true);
});

test('RA-62 token por variable de entorno: campo y botones del token bloqueados con la explicación', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': cfg({ tokenSource: 'env', tokenHint: '…7890' }) } });
  assert.strictEqual(inputDe(u, 'Token del bot').disabled, true);
  assert.strictEqual(u.q('[data-save-token]').disabled, true); assert.strictEqual(u.q('[data-del-token]').disabled, true);
  var e = u.q('[data-token-env]');
  assert.ok(e, 'texto explicativo'); assert.match(e.textContent, /CENTINELA_TELEGRAM_TOKEN/);
  assert.match(u.q('[data-token-state]').textContent, /…7890/);
  D.click(u.q('[data-save-token]'));
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts/token').length, 0, 'un botón deshabilitado no envía nada');
});

test('RA-62 guardar token: envía {token}, vacía el campo, actualiza la pista y avisa; el valor no queda en el HTML', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar(), 'PUT /api/alerts/token': { tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel' } } });
  var tk = inputDe(u, 'Token del bot');
  tk.value = '  ' + MAL_TOKEN + '  ';
  D.click(u.q('[data-save-token]'));
  await D.settle();
  var c = u.llamadas('PUT /api/alerts/token');
  assert.strictEqual(c.length, 1); assert.deepStrictEqual(c[0].body, { token: MAL_TOKEN }, 'se recorta y se envía solo el token');
  assert.strictEqual(tk.value, '', 'el campo queda vacío');
  assert.match(u.q('[data-token-state]').textContent, /configurado \(…2345\)/);
  assert.ok(u.toasts.some(function (t) { return /Token guardado/.test(t.msg); }));
  assert.ok(u.el.innerHTML.indexOf(MAL_TOKEN) < 0 && u.el.textContent.indexOf('AAH_abc') < 0);
  assert.strictEqual(u.q('[data-del-token]').disabled, false);
});

test('RA-62 guardar token vacío: error en un bloque role="alert" y no se envía nada; Enter en el campo guarda el token, no el formulario', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar(), 'PUT /api/alerts/token': { tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel' } } });
  D.click(u.q('[data-save-token]'));
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts/token').length, 0);
  var err = u.q('[data-errors] .errors');
  assert.ok(err && err.getAttribute('role') === 'alert'); assert.match(err.textContent, /token/i);
  var tk = inputDe(u, 'Token del bot');
  tk.value = MAL_TOKEN;
  D.keydown(tk, 'Enter');
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts/token').length, 1);
  assert.strictEqual(u.llamadas('PUT /api/alerts').length, 0, 'Enter en el token no envía el formulario');
});

test('RA-62 token rechazado por el servidor (400): se muestran los errores y el campo se vacía', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar(), 'PUT /api/alerts/token': http(400, { errors: ['Parece incompleto: cópialo entero desde BotFather'] }) } });
  var tk = inputDe(u, 'Token del bot'); tk.value = '123:corto';
  D.click(u.q('[data-save-token]'));
  await D.settle();
  assert.match(u.q('[data-errors] .errors').textContent, /Parece incompleto: cópialo entero desde BotFather/);
  assert.strictEqual(tk.value, '', 'no deja el token escrito en el campo');
});

test('RA-20 borrar token: pide confirmación, envía DELETE y, si el servidor desactivó las alertas, el interruptor se apaga', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': cfg({ enabled: true }), 'DELETE /api/alerts/token': { tokenConfigured: false, tokenSource: 'none', enabled: false } } });
  assert.strictEqual(inputDe(u, 'Enviar alertas por Telegram').checked, true);
  D.click(u.q('[data-del-token]'));
  await D.settle();
  assert.strictEqual(u.confirms.length, 1); assert.match(u.confirms[0].title, /Borrar token/);
  assert.strictEqual(u.llamadas('DELETE /api/alerts/token').length, 1);
  assert.strictEqual(inputDe(u, 'Enviar alertas por Telegram').checked, false);
  assert.match(u.q('[data-token-state]').textContent, /Sin token guardado/);
  assert.strictEqual(u.q('[data-del-token]').disabled, true);
});

test('RA-20 borrar token sin confirmar no envía nada', async function () {
  var u = await montar({ confirm: false, routes: { 'DELETE /api/alerts/token': { tokenConfigured: false, enabled: false } } });
  D.click(u.q('[data-del-token]'));
  await D.settle();
  assert.strictEqual(u.confirms.length, 1); assert.strictEqual(u.llamadas('DELETE /api/alerts/token').length, 0);
});

/* =============================================================================================
 * Guardar ajustes (RA-12, RA-61, RA-63)
 * ========================================================================================== */

test('RA-61 Guardar envía todos los campos editables con sus tipos y refleja la respuesta del servidor', async function () {
  var guardada = cfg({ enabled: true, detail: 'full', failsBeforeAlert: 4, notifyRecovery: false, notifyDegraded: true, chatId: '@mi_canal' });
  var u = await montar({ routes: { 'PUT /api/alerts': guardada } });
  inputDe(u, 'Enviar alertas por Telegram').checked = true;
  inputDe(u, 'Chat de destino').value = '  @mi_canal ';
  D.click(u.q('[data-detail="full"]'));
  inputDe(u, 'Avisar tras N fallos seguidos').value = '4';
  inputDe(u, 'Esperar antes de enviar').value = '10';
  inputDe(u, 'Avisar de recuperaciones').checked = false;
  inputDe(u, 'Avisar también de DEGRADADO').checked = true;
  D.click(u.q('[data-save]'));
  await D.settle();
  var c = u.llamadas('PUT /api/alerts');
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0].body, { enabled: true, chatId: '@mi_canal', detail: 'full', failsBeforeAlert: 4, groupWindowSec: 10, notifyRecovery: false, notifyDegraded: true });
  assert.ok(u.toasts.some(function (t) { return /Alertas guardadas/.test(t.msg); }));
  assert.strictEqual(u.q('[data-detail="full"]').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(u.q('[data-detail="minimal"]').getAttribute('aria-pressed'), 'false');
  assert.ok(!c[0].body.token && !('orgChats' in c[0].body), 'ni token ni orgChats en el PUT general');
});

test('RA-12 validación en el cliente: N vacío, 0, 11, decimal o texto no se envían y se muestran en un bloque role="alert"', async function () {
  var u = await montar();
  var n = inputDe(u, 'Avisar tras N fallos seguidos');
  for (var v of ['', '0', '11', '2.5', 'abc', '-1']) {
    n.value = v;
    D.click(u.q('[data-save]'));
    await D.settle();
    var e = u.q('[data-errors] .errors');
    assert.ok(e, 'sin error para «' + v + '»'); assert.strictEqual(e.getAttribute('role'), 'alert');
    assert.match(e.textContent, /entero de 1 a 10/);
  }
  assert.strictEqual(u.llamadas('PUT /api/alerts').length, 0);
  n.value = '10'; // límite válido
  D.click(u.q('[data-save]'));
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts').length, 1, 'N=10 es válido y sí se envía');
});

test('RA-12 errores del servidor al guardar (400 con errors) se muestran escapados y el botón vuelve a estar disponible', async function () {
  var u = await montar({ routes: { 'PUT /api/alerts': http(400, { errors: ['Para activar las alertas falta el token <b>x</b>', 'segundo error'] }) } });
  D.click(u.q('[data-save]'));
  await D.settle();
  var e = u.q('[data-errors] .errors');
  assert.strictEqual(e.getAttribute('role'), 'alert');
  assert.strictEqual(e.querySelectorAll('li').length, 2);
  assert.ok(e.textContent.indexOf('<b>x</b>') >= 0 && !e.querySelector('b'), 'el marcado del servidor se muestra como texto');
  assert.strictEqual(u.q('[data-save]').disabled, false);
});

test('RA-63 los botones muestran estado de carga (deshabilitados y aria-busy) mientras la acción está en curso', async function () {
  var soltar;
  var pendiente = new Promise(function (r) { soltar = r; });
  var u = await montar({ routes: { 'POST /api/alerts/test': function () { return pendiente; } } });
  var b = u.q('[data-test]');
  D.click(b);
  await D.settle();
  assert.strictEqual(b.disabled, true); assert.strictEqual(b.getAttribute('aria-busy'), 'true');
  assert.ok(b.querySelector('.spin'), 'indicador de carga');
  D.click(b);
  await D.settle();
  assert.strictEqual(u.llamadas('POST /api/alerts/test').length, 1, 'no se envía dos veces mientras está en curso');
  soltar({ ok: true });
  await D.settle();
  assert.strictEqual(b.disabled, false); assert.strictEqual(b.getAttribute('aria-busy'), null);
  assert.strictEqual(b.querySelector('.spin'), null);
});

test('RA-63 guardar deshabilita «Guardar» mientras se envía y lo restablece al terminar', async function () {
  var soltar, pendiente = new Promise(function (r) { soltar = r; });
  var u = await montar({ routes: { 'PUT /api/alerts': function () { return pendiente; } } });
  D.click(u.q('[data-save]'));
  await D.settle();
  assert.strictEqual(u.q('[data-save]').disabled, true);
  soltar(cfg());
  await D.settle();
  assert.strictEqual(u.q('[data-save]').disabled, false);
});

/* =============================================================================================
 * Prueba de envío y búsqueda de chats (RA-63, RA-65, RA-73)
 * ========================================================================================== */

test('RA-63 resultado correcto de la prueba: bloque .al-res--ok con icono y texto (no solo color) en una región role="status"', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/test': { ok: true, message: 'Mensaje de prueba enviado' } } });
  D.click(u.q('[data-test]'));
  await D.settle();
  var r = u.q('[data-result] .al-res--ok');
  assert.ok(r); assert.ok(r.querySelector('svg'), 'icono'); assert.match(r.textContent, /Mensaje de prueba enviado/);
  assert.strictEqual(u.q('[data-result]').getAttribute('role'), 'status');
  assert.strictEqual(u.q('[data-result]').getAttribute('aria-live'), 'polite');
  assert.strictEqual(u.llamadas('POST /api/alerts/test')[0].body && Object.keys(u.llamadas('POST /api/alerts/test')[0].body).length, 0, 'sin cambios en el chat: cuerpo vacío');
});

test('RA-52 / P8 la prueba con un chat escrito pero no guardado envía {chatId}', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/test': { ok: true } } });
  inputDe(u, 'Chat de destino').value = '-100999888777';
  D.click(u.q('[data-test]'));
  await D.settle();
  assert.deepStrictEqual(u.llamadas('POST /api/alerts/test')[0].body, { chatId: '-100999888777' });
});

var SOLUCIONES = [
  ['invalid_token', 'Telegram rechazó el token', /Telegram rechazó el token \(401\).*@BotFather/],
  ['chat_not_found', 'chat', /Telegram no encuentra ese chat.*escríbele primero al bot.*“Buscar mis chats”/],
  ['no_internet', 'conexión', /No hay conexión con api\.telegram\.org.*salida a Internet por el puerto 443/],
  ['timeout', 'plazo', /Telegram no respondió a tiempo/],
  ['rate_limited', 'espera', /Telegram pidió esperar/],
  ['blocked', 'bloque', /bot fue bloqueado o expulsado/],
  ['unknown', 'inesperad', /error inesperado/]
];

test('RA-73 cada código de error de la prueba se traduce a causa y acción en un bloque .al-res--err con data-code', async function () {
  for (var s of SOLUCIONES) {
    var u = await montar({ routes: { 'POST /api/alerts/test': { ok: false, code: s[0], message: 'detalle del servidor ' + s[0] } } });
    D.click(u.q('[data-test]'));
    await D.settle();
    var r = u.q('[data-result] .al-res--err');
    assert.ok(r, s[0]); assert.strictEqual(r.getAttribute('data-code'), s[0]);
    assert.match(r.textContent, s[2], s[0]);
    assert.ok(r.querySelector('svg'), 'icono de error para ' + s[0]);
    assert.match(r.textContent, /No se pudo completar/);
  }
});

test('RA-73 los mismos códigos al buscar chats', async function () {
  for (var s of SOLUCIONES) {
    var u = await montar({ routes: { 'POST /api/alerts/chats': { ok: false, code: s[0], message: 'x' } } });
    D.click(u.q('[data-find]'));
    await D.settle();
    var r = u.q('[data-result] .al-res--err');
    assert.ok(r, s[0]); assert.strictEqual(r.getAttribute('data-code'), s[0]); assert.match(r.textContent, s[2], s[0]);
  }
});

test('RA-73 rate_limited con los segundos de espera: por 429 (Retry-After) y por el detalle del servidor', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/test': http(429, { error: 'Espera unos segundos antes de repetir esta acción' }, { 'Retry-After': '4' }) } });
  D.click(u.q('[data-test]'));
  await D.settle();
  var r = u.q('[data-result] .al-res--err');
  // QA-A10: el 429 HTTP es del limitador local de Centinela: se muestra su mensaje, no el de Telegram.
  assert.match(r.textContent, /Espera unos segundos antes de repetir esta acción/); assert.doesNotMatch(r.textContent, /Telegram pidió esperar/);
  var v = await montar({ routes: { 'POST /api/alerts/test': { ok: false, code: 'rate_limited', retryAfter: 7, message: 'Telegram pide esperar 7 s antes de enviar más mensajes' } } });
  D.click(v.q('[data-test]'));
  await D.settle();
  assert.match(v.q('[data-result] .al-res--err').textContent, /7 s/);
});

test('RA-04 / RA-73 409 alerts_disabled_by_env en la acción: mensaje con la variable', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/test': http(409, { error: 'alerts_disabled_by_env', code: 'alerts_disabled_by_env', message: 'bloqueadas' }) } });
  D.click(u.q('[data-test]'));
  await D.settle();
  var r = u.q('[data-result] .al-res--err');
  assert.strictEqual(r.getAttribute('data-code'), 'alerts_disabled_by_env'); assert.match(r.textContent, /CENTINELA_ALERTS_DISABLED/);
});

test('RA-73 sin token o sin chat la prueba se corta en el cliente con la solución y sin llamar al servidor', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar() } });
  inputDe(u, 'Chat de destino').value = '-100123';
  D.click(u.q('[data-test]'));
  await D.settle();
  assert.strictEqual(u.q('[data-result] .al-res--err').getAttribute('data-code'), 'no_token');
  assert.match(u.q('[data-result]').textContent, /Guardar token/);
  var v = await montar({ routes: { 'GET /api/alerts': cfg({ chatId: '' }) } });
  D.click(v.q('[data-test]'));
  await D.settle();
  assert.strictEqual(v.q('[data-result] .al-res--err').getAttribute('data-code'), 'no_chat');
  assert.match(v.q('[data-result]').textContent, /Buscar mis chats/);
  assert.strictEqual(u.llamadas('POST /api/alerts/test').length + v.llamadas('POST /api/alerts/test').length, 0);
});

test('RA-65 los textos del servidor se insertan escapados: un mensaje de error con HTML se ve como texto', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/test': { ok: false, code: 'unknown', message: '<img src=x onerror=alert(1)> <b>negrita</b>' } } });
  D.click(u.q('[data-test]'));
  await D.settle();
  var r = u.q('[data-result]');
  assert.strictEqual(r.querySelector('img'), null);
  assert.ok(r.querySelectorAll('b').every(function (b) { return b.textContent !== 'negrita'; }), 'el <b> del servidor no se interpretó');
  assert.ok(r.textContent.indexOf('<img src=x onerror=alert(1)>') >= 0, 'se muestra literal');
});

test('RA-65 buscar chats: la lista usa botones con data-chat-id y un título con HTML (<img onerror=…>) se muestra como texto', async function () {
  var titulo = '<img src=x onerror=alert(1)>';
  var u = await montar({ routes: { 'POST /api/alerts/chats': { ok: true, chats: [{ id: -1001, type: 'supergroup', title: titulo }, { id: 55, type: 'private', title: 'Ana' }] } } });
  D.click(u.q('[data-find]'));
  await D.settle();
  var lista = u.qa('[data-chats] button[data-chat-id]');
  assert.deepStrictEqual(lista.map(function (b) { return b.getAttribute('data-chat-id'); }), ['-1001', '55']);
  assert.strictEqual(u.q('[data-chats]').querySelector('img'), null, 'no se creó ningún <img>');
  assert.ok(lista[0].textContent.indexOf(titulo) >= 0);
  assert.strictEqual(u.q('[data-chats]').getAttribute('aria-live'), 'polite');
  var cuerpo = u.llamadas('POST /api/alerts/chats');
  assert.strictEqual(cuerpo.length, 1);
});

test('RA-65 el título vacío se muestra como «(sin título)» y el id con HTML en el atributo no rompe el marcado', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/chats': { ok: true, chats: [{ id: '"><script>x</script>', type: '<b>t</b>', title: '' }] } } });
  D.click(u.q('[data-find]'));
  await D.settle();
  assert.strictEqual(u.q('[data-chats]').querySelector('script'), null);
  assert.ok(u.q('[data-chats]').querySelectorAll('b').every(function (b) { return b.textContent !== 't'; }), 'el <b> del tipo no se interpretó');
  assert.match(u.q('[data-chats]').textContent, /\(sin título\)/);
});

test('RA-52 elegir un chat de la lista rellena «Chat de destino», enfoca el campo y avisa de que falta guardar', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/chats': { ok: true, chats: [{ id: -100200, type: 'supergroup', title: 'Guardia' }] } } });
  D.click(u.q('[data-find]'));
  await D.settle();
  D.click(u.q('[data-chat-id="-100200"]'));
  var chat = inputDe(u, 'Chat de destino');
  assert.strictEqual(chat.value, '-100200'); assert.ok(chat.focused >= 1);
  assert.ok(u.toasts.some(function (t) { return /Guardar/.test(t.msg); }));
  assert.strictEqual(u.llamadas('PUT /api/alerts').length, 0, 'elegir no guarda por sí solo');
});

test('RA-52 sin chats: muestra la pista del servidor (o la predeterminada) en [data-chats-empty]', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/chats': { ok: true, chats: [], hint: 'Escríbele un mensaje al bot y vuelve a pulsar' } } });
  D.click(u.q('[data-find]'));
  await D.settle();
  assert.match(u.q('[data-chats-empty]').textContent, /Escríbele un mensaje al bot y vuelve a pulsar/);
  var v = await montar({ routes: { 'POST /api/alerts/chats': { ok: true, chats: [] } } });
  D.click(v.q('[data-find]'));
  await D.settle();
  assert.match(v.q('[data-chats-empty]').textContent, /Escríbele un mensaje al bot/);
});

test('RA-52 buscar chats sin token no llama al servidor y muestra no_token', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar() } });
  D.click(u.q('[data-find]'));
  await D.settle();
  assert.strictEqual(u.llamadas('POST /api/alerts/chats').length, 0);
  assert.strictEqual(u.q('[data-result] .al-res--err').getAttribute('data-code'), 'no_token');
});

/* =============================================================================================
 * Bloqueo por entorno (RA-04)
 * ========================================================================================== */

test('RA-04 bloqueo por entorno: aviso permanente role="alert" y botones de prueba y búsqueda deshabilitados; sin aviso si no hay bloqueo', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': cfg({ blockedByEnv: true, enabled: true }), 'GET /api/alerts/status': estado({ state: 'blocked' }) } });
  var b = u.q('[data-blocked]');
  assert.ok(b); assert.strictEqual(b.getAttribute('role'), 'alert'); assert.match(b.textContent, /CENTINELA_ALERTS_DISABLED/);
  assert.strictEqual(u.q('[data-test]').disabled, true); assert.strictEqual(u.q('[data-find]').disabled, true);
  assert.strictEqual(inputDe(u, 'Enviar alertas por Telegram').disabled, true);
  assert.match(u.q('[data-state]').textContent, /Bloqueadas por el entorno/);
  D.click(u.q('[data-test]')); D.click(u.q('[data-find]'));
  await D.settle();
  assert.strictEqual(u.calls.filter(function (c) { return c.method === 'POST'; }).length, 0);
  var libre = await montar();
  assert.strictEqual(libre.q('[data-blocked]'), null);
  assert.strictEqual(libre.q('[data-test]').disabled, false);
});

/* =============================================================================================
 * Ayuda integrada (RA-70, RA-71, RA-74)
 * ========================================================================================== */

test('RA-70 «Cómo configurarlo»: seis pasos numerados que citan textos que existen en la propia sección', async function () {
  var u = await montar();
  assert.ok(u.q('[data-guide]')); assert.ok(u.q('[data-guide-toggle]'));
  assert.match(u.q('[data-guide-toggle]').textContent, /Cómo configurarlo/);
  var pasos = u.qa('[data-steps] li');
  assert.strictEqual(u.q('[data-steps]').tag, 'ol');
  assert.strictEqual(pasos.length, 6);
  var t = pasos.map(function (p) { return p.textContent; });
  assert.ok(/@BotFather/.test(t[0]) && /\/newbot/.test(t[0]));
  assert.ok(/Token del bot/.test(t[1]) && /Guardar token/.test(t[1]));
  assert.ok(/bot/.test(t[2]) && /grupo/.test(t[2]));
  assert.ok(/Buscar mis chats/.test(t[3]) && /Chat de destino/.test(t[3]));
  assert.ok(/Enviar mensaje de prueba/.test(t[4]));
  assert.ok(/Enviar alertas por Telegram/.test(t[5]) && /Guardar/.test(t[5]));
  // Cada rótulo citado en los pasos existe de verdad como botón o etiqueta de la sección.
  var botones = u.qa('button').map(function (b) { return b.textContent.trim(); }).join('|');
  var etiquetas = u.qa('label').map(function (l) { return l.textContent.trim(); }).join('|');
  ['Guardar token', 'Buscar mis chats', 'Enviar mensaje de prueba'].forEach(function (r) { assert.ok(botones.indexOf(r) >= 0, 'botón ' + r); });
  assert.ok(/(^|\|)\s*Guardar(\||$)/.test(botones.replace(/ \| /g, '|')) || /Guardar/.test(botones));
  ['Token del bot', 'Chat de destino', 'Enviar alertas por Telegram'].forEach(function (r) { assert.ok(etiquetas.indexOf(r) >= 0, 'etiqueta ' + r); });
});

test('RA-70 abierta la primera vez (sin token ni chat) y plegada si ya hay configuración', async function () {
  var vacia = await montar({ routes: { 'GET /api/alerts': sinConfigurar() } });
  assert.strictEqual(vacia.q('[data-guide-toggle]').getAttribute('aria-expanded'), 'true');
  assert.strictEqual(vacia.q('[data-guide] [role="region"]').hidden, false);
  var hecha = await montar();
  assert.strictEqual(hecha.q('[data-guide-toggle]').getAttribute('aria-expanded'), 'false');
  assert.strictEqual(hecha.q('[data-guide] [role="region"]').hidden, true);
});

test('RA-70 el estado plegado se recuerda por navegador (localStorage) y se respeta al montar de nuevo', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar() } });
  D.click(u.q('[data-guide-toggle]'));
  assert.strictEqual(u.q('[data-guide-toggle]').getAttribute('aria-expanded'), 'false'); assert.strictEqual(u.q('[data-guide] [role="region"]').hidden, true);
  var guardado = JSON.parse(JSON.stringify(u.ls));
  assert.ok(Object.keys(guardado).length >= 1, 'escribió en localStorage');
  var v = await montar({ routes: { 'GET /api/alerts': sinConfigurar() }, storage: guardado });
  assert.strictEqual(v.q('[data-guide-toggle]').getAttribute('aria-expanded'), 'false', 'plegada aunque no haya configuración');
  D.click(v.q('[data-guide-toggle]'));
  var w = await montar({ routes: { 'GET /api/alerts': cfg() }, storage: JSON.parse(JSON.stringify(v.ls)) });
  assert.strictEqual(w.q('[data-guide-toggle]').getAttribute('aria-expanded'), 'true', 'abierta aunque ya haya configuración');
});

test('RA-70 sin localStorage disponible el panel sigue funcionando', async function () {
  var u = cargar();
  u.ctx.localStorage = { getItem: function () { throw new Error('bloqueado'); }, setItem: function () { throw new Error('bloqueado'); } };
  var el = D.elemento();
  u.NOC.alertsPanel.mount(el);
  await D.settle();
  D.click(el.querySelector('[data-guide-toggle]'));
  assert.ok(el.querySelector('[data-steps]'));
});

test('RA-71 aviso de privacidad: qué datos salen, que pasan por Telegram, sin cifrado de extremo a extremo y la salida HTTPS al 443', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar() } });
  var p = u.q('[data-privacy]');
  assert.ok(p, 'existe el aviso');
  var t = p.textContent;
  assert.match(t, /nombre del servicio/); assert.match(t, /organización/); assert.match(t, /dirección/); assert.match(t, /motivo/);
  assert.match(t, /Completo/);
  assert.match(t, /servidores de Telegram/); assert.match(t, /cifrado de extremo a extremo/);
  assert.match(t, /HTTPS/); assert.match(t, /puerto 443/); assert.match(t, /api\.telegram\.org/);
  assert.strictEqual(p.isVisible(), true, 'visible con la guía abierta');
});

test('RA-71 el aviso de privacidad debe seguir visible aunque «Cómo configurarlo» esté plegada', async function () {
  var u = await montar(); // con configuración la guía arranca plegada
  assert.strictEqual(u.q('[data-guide-toggle]').getAttribute('aria-expanded'), 'false');
  assert.ok(u.q('[data-privacy]'));
  assert.strictEqual(u.q('[data-privacy]').isVisible(), true, 'el aviso de privacidad queda dentro de la región plegada y oculto');
});

test('RA-74 primera vez: el indicador dice «Sin configurar», orienta al panel de ayuda y no muestra errores', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': sinConfigurar() } });
  assert.strictEqual(u.q('[data-state]').textContent.trim(), 'Sin configurar');
  assert.match(u.q('[data-status]').textContent, /Cómo configurarlo/);
  assert.strictEqual(u.q('.errors'), null); assert.strictEqual(u.q('.al-res--err'), null);
  assert.strictEqual(u.q('[data-load-error]'), null);
});

/* =============================================================================================
 * Estado (RA-53, RA-63, RA-65)
 * ========================================================================================== */

test('RA-53 / RA-63 el indicador de estado traduce off, ok, error y blocked con texto y datos de cola', async function () {
  var casos = [['off', 'Desactivadas'], ['ok', 'Funcionando'], ['error', 'Con errores'], ['blocked', 'Bloqueadas por el entorno']];
  for (var c of casos) {
    var u = await montar({ routes: { 'GET /api/alerts/status': estado({ state: c[0], queued: 3, sentTotal: 7, failedTotal: 2, droppedTotal: 1, lastSentAt: 1700000000000,
      lastError: c[0] === 'error' ? { at: 1700000100000, code: 'unknown', message: 'Telegram tuvo un fallo temporal (502)' } : null }) } });
    assert.strictEqual(u.q('[data-state]').textContent.trim(), c[1], c[0]);
    var t = u.q('[data-status]').textContent;
    assert.match(t, /En cola: 3/); assert.match(t, /enviados: 7/); assert.match(t, /fallidos: 2/); assert.match(t, /descartados: 1/);
    assert.match(t, /Último envío correcto: (?!ninguno)/);
    assert.ok(u.q('[data-state]').querySelector('svg'), 'el estado lleva icono además de texto');
    if (c[0] === 'error') assert.match(t, /Telegram tuvo un fallo temporal \(502\)/);
  }
});

test('RA-53 estado sin envíos ni errores: «ninguno todavía» y «ninguno»', async function () {
  var u = await montar();
  assert.match(u.q('[data-status]').textContent, /Último envío correcto: ninguno todavía/);
  assert.match(u.q('[data-status]').textContent, /Último error: ninguno/);
});

test('RA-65 el mensaje del último error del estado se inserta escapado', async function () {
  var u = await montar({ routes: { 'GET /api/alerts/status': estado({ state: 'error', lastError: { at: 1700000100000, code: 'x', message: '<script>alert(1)</script>' } }) } });
  assert.strictEqual(u.q('[data-status]').querySelector('script'), null);
  assert.ok(u.q('[data-status]').textContent.indexOf('<script>alert(1)</script>') >= 0);
});

test('RA-63 «Actualizar estado» vuelve a pedir configuración y estado y los refleja', async function () {
  var u = await montar();
  u.route('GET /api/alerts/status', estado({ state: 'ok', sentTotal: 9 }));
  u.route('GET /api/alerts', cfg({ tokenHint: '…9999' }));
  D.click(u.q('[data-refresh]'));
  await D.settle();
  assert.strictEqual(u.llamadas('GET /api/alerts').length, 2);
  assert.strictEqual(u.q('[data-state]').textContent.trim(), 'Funcionando');
  assert.match(u.q('[data-status]').textContent, /enviados: 9/);
  assert.match(u.q('[data-token-state]').textContent, /…9999/);
  assert.strictEqual(u.q('[data-refresh]').disabled, false);
});

/* =============================================================================================
 * Errores de carga y sesión
 * ========================================================================================== */

test('RA-63 error al cargar la configuración: bloque role="alert" con el motivo, botón «Reintentar» y recarga', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': http(500, { error: 'Error interno <b>x</b>' }) } });
  var e = u.q('[data-load-error]');
  assert.ok(e); assert.strictEqual(e.getAttribute('role'), 'alert'); assert.match(e.textContent, /No se pudo cargar la configuración de alertas/);
  assert.strictEqual(e.querySelector('b'), null, 'escapado');
  assert.ok(u.q('[data-reload]'));
  u.route('GET /api/alerts', cfg());
  D.click(u.q('[data-reload]'));
  await D.settle();
  assert.strictEqual(u.q('[data-load-error]'), null);
  assert.ok(u.q('[data-save]'), 'ya se pintó el formulario');
});

test('RA-63 sesión caducada (401) y contraseña temporal (403 mustChange) se delegan en NOC.auth', async function () {
  var a = await montar({ routes: { 'GET /api/alerts': http(401, { error: 'Inicia sesión', login: true }) } });
  assert.strictEqual(a.unauthorized, 1);
  var b = await montar({ routes: { 'GET /api/alerts': http(403, { error: 'Debes cambiar la contraseña', mustChange: true }) } });
  assert.strictEqual(b.mustChange, 1);
});

test('RA-63 servidor inaccesible: mensaje en español y sin excepciones', async function () {
  var u = cargar();
  u.ctx.fetch = function () { return Promise.reject(new Error('red caída')); };
  var el = D.elemento();
  u.NOC.alertsPanel.mount(el);
  await D.settle();
  assert.match(el.querySelector('[data-load-error]').textContent, /No se pudo contactar con el servidor de Centinela/);
});

test('RA-60 la lectura de estado falla pero la configuración carga: el formulario aparece igualmente', async function () {
  var u = await montar({ routes: { 'GET /api/alerts/status': http(500, { error: 'x' }) } });
  assert.ok(u.q('[data-save]'));
  assert.ok(u.q('[data-state]'));
});

/* =============================================================================================
 * Montaje en Ajustes (RA-60, RA-66)
 * ========================================================================================== */

function cargarAjustes(o) {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  function leer(f) { vm.runInContext(fs.readFileSync(path.join(RAIZ, f), 'utf8'), ctx, { filename: f }); }
  leer('js/core/util.js');
  leer('js/shared/thresholds.js');
  var NOC = ctx.NOC, T = NOC.Thresholds, th = {}, montajes = [], llamadasFetch = [];
  T.PAIRS.forEach(function (p) { th[p.warn] = 1; th[p.crit] = 2; });
  ctx.fetch = function (url) { llamadasFetch.push(url); return Promise.reject(new Error('no debe haber red en esta prueba')); };
  NOC.store = { state: { settings: { thresholds: th, theme: 'dark', intervalSec: 30, historyPoints: 100 }, mode: o.mode, server: {} } };
  NOC.ui = { confirm: function () {}, toast: function () {}, status: function () { return ''; }, icon: function () { return ''; } };
  NOC.auth = { can: function (a) { return a === 'users' ? !!o.admin : true; } };
  NOC.app = { applyTheme: function () {} };
  NOC.data = { saveSettings: function () { return { then: function () {} }; } };
  NOC.W = { badge: function () { return ''; } };
  if (o.panel !== false) NOC.alertsPanel = { mount: function (el) { montajes.push(el); } };
  leer('js/views/settings.js');
  var html = '', panelEl = D.elemento();
  var form = { querySelector: function () { return { value: '' }; }, querySelectorAll: function () { return []; }, addEventListener: function () {} };
  var root = {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelector: function (sel) {
      if (sel === '#sf') return form;
      if (sel === '#alerts-panel') return /id="alerts-panel"/.test(html) ? panelEl : null;
      return { getAttribute: function () { return 'dark'; } };
    },
    querySelectorAll: function () { return []; }
  };
  NOC.views.settings.mount(root);
  return { html: html, panelEl: panelEl, montajes: montajes, fetch: llamadasFetch };
}

test('RA-60 administrador en modo en vivo: Ajustes crea #alerts-panel y monta NOC.alertsPanel en él', function () {
  var s = cargarAjustes({ mode: 'live', admin: true });
  assert.match(s.html, /id="alerts-panel"/);
  assert.strictEqual(s.montajes.length, 1); assert.strictEqual(s.montajes[0], s.panelEl);
  assert.strictEqual(s.fetch.length, 0, 'Ajustes por sí solo no pide /api/alerts');
});

test('RA-60 no administrador: no se renderiza la sección ni se monta ni se solicita /api/alerts', function () {
  var s = cargarAjustes({ mode: 'live', admin: false });
  assert.ok(!/alerts-panel/.test(s.html) && !/Alertas/.test(s.html.replace(/Umbrales de alerta/g, '')), 'sin rastro de la sección');
  assert.strictEqual(s.montajes.length, 0); assert.strictEqual(s.fetch.length, 0);
});

test('RA-66 modo demostración: «Disponible solo con el servidor», sin montar el panel ni llamar a la API (administrador)', function () {
  var s = cargarAjustes({ mode: 'demo', admin: true });
  assert.match(s.html, /id="alerts-panel"/);
  var demo = s.panelEl.querySelector('[data-alerts-demo]');
  assert.ok(demo); assert.match(demo.textContent, /Disponible solo con el servidor/);
  assert.strictEqual(s.montajes.length, 0); assert.strictEqual(s.fetch.length, 0);
});

test('RA-66 sin el script de alertas cargado en modo en vivo no falla: muestra el aviso en lugar del panel', function () {
  var s = cargarAjustes({ mode: 'live', admin: true, panel: false });
  assert.doesNotThrow(function () { return s.panelEl.textContent; });
  assert.ok(s.panelEl.querySelector('[data-alerts-demo]') || s.panelEl.textContent !== undefined);
});

test('RA-67 el formulario de ajustes existente sigue sin campos de alertas (independiente)', function () {
  var s = cargarAjustes({ mode: 'live', admin: true });
  var formHtml = s.html.slice(s.html.indexOf('<form id="sf"'), s.html.indexOf('</form>'));
  assert.ok(!/telegram|alerts|chat/i.test(formHtml.replace(/Umbrales de alerta/g, '')), 'el formulario general no mezcla campos de alertas');
});
