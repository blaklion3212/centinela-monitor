'use strict';
/*
 * Alertas por Telegram: interfaz (js/views/alerts.js), correcciones de la revisión de calidad y seguridad: QA-A5 (campo chat tras
 * migración y PUT sin chatId si no cambió), QA-A10 (429 del limitador local), QA-A11 (Enter con el botón ocupado) y SEC-A10
 * (username del chat). Mismo enfoque que alerts-ui.test.js: vm + mini-DOM + fetch simulado, sin red ni servidor.
 */
var test = require('node:test');
var assert = require('node:assert');
var L = require('./helpers/alerts-ui-loader');
var D = L.D, cfg = L.cfg, http = L.http, montar = L.montar, inputDe = L.inputDe;

/* ---------------- QA-A5 ---------------- */

test('QA-A5 tras una migración, la prueba devuelve chatId/migratedTo y la interfaz actualiza el campo «Chat de destino»', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/test': { ok: true, message: 'Mensaje de prueba enviado', chatId: '-1009990001112', migratedTo: '-1009990001112' } } });
  var chat = inputDe(u, 'Chat de destino');
  assert.strictEqual(chat.value, '-1001234567890');
  D.click(u.q('[data-test]'));
  await D.settle();
  assert.strictEqual(u.llamadas('POST /api/alerts/test').length, 1);
  assert.strictEqual(chat.value, '-1009990001112', 'el campo refleja el chat nuevo');
  assert.ok(u.q('[data-result] .al-res--ok'), 'la prueba se muestra como correcta');
});

test('QA-A5 tras migrar, un Guardar sin cambios del usuario NO envía chatId (no pisa el chat nuevo con el viejo)', async function () {
  var u = await montar({ routes: {
    'POST /api/alerts/test': { ok: true, chatId: '-1009990001112', migratedTo: '-1009990001112' },
    'PUT /api/alerts': function (b) { return cfg(Object.assign({ chatId: '-1009990001112' }, b)); } } });
  D.click(u.q('[data-test]'));
  await D.settle();
  D.click(u.q('[data-save]'));
  await D.settle();
  var put = u.llamadas('PUT /api/alerts');
  assert.strictEqual(put.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(put[0].body, 'chatId'), 'sin chatId en el cuerpo: ' + JSON.stringify(put[0].body));
  assert.strictEqual(inputDe(u, 'Chat de destino').value, '-1009990001112');
});

test('QA-A5 el PUT sin cambios en el chat no incluye chatId, y sí lo incluye cuando el usuario lo edita', async function () {
  var u = await montar({ routes: { 'PUT /api/alerts': function (b) { return cfg(b); } } });
  D.click(u.q('[data-save]'));
  await D.settle();
  assert.ok(!('chatId' in u.llamadas('PUT /api/alerts')[0].body), 'sin editar: no se envía');
  inputDe(u, 'Chat de destino').value = '  -100555666777  ';
  D.click(u.q('[data-save]'));
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts')[1].body.chatId, '-100555666777', 'editado: se envía recortado');
});

test('QA-A5 una prueba sin migración (sin chatId en la respuesta) no toca el campo que el usuario está editando', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/test': { ok: true } } });
  var chat = inputDe(u, 'Chat de destino');
  chat.value = '-100999888777';
  D.click(u.q('[data-test]'));
  await D.settle();
  assert.strictEqual(chat.value, '-100999888777');
});

/* ---------------- QA-A10 ---------------- */

test('QA-A10 un 429 HTTP del limitador local muestra el mensaje del servidor (no el texto de Telegram) al probar y al buscar chats', async function () {
  var msg = 'Espera 5 s entre acciones de alertas';
  var u = await montar({ routes: {
    'POST /api/alerts/test': http(429, { error: msg }, { 'Retry-After': '5' }),
    'POST /api/alerts/chats': http(429, { error: 'Ya hay una acción de alertas en curso; espera a que termine' }, { 'Retry-After': '5' }) } });
  D.click(u.q('[data-test]'));
  await D.settle();
  var r = u.q('[data-result] .al-res--err');
  assert.ok(r, 'bloque de error');
  assert.ok(r.textContent.indexOf(msg) >= 0, r.textContent);
  assert.doesNotMatch(r.textContent, /Telegram pidió esperar/);
  D.click(u.q('[data-find]'));
  await D.settle();
  var r2 = u.q('[data-result] .al-res--err');
  assert.ok(r2 && /Ya hay una acción de alertas en curso/.test(r2.textContent), r2 && r2.textContent);
  assert.doesNotMatch(r2.textContent, /Telegram pidió esperar/);
});

test('QA-A10 el mensaje del 429 se inserta escapado y el botón vuelve a quedar disponible', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/test': http(429, { error: '<img src=x onerror=alert(1)>' }, { 'Retry-After': '5' }) } });
  D.click(u.q('[data-test]'));
  await D.settle();
  assert.strictEqual(u.q('[data-result]').querySelector('img'), null);
  assert.ok(u.q('[data-result]').textContent.indexOf('<img src=x onerror=alert(1)>') >= 0);
  assert.strictEqual(u.q('[data-test]').disabled, false);
});

/* ---------------- QA-A11 ---------------- */

test('QA-A11 Enter en el campo del token con «Guardar token» ocupado no envía una segunda petición', async function () {
  var soltar, pendiente = new Promise(function (r) { soltar = r; });
  var u = await montar({ routes: { 'PUT /api/alerts/token': function () { return pendiente; } } });
  var tk = inputDe(u, 'Token del bot');
  tk.value = L.MAL_TOKEN;
  D.keydown(tk, 'Enter');
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts/token').length, 1);
  assert.strictEqual(u.q('[data-save-token]').disabled, true, 'el botón está ocupado');
  D.keydown(tk, 'Enter');
  D.keydown(tk, 'Enter');
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts/token').length, 1, 'Enter con el botón ocupado no repite la petición');
  soltar({ tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel' });
  await D.settle();
  assert.strictEqual(u.q('[data-save-token]').disabled, false);
  tk.value = L.MAL_TOKEN;
  D.keydown(tk, 'Enter');
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts/token').length, 2, 'libre otra vez: Enter vuelve a funcionar');
});

test('QA-A11 Enter en el campo del token con el token gestionado por variable de entorno (botón bloqueado) no envía nada', async function () {
  var u = await montar({ routes: { 'GET /api/alerts': cfg({ tokenSource: 'env', tokenHint: '…7890' }) } });
  var tk = inputDe(u, 'Token del bot');
  tk.value = L.MAL_TOKEN;
  D.keydown(tk, 'Enter');
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts/token').length, 0);
});

test('QA-A11 Enter en el campo del chat con «Guardar» ocupado no envía otro PUT (el navegador no envía implícitamente un formulario con su botón deshabilitado)', async function () {
  var soltar, pendiente = new Promise(function (r) { soltar = r; });
  var u = await montar({ routes: { 'PUT /api/alerts': function () { return pendiente; } } });
  D.click(u.q('[data-save]'));
  await D.settle();
  assert.strictEqual(u.q('[data-save]').disabled, true);
  D.keydown(inputDe(u, 'Chat de destino'), 'Enter');
  await D.settle();
  assert.strictEqual(u.llamadas('PUT /api/alerts').length, 1);
  soltar(cfg());
  await D.settle();
});

/* ---------------- SEC-A10 ---------------- */

test('SEC-A10 buscar chats: la lista muestra el título, el tipo, el @username y el id, y la advertencia de comprobar con la prueba', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/chats': { ok: true, chats: [
    { id: -1001, type: 'channel', title: 'Avisos TI', username: 'avisos_ti' },
    { id: 55, type: 'private', title: 'Ana' }] } } });
  D.click(u.q('[data-find]'));
  await D.settle();
  var items = u.qa('[data-chats] button[data-chat-id]');
  assert.strictEqual(items.length, 2);
  assert.ok(/Avisos TI/.test(items[0].textContent) && /channel/.test(items[0].textContent), items[0].textContent);
  assert.ok(/@avisos_ti/.test(items[0].textContent), 'username con @: ' + items[0].textContent);
  assert.ok(/-1001/.test(items[0].textContent));
  assert.ok(!/@/.test(items[1].textContent), 'sin username no se inventa uno');
  var aviso = u.q('[data-chats-check]');
  assert.ok(aviso, 'texto de comprobación');
  assert.ok(aviso.textContent.indexOf('Comprueba con “Enviar mensaje de prueba” que es el chat correcto') >= 0, aviso.textContent);
});

test('SEC-A10 el username se escapa: un valor con HTML se muestra como texto y no crea elementos', async function () {
  var feo = '<img src=x onerror=alert(1)>';
  var u = await montar({ routes: { 'POST /api/alerts/chats': { ok: true, chats: [{ id: -1002, type: 'group', title: 'G', username: feo }] } } });
  D.click(u.q('[data-find]'));
  await D.settle();
  assert.strictEqual(u.q('[data-chats]').querySelector('img'), null, 'no se creó ningún <img>');
  assert.ok(u.q('[data-chats]').textContent.indexOf(feo) >= 0);
});

test('SEC-A10 con la lista vacía no se muestra la advertencia de comprobación', async function () {
  var u = await montar({ routes: { 'POST /api/alerts/chats': { ok: true, chats: [], hint: 'Escríbele un mensaje al bot y vuelve a pulsar' } } });
  D.click(u.q('[data-find]'));
  await D.settle();
  assert.strictEqual(u.q('[data-chats-check]'), null);
});
