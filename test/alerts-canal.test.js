'use strict';
/*
 * Alertas por Telegram: canal (server/lib/channels/telegram.js) contra el servidor de Telegram simulado local
 * (test/helpers/telegram-sim.js). Sin red externa. Requisitos: RA-22, RA-23, RA-36, RA-45 (clasificación), RA-52, RA-92,
 * RA-93, RA-95 y el anexo A (docs/requisitos/alertas.md).
 */
var test = require('node:test');
var assert = require('node:assert');
var net = require('net');
var tg = require('../server/lib/channels/telegram');
var simMod = require('./helpers/telegram-sim');
var R = simMod.R;

var TOKEN = '123456789:AAH_abcdefghijklmnopqrstuvwxyz012345';
var CHAT = '-1001234567890';
var sim = null;

test.before(async function () { sim = await simMod.start(); });
test.after(async function () { if (sim) await sim.close(); });
test.beforeEach(function () { sim.reset(); });

function canal(extra) { return tg.create(Object.assign({ apiBase: sim.base, timeoutMs: 2000 }, extra || {})); }
// Puerto en el que nadie escucha.
// Puerto 1 de loopback: privilegiado y sin servicio en las pruebas, así que siempre rechaza la conexión.
// (Un puerto efímero recién liberado podía ocuparlo otra prueba en paralelo y dar resultados intermitentes.)
function puertoCerrado() { return Promise.resolve(1); }
// Ningún texto devuelto puede contener el token, su parte numérica ni la ruta de la petición.
function sinFugas(res) {
  var s = JSON.stringify(res);
  assert.ok(s.indexOf(TOKEN) < 0, 'el token aparece en: ' + s);
  assert.ok(s.indexOf('123456789') < 0, 'la parte numérica del bot aparece en: ' + s);
  assert.ok(s.indexOf('AAH_abc') < 0, 'trozo del secreto en: ' + s);
  assert.ok(!/\/bot[^*]/.test(s), 'la ruta /bot... aparece en: ' + s);
}

/* ---------------- envío correcto y formato de la petición ---------------- */

test('RA-92 sendMessage: POST /bot<token>/sendMessage con chat_id como texto, texto plano y vista previa desactivada', async function () {
  var r = await canal().sendMessage(TOKEN, CHAT, '🔴 Portal: CAÍDO');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(sim.requests.length, 1);
  var q = sim.requests[0];
  assert.strictEqual(q.httpMethod, 'POST');
  assert.strictEqual(q.url, '/bot' + TOKEN + '/sendMessage');
  assert.strictEqual(q.body.chat_id, CHAT, 'chat_id viaja como cadena');
  assert.strictEqual(q.body.text, '🔴 Portal: CAÍDO');
  assert.deepStrictEqual(q.body.link_preview_options, { is_disabled: true });
  assert.strictEqual('parse_mode' in q.body, false, 'sin parse_mode: el texto es plano (RA-32)');
  assert.match(q.headers['content-type'], /application\/json/);
});

test('RA-92 sendMessage: un chat @canal también viaja tal cual y el resultado trae result', async function () {
  sim.on('sendMessage', R.ok({ message_id: 42 }));
  var r = await canal().sendMessage(TOKEN, '@mi_canal', 'hola');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.result, { message_id: 42 });
  assert.strictEqual(sim.sent()[0].body.chat_id, '@mi_canal');
});

test('RA-33 sendMessage: un texto de más de 4096 caracteres se recorta a 4096 como máximo (anexo A)', async function () {
  var largo = new Array(6001).join('a');
  await canal().sendMessage(TOKEN, CHAT, largo);
  var t = sim.sent()[0].body.text;
  assert.ok(t.length <= 4096, 'longitud ' + t.length);
  assert.ok(t.length >= 4000);
});

test('RA-33 sendMessage: no parte un par sustituto (emoji) al recortar', async function () {
  var largo = new Array(4095).join('a') + '🔴🔴🔴';
  await canal().sendMessage(TOKEN, CHAT, largo);
  var t = sim.sent()[0].body.text;
  assert.ok(t.length <= 4096);
  // Un sustituto huérfano al final sería un carácter 0xD800-0xDBFF sin su pareja.
  assert.ok(!/[\uD800-\uDBFF]$/.test(t.replace(/…$/, '')), 'texto termina con medio emoji');
});

test('RA-52 getMe: llama a /getMe y devuelve ok', async function () {
  var r = await canal().getMe(TOKEN);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sim.requests[0].apiMethod, 'getMe');
});

test('Anexo A getUpdates: sin offset, timeout=0 y sin allowed_updates (no confirma ni cambia ajustes del bot)', async function () {
  await canal().getUpdates(TOKEN);
  var q = sim.requests[0];
  assert.strictEqual(q.apiMethod, 'getUpdates');
  assert.strictEqual(q.body.timeout, 0);
  assert.strictEqual('offset' in q.body, false);
  assert.strictEqual('allowed_updates' in q.body, false);
});

/* ---------------- clasificación de errores (anexo A) ---------------- */

test('Anexo A: 401 y 404 => invalid_token, no transitorio, sin reintento', async function () {
  sim.on('sendMessage', R.error(401, 'Unauthorized'));
  var a = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(a.ok, false); assert.strictEqual(a.code, 'invalid_token'); assert.strictEqual(a.transient, false);
  assert.match(a.message, /401/);
  assert.match(a.message, /BotFather/);
  sim.reset(); sim.on('sendMessage', R.error(404, 'Not Found'));
  var b = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(b.code, 'invalid_token'); assert.strictEqual(b.transient, false);
  sinFugas(a); sinFugas(b);
});

test('Anexo A: 400 «chat not found» => chat_not_found, no transitorio, mensaje con la solución', async function () {
  sim.on('sendMessage', R.chatNotFound());
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.code, 'chat_not_found'); assert.strictEqual(r.transient, false);
  assert.match(r.message, /Buscar mis chats/);
});

test('Anexo A: 403 => blocked, no transitorio', async function () {
  sim.on('sendMessage', R.error(403, 'Forbidden: bot was blocked by the user'));
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.code, 'blocked'); assert.strictEqual(r.transient, false);
});

test('Anexo A: 429 con retry_after => rate_limited transitorio con retryAfterS', async function () {
  sim.on('sendMessage', R.retryAfter(7));
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'rate_limited'); assert.strictEqual(r.transient, true);
  assert.strictEqual(r.retryAfterS, 7);
  assert.match(r.message, /7 s/);
});

test('Anexo A: 429 sin parameters => rate_limited transitorio sin retryAfterS', async function () {
  sim.on('sendMessage', R.error(429, 'Too Many Requests'));
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.code, 'rate_limited'); assert.strictEqual(r.transient, true);
  assert.ok(r.retryAfterS === undefined || r.retryAfterS === null);
});

test('Anexo A: 5xx => transitorio (se reintenta), sin exponer el cuerpo', async function () {
  for (var st of [500, 502, 503, 504]) {
    sim.reset(); sim.on('sendMessage', R.error(st, 'Internal Server Error'));
    var r = await canal().sendMessage(TOKEN, CHAT, 'x');
    assert.strictEqual(r.ok, false, String(st)); assert.strictEqual(r.transient, true, String(st));
  }
});

test('Anexo A: 409 (webhook u otro lector) => error definitivo con explicación de bot dedicado', async function () {
  sim.on('getUpdates', R.error(409, 'Conflict: terminated by other getUpdates request'));
  var r = await canal().getUpdates(TOKEN);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.transient, false);
  assert.match(r.message, /409/);
  assert.match(r.message, /bot dedicado|webhook/i);
});

test('Anexo A: 400 con migrate_to_chat_id => migrateTo, no transitorio, no cuenta como chat_not_found genérico', async function () {
  sim.on('sendMessage', R.migrate(-1009998887776));
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(Number(r.migrateTo), -1009998887776);
  assert.strictEqual(r.transient, false);
});

test('Anexo A: 400 con otra descripción => unknown definitivo, descripción acotada', async function () {
  sim.on('sendMessage', R.error(400, 'Bad Request: message is too long'));
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.code, 'unknown'); assert.strictEqual(r.transient, false);
});

test('Casos límite: respuesta 200 con JSON inválido => unknown sin excepción', async function () {
  sim.on('sendMessage', R.invalidJson(200));
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'unknown');
  sinFugas(r);
});

test('Casos límite: respuestas de error con JSON inválido (400, 500) => unknown sin excepción', async function () {
  sim.on('sendMessage', [R.invalidJson(400), R.invalidJson(500), R.invalidJson(401)]);
  var a = await canal().sendMessage(TOKEN, CHAT, 'x');
  var b = await canal().sendMessage(TOKEN, CHAT, 'x');
  var c = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(a.ok, false); assert.strictEqual(a.code, 'unknown');
  assert.strictEqual(b.ok, false); assert.strictEqual(b.transient, true);
  assert.strictEqual(c.code, 'invalid_token');
});

test('Casos límite: 200 con ok:false y sin descripción => unknown', async function () {
  sim.on('sendMessage', { status: 200, body: { ok: false } });
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'unknown');
});

test('Casos límite: respuesta 200 que no es un objeto (lista, null) => unknown', async function () {
  sim.on('sendMessage', [{ status: 200, raw: '[]' }, { status: 200, raw: 'null' }, { status: 200, raw: '' }]);
  for (var i = 0; i < 3; i++) {
    var r = await canal().sendMessage(TOKEN, CHAT, 'x');
    assert.strictEqual(r.ok, false, 'caso ' + i); assert.strictEqual(r.code, 'unknown');
  }
});

/* ---------------- red: plazo, sin conexión, cortes ---------------- */

test('RA-36 plazo: un servidor que no responde se aborta a timeoutMs con code timeout transitorio', async function () {
  sim.on('sendMessage', R.silence());
  var t0 = Date.now();
  var r = await tg.create({ apiBase: sim.base, timeoutMs: 300 }).sendMessage(TOKEN, CHAT, 'x');
  var dt = Date.now() - t0;
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'timeout'); assert.strictEqual(r.transient, true);
  assert.ok(dt >= 250 && dt < 2500, 'tardó ' + dt + ' ms');
  sinFugas(r);
});

test('RA-36 plazo total: una respuesta que llega con retraso mayor que timeoutMs también es timeout', async function () {
  sim.on('sendMessage', R.delayed(800, R.ok()));
  var r = await tg.create({ apiBase: sim.base, timeoutMs: 300 }).sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.code, 'timeout');
});

test('RA-23 sin conexión: conexión rechazada => no_internet transitorio, mensaje en español sin URL ni token', async function () {
  var p = await puertoCerrado();
  var r = await tg.create({ apiBase: 'http://127.0.0.1:' + p, timeoutMs: 1000 }).sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'no_internet'); assert.strictEqual(r.transient, true);
  assert.match(r.message, /api\.telegram\.org/);
  assert.ok(r.message.indexOf(String(p)) < 0, 'no debe filtrar la URL de la petición');
  sinFugas(r);
});

test('RA-23 conexión cortada sin respuesta => fallo transitorio sin exponer el error de red crudo', async function () {
  sim.on('sendMessage', R.destroy());
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.transient, true);
  assert.ok(['unknown', 'no_internet', 'timeout'].indexOf(r.code) >= 0, r.code);
  sinFugas(r);
});

test('RA-95 límite de respuesta: una respuesta mayor que maxBodyBytes se descarta sin excepción ni consumo desmedido', async function () {
  sim.on('sendMessage', R.big(50000));
  var r = await tg.create({ apiBase: sim.base, timeoutMs: 2000, maxBodyBytes: 2000 }).sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false, 'una respuesta truncada no puede darse por buena');
  assert.ok(JSON.stringify(r).length < 2000, 'el resultado no arrastra el cuerpo grande');
});

test('RA-95 límite de respuesta: una respuesta dentro del límite se procesa con normalidad', async function () {
  sim.on('sendMessage', R.ok({ message_id: 1 }));
  var r = await tg.create({ apiBase: sim.base, timeoutMs: 2000, maxBodyBytes: 2000 }).sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, true);
});

test('RA-93 redirecciones: una 302 no se sigue (una sola petición al simulador) y se informa como error', async function () {
  sim.on('sendMessage', R.redirect(sim.base + '/bot' + TOKEN + '/sendMessage'));
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(sim.requests.length, 1, 'no debe seguir la redirección');
  sinFugas(r);
});

test('RA-93 TLS: una base https contra un servidor sin TLS falla de forma controlada (no se desactiva la verificación)', async function () {
  var r = await tg.create({ apiBase: 'https://127.0.0.1:' + sim.port, timeoutMs: 1500 }).sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(sim.sent().length, 0, 'ningún mensaje debe llegar al servidor sin TLS válido');
  sinFugas(r);
});

/* ---------------- validación del token en la ruta (RA-92) ---------------- */

test('RA-92 el token se valida antes de construir la ruta: con / ? # espacios o formato erróneo no hay petición', async function () {
  var malos = [TOKEN + '/../getMe', '123456789:AAH_abcdefghijklmnopqrst/uvwxyz012345', '123456789:AAH_abcdefghijklmnopqrstu?x=1vwxyz0123',
    '123456789:AAH_abcdefghijklmnopqrstu#vwxyz0123456', '123456789:AAH_abcdefghijklmnop qrstuvwxyz012345', '', 'x', null, undefined, 123,
    '0123456789:AAH_abcdefghijklmnopqrstuvwxyz012345', TOKEN + new Array(60).join('a')];
  for (var t of malos) {
    var r = await canal().sendMessage(t, CHAT, 'x');
    assert.strictEqual(r.ok, false, String(t)); assert.strictEqual(r.code, 'invalid_token', String(t)); assert.strictEqual(r.transient, false);
  }
  assert.strictEqual(sim.requests.length, 0, 'ninguna petición debe haber salido');
});

test('RA-92 getMe y getUpdates validan igual el token', async function () {
  assert.strictEqual((await canal().getMe('mal/token')).code, 'invalid_token');
  assert.strictEqual((await canal().getUpdates('')).code, 'invalid_token');
  assert.strictEqual(sim.requests.length, 0);
});

test('RA-22 el simulador con token válido distinto responde 401 y el mensaje no incluye el token', async function () {
  sim.validToken = '999999999:ZZZ_abcdefghijklmnopqrstuvwxyz012345';
  var r = await canal().sendMessage(TOKEN, CHAT, 'x');
  assert.strictEqual(r.code, 'invalid_token');
  sinFugas(r);
});

/* ---------------- base de la API ---------------- */

test('Anexo A base: por omisión https://api.telegram.org y sin aviso', function () {
  var c = tg.create({});
  assert.strictEqual(c.apiBase, 'https://api.telegram.org');
  assert.ok(!c.baseWarning);
  assert.strictEqual(tg.create({ apiBase: '' }).apiBase, 'https://api.telegram.org');
});

test('Anexo A base: http solo hacia loopback; https hacia cualquiera; el resto se ignora con aviso', function () {
  ['http://127.0.0.1:8081', 'http://localhost:8081', 'http://[::1]:8081'].forEach(function (b) {
    var c = tg.create({ apiBase: b });
    assert.ok(!c.baseWarning, b);
    assert.match(c.apiBase, /^http:\/\//, b);
  });
  var h = tg.create({ apiBase: 'https://telegram.ejemplo.test' });
  assert.ok(!h.baseWarning);
  assert.strictEqual(h.apiBase, 'https://telegram.ejemplo.test');
  ['http://api.telegram.org', 'http://192.168.1.10:80', 'http://evil.example', 'ftp://127.0.0.1', 'no es una url', 'http://127.0.0.1:1/?x=1',
   'http://user:pass@127.0.0.1:1', 'http://127.0.0.1:1/#h', 'http://127.0.0.2:80'].forEach(function (b) {
    var c = tg.create({ apiBase: b });
    assert.ok(c.baseWarning, 'debería avisar: ' + b);
    assert.strictEqual(c.apiBase, 'https://api.telegram.org', 'vuelve a la base predeterminada: ' + b);
  });
});

test('Anexo A base: el aviso de base inválida no incluye credenciales de la URL', function () {
  var c = tg.create({ apiBase: 'http://usuario:secreto-mio@127.0.0.1:1' });
  assert.ok(c.baseWarning);
  assert.ok(c.baseWarning.indexOf('secreto-mio') < 0);
});

/* ---------------- classify (puro) ---------------- */

test('Anexo A classify: errores de red por código', function () {
  assert.strictEqual(tg.classify(0, null, { code: 'ECONNREFUSED' }).code, 'no_internet');
  assert.strictEqual(tg.classify(0, null, { code: 'ENOTFOUND' }).code, 'no_internet');
  assert.strictEqual(tg.classify(0, null, { code: 'EAI_AGAIN' }).code, 'no_internet');
  assert.strictEqual(tg.classify(0, null, { code: 'ENETUNREACH' }).code, 'no_internet');
  assert.strictEqual(tg.classify(0, null, { timedOut: true }).code, 'timeout');
  assert.strictEqual(tg.classify(0, null, { code: 'ETIMEDOUT' }).code, 'timeout');
  var x = tg.classify(0, null, { code: 'ECONNRESET' });
  assert.strictEqual(x.code, 'unknown'); assert.strictEqual(x.transient, true);
  assert.strictEqual(tg.classify(0, null, {}).code, 'unknown');
});

test('Anexo A classify: acepta cuerpo ya analizado o texto crudo y respeta la clase del estado, no el texto', function () {
  assert.strictEqual(tg.classify(200, { ok: true, result: [1] }).ok, true);
  assert.strictEqual(tg.classify(200, '{"ok":true,"result":5}').result, 5);
  assert.strictEqual(tg.classify(429, '{"ok":false,"parameters":{"retry_after":3}}').retryAfterS, 3);
  assert.strictEqual(tg.classify(429, { parameters: { retry_after: 2.2 } }).retryAfterS, 3, 'se redondea hacia arriba');
  assert.strictEqual(tg.classify(429, { parameters: { retry_after: -5 } }).retryAfterS, undefined);
  assert.strictEqual(tg.classify(403, { description: 'texto cualquiera' }).code, 'blocked');
  assert.strictEqual(tg.classify(401, '').code, 'invalid_token');
  assert.strictEqual(tg.classify(301, '').ok, false);
  assert.strictEqual(tg.classify(418, '{}').ok, false);
  assert.strictEqual(tg.classify(418, '{}').transient, false);
});

/* ---------------- redact ---------------- */

test('RA-22 redact: sustituye el token por bot***, su parte numérica y las rutas /bot…', function () {
  var s = 'fallo en https://api.telegram.org/bot' + TOKEN + '/sendMessage para ' + TOKEN + ' (id 123456789)';
  var r = tg.redact(s, TOKEN);
  assert.ok(r.indexOf(TOKEN) < 0); assert.ok(r.indexOf('123456789') < 0);
  assert.ok(r.indexOf('AAH_abc') < 0);
  assert.match(r, /bot\*\*\*/);
});

test('RA-22 redact: oculta una ruta /bot<algo>/ aunque no se conozca el token y entradas nulas no fallan', function () {
  assert.ok(tg.redact('GET /bot555555:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123/getMe').indexOf('ABCDEFGH') < 0);
  assert.strictEqual(tg.redact(null, TOKEN), '');
  assert.strictEqual(tg.redact(undefined), '');
  assert.strictEqual(tg.redact('sin nada', ''), 'sin nada');
});

/* ---------------- chatsFromUpdates ---------------- */

test('RA-52 chatsFromUpdates: toma chats de message, channel_post y my_chat_member, deduplicados, solo {id,type,title}', function () {
  var ups = [
    simMod.updMessage(111, 'private', undefined, { chat: { id: 111, type: 'private', first_name: 'Ana', last_name: 'Pérez', username: 'ana_p' } }),
    simMod.updMessage(-100200, 'supergroup', 'Guardia TI'),
    simMod.updMessage(-100200, 'supergroup', 'Guardia TI'),
    { update_id: 5, channel_post: { message_id: 1, chat: { id: -100300, type: 'channel', title: 'Avisos' }, text: 'secreto' } },
    { update_id: 6, my_chat_member: { chat: { id: -100400, type: 'group', title: 'Grupo nuevo' }, from: { id: 9, username: 'persona' } } }
  ];
  var c = tg.chatsFromUpdates(ups);
  assert.deepStrictEqual(c.map(function (x) { return x.id; }), [111, -100200, -100300, -100400]);
  assert.deepStrictEqual(c[1], { id: -100200, type: 'supergroup', title: 'Guardia TI' });
  assert.strictEqual(c[0].title, 'Ana Pérez', 'un chat privado usa su nombre');
  // SEC-A10: el @username del chat (no el de quien escribe) se incluye cuando viene en la actualización.
  c.forEach(function (x) { assert.deepStrictEqual(Object.keys(x).sort(), x.id === 111 ? ['id', 'title', 'type', 'username'] : ['id', 'title', 'type']); });
  assert.strictEqual(c[0].username, 'ana_p');
  var js = JSON.stringify(c);
  assert.ok(js.indexOf('hola') < 0 && js.indexOf('secreto') < 0 && js.indexOf('persona') < 0, 'sin textos ni nombres de otros usuarios: ' + js);
});

test('RA-52 chatsFromUpdates: máximo 20 chats', function () {
  var ups = [];
  for (var i = 1; i <= 35; i++) ups.push(simMod.updMessage(-1000 - i, 'group', 'G' + i));
  var c = tg.chatsFromUpdates(ups);
  assert.strictEqual(c.length, 20);
  assert.strictEqual(c[0].id, -1001);
});

test('RA-52 chatsFromUpdates: entradas inválidas no fallan (null, no lista, id no numérico, basura)', function () {
  assert.deepStrictEqual(tg.chatsFromUpdates(null), []);
  assert.deepStrictEqual(tg.chatsFromUpdates('x'), []);
  assert.deepStrictEqual(tg.chatsFromUpdates({}), []);
  assert.deepStrictEqual(tg.chatsFromUpdates([null, 5, 'a', {}, { message: null }, { message: { chat: { id: 'abc', type: 'group' } } },
    { message: { chat: null } }, { message: { chat: { id: NaN } } }]), []);
});

test('RA-65 chatsFromUpdates: el título se devuelve literal (el escape lo hace la interfaz) y se acota a 100 caracteres', function () {
  var raro = '<img src=x onerror=alert(1)>' + new Array(200).join('z');
  var c = tg.chatsFromUpdates([simMod.updMessage(-100500, 'group', raro)]);
  assert.strictEqual(c.length, 1);
  assert.ok(c[0].title.length <= 100);
  assert.strictEqual(c[0].title.indexOf('<img'), 0);
});

// Prueba del usuario con un bot real (2026-11-19): el chat de destino era el @usuario del propio bot y el aviso decía
// «bot bloqueado». Ahora los 403 frecuentes se explican por su causa.
test('403 «bots can\'t send messages to bots» → chat_is_bot con mensaje que explica que el destino es un bot', function () {
  var r = tg.classify(403, { ok: false, error_code: 403, description: "Forbidden: bot can't send messages to bots" });
  assert.strictEqual(r.code, 'chat_is_bot'); assert.strictEqual(r.transient, false);
  assert.match(r.message, /es un bot/); assert.match(r.message, /Buscar mis chats/);
});
test('403 «bot can\'t initiate conversation with a user» → not_started con la indicación de pulsar Iniciar', function () {
  var r = tg.classify(403, { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
  assert.strictEqual(r.code, 'not_started'); assert.match(r.message, /Iniciar/);
});
test('403 con otras descripciones (bloqueado, expulsado) sigue siendo blocked', function () {
  ['Forbidden: bot was blocked by the user', 'Forbidden: bot was kicked from the group chat', ''].forEach(function (d) {
    assert.strictEqual(tg.classify(403, { ok: false, description: d }).code, 'blocked', d);
  });
});
