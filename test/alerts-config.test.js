'use strict';
/*
 * Alertas por Telegram: configuración (server/lib/alerts-config.js). Módulo sin red: se prueba con un store falso en memoria.
 * Requisitos: RA-01, RA-02, RA-04, RA-10 a RA-13, RA-20, RA-21, RA-51 (docs/requisitos/alertas.md, secciones 5 y 8).
 */
var test = require('node:test');
var assert = require('node:assert');
var cfgMod = require('../server/lib/alerts-config');

var TOKEN = '123456789:AAH_abcdefghijklmnopqrstuvwxyz012345';
var TOKEN2 = '987654321:BBH_abcdefghijklmnopqrstuvwxyz067890';

// Store falso: read/write sobre un objeto en memoria; cuenta las escrituras.
function fakeStore(initial, opts) {
  var s = { files: {}, writes: 0 };
  if (initial !== undefined) s.files['alerts.json'] = JSON.parse(JSON.stringify(initial));
  s.read = function (name) {
    if (opts && opts.throwOnRead) throw new Error('data/' + name + ' no es un JSON válido');
    return Object.prototype.hasOwnProperty.call(s.files, name) ? { exists: true, value: JSON.parse(JSON.stringify(s.files[name])) } : { exists: false };
  };
  s.write = function (name, obj) { s.writes++; s.files[name] = JSON.parse(JSON.stringify(obj)); };
  return s;
}
function base(extra) { return Object.assign(JSON.parse(JSON.stringify(cfgMod.DEFAULTS)), extra || {}); }

/* ---------------- Modelo y valores por defecto (sección 8) ---------------- */

test('RA-01 DEFAULTS: desactivada, token vacío, mínimo, N=2, recuperación sí, degradado no, sin alerted', function () {
  var d = cfgMod.DEFAULTS;
  assert.strictEqual(d.version, 1);
  assert.strictEqual(d.enabled, false);
  assert.strictEqual(d.token, '');
  assert.strictEqual(d.chatId, '');
  assert.deepStrictEqual(d.orgChats, {});
  assert.strictEqual(d.detail, 'minimal');
  assert.strictEqual(d.failsBeforeAlert, 2);
  assert.strictEqual(d.notifyRecovery, true);
  assert.strictEqual(d.notifyDegraded, false);
  assert.deepStrictEqual(d.alerted, {});
});

/* ---------------- load / save ---------------- */

test('RA-01 load: sin alerts.json devuelve los valores por defecto (enabled=false) y no escribe nada', function () {
  var st = fakeStore();
  var c = cfgMod.load(st, ['default']);
  assert.deepStrictEqual(c, cfgMod.DEFAULTS);
  assert.strictEqual(st.writes, 0);
});

test('RA-01 load: archivo ilegible (el store lanza) no falla y devuelve los valores por defecto', function () {
  var c = cfgMod.load(fakeStore({}, { throwOnRead: true }), ['default']);
  assert.strictEqual(c.enabled, false);
  assert.deepStrictEqual(c, cfgMod.DEFAULTS);
});

test('RA-01 load: contenido que no es un objeto (null, lista, número) da los valores por defecto', function () {
  [null, [], 7, 'texto'].forEach(function (v) {
    var c = cfgMod.load(fakeStore(v), ['default']);
    assert.strictEqual(c.enabled, false, JSON.stringify(v));
    assert.strictEqual(c.failsBeforeAlert, 2);
  });
});

test('RA-12 load tolerante: valores de tipo inválido pasan al defecto y se reescribe el archivo', function () {
  var st = fakeStore({ version: 1, enabled: 'sí', token: 'corto', chatId: 'basura', orgChats: {}, detail: 'xx', failsBeforeAlert: 'abc',
    notifyRecovery: 'no', notifyDegraded: 1, alerted: {} });
  var c = cfgMod.load(st, ['default']);
  assert.strictEqual(c.enabled, false);
  assert.strictEqual(c.token, '', 'un token con formato inválido no se conserva');
  assert.strictEqual(c.chatId, '');
  assert.strictEqual(c.detail, 'minimal');
  assert.strictEqual(c.failsBeforeAlert, 2);
  assert.strictEqual(c.notifyRecovery, true);
  assert.strictEqual(c.notifyDegraded, false);
  assert.strictEqual(st.writes, 1, 'el saneado cambió algo: se reescribe');
  assert.deepStrictEqual(st.files['alerts.json'], c);
});

test('RA-12 load: un archivo ya limpio no se reescribe', function () {
  var limpio = base({ enabled: true, token: TOKEN, chatId: '-1001234567890', detail: 'full', failsBeforeAlert: 3 });
  var st = fakeStore(limpio);
  var c = cfgMod.load(st, ['default']);
  assert.deepStrictEqual(c, limpio);
  assert.strictEqual(st.writes, 0);
});

test('RA-10 load: orgChats conserva solo organizaciones existentes y chats válidos', function () {
  var st = fakeStore(base({ orgChats: { acme: '-1001234567890', otra: '-100999', mala: 'xx' } }));
  var c = cfgMod.load(st, ['default', 'acme']);
  assert.deepStrictEqual(c.orgChats, { acme: '-1001234567890' });
  assert.strictEqual(st.writes, 1, 'se reescribe porque se descartaron claves');
  assert.deepStrictEqual(st.files['alerts.json'].orgChats, { acme: '-1001234567890' });
});

test('RA-10 save/load: orgChats presente en el archivo se conserva al guardar y volver a cargar', function () {
  var st = fakeStore();
  var c = base({ orgChats: { acme: '-1001234567890' } });
  cfgMod.save(st, c);
  var otra = cfgMod.load(st, ['default', 'acme']);
  assert.deepStrictEqual(otra.orgChats, { acme: '-1001234567890' });
});

test('RA-44 load: alerted solo admite ids válidos con valor down o degraded (resto descartado, sin contaminar prototipos)', function () {
  var raw = base({ alerted: { t_ok: 'down', t_deg: 'degraded', t_mal: 'up', 'id con espacio': 'down', t_num: 5 } });
  raw.alerted = JSON.parse('{"t_ok":"down","t_deg":"degraded","t_mal":"up","id con espacio":"down","t_num":5,"__proto__":"down"}');
  var c = cfgMod.load(fakeStore(raw), ['default']);
  assert.deepStrictEqual(Object.keys(c.alerted).sort(), ['t_deg', 't_ok']);
  assert.strictEqual(({}).down, undefined);
});

/* ---------------- Validadores ---------------- */

test('RA-20 validateToken: acepta <id>:<30+ caracteres> y rechaza los formatos incompletos o peligrosos', function () {
  assert.strictEqual(cfgMod.validateToken(TOKEN), true);
  assert.strictEqual(cfgMod.validateToken('1:' + new Array(31).join('a') + 'b'), true, 'id de un dígito, secreto de 30');
  assert.strictEqual(cfgMod.validateToken('1:' + new Array(30).join('a')), false, 'secreto de 29');
  assert.strictEqual(cfgMod.validateToken('0123456:' + new Array(31).join('a')), false, 'cero inicial');
  assert.strictEqual(cfgMod.validateToken('123456789' + new Array(31).join('a')), false, 'sin dos puntos');
  assert.strictEqual(cfgMod.validateToken('123456789:AAH/abcdefghijklmnopqrstuvwxyz012345'), false, 'con barra');
  assert.strictEqual(cfgMod.validateToken('123456789:AAH abcdefghijklmnopqrstuvwxyz012345'), false, 'con espacio');
  assert.strictEqual(cfgMod.validateToken(' ' + TOKEN), false, 'con espacio inicial');
  assert.strictEqual(cfgMod.validateToken(''), false);
  [null, undefined, 123, {}, [], true].forEach(function (v) { assert.strictEqual(cfgMod.validateToken(v), false, String(v)); });
});

test('RA-20 validateToken: longitud total máxima de 80', function () {
  var t80 = '123456789:' + new Array(71).join('a');     // 10 + 70 = 80
  var t81 = '123456789:' + new Array(72).join('a');     // 81
  assert.strictEqual(t80.length, 80);
  assert.strictEqual(cfgMod.validateToken(t80), true);
  assert.strictEqual(cfgMod.validateToken(t81), false);
  // La parte numérica admite hasta 18 dígitos.
  assert.strictEqual(cfgMod.validateToken('123456789012345678:' + new Array(31).join('a')), true);
  assert.strictEqual(cfgMod.validateToken('1234567890123456789:' + new Array(31).join('a')), false);
});

test('RA-13 validateChatId: enteros con signo dentro del rango de la Bot API', function () {
  ['123456789', '-1001234567890', '-4000000000000', '1099511627775', '-1', '1', '-1000000000001', '-1997852516352'].forEach(function (v) {
    assert.strictEqual(cfgMod.validateChatId(v), true, v);
  });
  ['1099511627776', '-4000000000001', '-12345678901234567890', '12345678901234567890', '1e5', '12 3', ' 123', '123 ', '--5', '+5', '1.5',
   '', 'abc', '-', '0x10'].forEach(function (v) { assert.strictEqual(cfgMod.validateChatId(v), false, JSON.stringify(v)); });
});

test('RA-13 validateChatId: se valida por rango numérico, no por el prefijo -100', function () {
  assert.strictEqual(cfgMod.validateChatId('-123456789'), true, 'grupo clásico sin prefijo -100');
  assert.strictEqual(cfgMod.validateChatId('-1009999999999999'), false, 'con prefijo -100 pero fuera de rango');
});

test('RA-13 validateChatId: @usuario_canal público (5 a 32 caracteres tras la arroba, empieza por letra)', function () {
  ['@canal', '@abcde', '@Canal_1', '@' + 'a' + new Array(32).join('b')].forEach(function (v) { assert.strictEqual(cfgMod.validateChatId(v), true, v); });
  ['@abcd', '@1canal', '@_canal', '@canal-x', '@canal x', 'canal', '@', '@' + 'a' + new Array(33).join('b')].forEach(function (v) {
    assert.strictEqual(cfgMod.validateChatId(v), false, v);
  });
});

test('RA-13 validateChatId: tipos que no son cadena se rechazan', function () {
  [123, -100123, null, undefined, {}, [], true].forEach(function (v) { assert.strictEqual(cfgMod.validateChatId(v), false, String(v)); });
});

/* ---------------- Bloqueo por entorno ---------------- */

test('RA-04 blockedByEnv: solo 1 o true (sin distinguir mayúsculas) bloquean', function () {
  ['1', 'true', 'TRUE', 'True', 'tRuE'].forEach(function (v) { assert.strictEqual(cfgMod.blockedByEnv({ CENTINELA_ALERTS_DISABLED: v }), true, v); });
  ['0', 'false', 'yes', 'si', '2', '', 'verdadero', 'on'].forEach(function (v) { assert.strictEqual(cfgMod.blockedByEnv({ CENTINELA_ALERTS_DISABLED: v }), false, JSON.stringify(v)); });
  assert.strictEqual(cfgMod.blockedByEnv({}), false);
  assert.strictEqual(cfgMod.blockedByEnv(undefined), false);
});

/* ---------------- Token ---------------- */

test('RA-21 tokenInfo: sin ninguno => none; solo panel => panel con pista de 4 caracteres', function () {
  var n = cfgMod.tokenInfo(base(), {});
  assert.strictEqual(n.source, 'none'); assert.strictEqual(n.token, ''); assert.strictEqual(n.hint, '');
  var p = cfgMod.tokenInfo(base({ token: TOKEN }), {});
  assert.strictEqual(p.source, 'panel'); assert.strictEqual(p.token, TOKEN);
  assert.strictEqual(p.hint, '…2345');
});

test('RA-21 tokenInfo: la variable de entorno tiene prioridad sobre el token del panel', function () {
  var i = cfgMod.tokenInfo(base({ token: TOKEN }), { CENTINELA_TELEGRAM_TOKEN: TOKEN2 });
  assert.strictEqual(i.source, 'env');
  assert.strictEqual(i.token, TOKEN2);
  assert.strictEqual(i.hint, '…7890');
});

test('RA-21 tokenInfo: variable con formato no válido se trata como no definida (envInvalid) y cae al panel o a none', function () {
  var sinPanel = cfgMod.tokenInfo(base(), { CENTINELA_TELEGRAM_TOKEN: 'esto-no-es-un-token' });
  assert.strictEqual(sinPanel.source, 'none');
  assert.strictEqual(sinPanel.envInvalid, true);
  var conPanel = cfgMod.tokenInfo(base({ token: TOKEN }), { CENTINELA_TELEGRAM_TOKEN: 'esto-no-es-un-token' });
  assert.strictEqual(conPanel.source, 'panel');
  assert.strictEqual(conPanel.envInvalid, true);
  assert.strictEqual(cfgMod.tokenInfo(base(), { CENTINELA_TELEGRAM_TOKEN: '' }).envInvalid, false, 'variable vacía = no definida');
});

test('RA-21 tokenInfo: la variable no se copia a la configuración (no altera cfg)', function () {
  var c = base();
  cfgMod.tokenInfo(c, { CENTINELA_TELEGRAM_TOKEN: TOKEN });
  assert.strictEqual(c.token, '');
});

/* ---------------- chatFor y effectiveOn ---------------- */

test('RA-11 chatFor: con orgChats {acme} devuelve el propio para acme y el general para otra organización y null', function () {
  var c = base({ chatId: '-100111', orgChats: { acme: '-100123' } });
  assert.strictEqual(cfgMod.chatFor(c, 'acme'), '-100123');
  assert.strictEqual(cfgMod.chatFor(c, 'otra'), '-100111');
  assert.strictEqual(cfgMod.chatFor(c, null), '-100111');
  assert.strictEqual(cfgMod.chatFor(c, undefined), '-100111');
  assert.strictEqual(cfgMod.chatFor(c, 'default'), '-100111');
});

test('RA-11 chatFor: sin chat general ni propio devuelve cadena vacía sin lanzar', function () {
  assert.strictEqual(cfgMod.chatFor(base(), 'acme'), '');
  assert.strictEqual(cfgMod.chatFor(base(), null), '');
  assert.strictEqual(cfgMod.chatFor(null, 'acme'), '');
  assert.strictEqual(cfgMod.chatFor(base({ orgChats: { acme: '-100123' } }), null), '', 'el chat de una organización no es el general');
});

test('RA-11 chatFor: claves heredadas del prototipo no se toman como organización', function () {
  var c = base({ chatId: '-100111' });
  assert.strictEqual(cfgMod.chatFor(c, 'constructor'), '-100111');
  assert.strictEqual(cfgMod.chatFor(c, '__proto__'), '-100111');
});

test('RA-30 effectiveOn: exige enabled, sin bloqueo, token (panel o env) y chat', function () {
  var ok = base({ enabled: true, token: TOKEN, chatId: '-100111' });
  assert.strictEqual(cfgMod.effectiveOn(ok, {}), true);
  assert.strictEqual(cfgMod.effectiveOn(Object.assign({}, ok, { enabled: false }), {}), false);
  assert.strictEqual(cfgMod.effectiveOn(ok, { CENTINELA_ALERTS_DISABLED: '1' }), false);
  assert.strictEqual(cfgMod.effectiveOn(Object.assign({}, ok, { token: '' }), {}), false);
  assert.strictEqual(cfgMod.effectiveOn(Object.assign({}, ok, { token: '' }), { CENTINELA_TELEGRAM_TOKEN: TOKEN }), true, 'token por entorno basta');
  assert.strictEqual(cfgMod.effectiveOn(Object.assign({}, ok, { chatId: '' }), {}), false);
  assert.strictEqual(cfgMod.effectiveOn(null, {}), false);
});

/* ---------------- validateUpdate (estricta) ---------------- */

test('RA-12 validateUpdate: campos válidos producen la nueva configuración sin tocar la original', function () {
  var cur = base({ token: TOKEN });
  var copia = JSON.stringify(cur);
  var r = cfgMod.validateUpdate({ enabled: true, chatId: '-1001234567890', detail: 'full', failsBeforeAlert: 4, notifyRecovery: false, notifyDegraded: true }, cur, {});
  assert.ok(r.value, JSON.stringify(r));
  assert.strictEqual(r.value.enabled, true);
  assert.strictEqual(r.value.chatId, '-1001234567890');
  assert.strictEqual(r.value.detail, 'full');
  assert.strictEqual(r.value.failsBeforeAlert, 4);
  assert.strictEqual(r.value.notifyRecovery, false);
  assert.strictEqual(r.value.notifyDegraded, true);
  assert.strictEqual(JSON.stringify(cur), copia, 'la configuración original no se muta');
});

test('RA-12 validateUpdate: valores fuera de rango o de tipo erróneo dan errors y ningún value (todo o nada)', function () {
  var cur = base({ token: TOKEN, chatId: '-100111' });
  var malos = [{ failsBeforeAlert: 0 }, { failsBeforeAlert: 11 }, { failsBeforeAlert: 1.5 }, { failsBeforeAlert: '2' }, { failsBeforeAlert: null },
    { failsBeforeAlert: -1 }, { detail: 'otro' }, { detail: 5 }, { enabled: 'true' }, { enabled: 1 }, { notifyRecovery: 'no' }, { notifyDegraded: 0 },
    { chatId: 12345 }, { chatId: 'basura' }, { chatId: '@abc' }, { orgChats: 'x' }];
  malos.forEach(function (b) {
    var r = cfgMod.validateUpdate(b, cur, {});
    assert.ok(r.errors && r.errors.length, 'debería rechazar ' + JSON.stringify(b));
    assert.strictEqual(r.value, undefined, JSON.stringify(b));
    r.errors.forEach(function (e) { assert.strictEqual(typeof e, 'string'); });
  });
});

test('RA-12 validateUpdate: límites válidos de failsBeforeAlert (1 y 10) y mensaje de error en español', function () {
  var cur = base();
  assert.strictEqual(cfgMod.validateUpdate({ failsBeforeAlert: 1 }, cur, {}).value.failsBeforeAlert, 1);
  assert.strictEqual(cfgMod.validateUpdate({ failsBeforeAlert: 10 }, cur, {}).value.failsBeforeAlert, 10);
  var e = cfgMod.validateUpdate({ failsBeforeAlert: 99 }, cur, {}).errors.join(' ');
  assert.match(e, /entre 1 y 10/);
});

test('RA-12 validateUpdate: es atómica, un campo inválido anula también los válidos', function () {
  var r = cfgMod.validateUpdate({ detail: 'full', failsBeforeAlert: 50 }, base(), {});
  assert.ok(r.errors); assert.strictEqual(r.value, undefined);
});

test('RA-12 validateUpdate: claves desconocidas se ignoran y no se guardan; token y alerted nunca se tocan', function () {
  var cur = base({ token: TOKEN, alerted: { t_1: 'down' } });
  var r = cfgMod.validateUpdate({ detail: 'full', foo: 'bar', token: TOKEN2, alerted: {}, version: 99, __proto__: { x: 1 } }, cur, {});
  assert.ok(r.value, JSON.stringify(r));
  assert.strictEqual(r.value.foo, undefined);
  assert.strictEqual(r.value.token, TOKEN, 'el token no se cambia por el PUT general');
  assert.deepStrictEqual(r.value.alerted, { t_1: 'down' });
  assert.strictEqual(r.value.version, 1);
  assert.strictEqual(r.value.detail, 'full');
});

test('RA-12 validateUpdate: el cuerpo debe ser un objeto', function () {
  [null, [], 'x', 5, undefined].forEach(function (b) {
    var r = cfgMod.validateUpdate(b, base(), {});
    assert.ok(r.errors && r.errors.length, String(b));
  });
});

test('RA-10 validateUpdate: orgChats con alguna clave da el error de «aún no disponibles»; vacío o ausente es válido', function () {
  var r = cfgMod.validateUpdate({ orgChats: { acme: '-100123' } }, base(), {});
  assert.ok(r.errors);
  assert.ok(r.errors.some(function (e) { return /Los chats por organización aún no están disponibles/.test(e); }), r.errors.join('|'));
  assert.ok(cfgMod.validateUpdate({ orgChats: {} }, base(), {}).value);
  assert.ok(cfgMod.validateUpdate({}, base(), {}).value);
});

test('RA-10 validateUpdate: no modifica el orgChats ya guardado (se conserva)', function () {
  var cur = base({ orgChats: { acme: '-100123' } });
  var r = cfgMod.validateUpdate({ detail: 'full' }, cur, {});
  assert.deepStrictEqual(r.value.orgChats, { acme: '-100123' });
});

test('RA-13 validateUpdate: el chat se recorta de espacios y vacío se acepta (sin activar)', function () {
  assert.strictEqual(cfgMod.validateUpdate({ chatId: '  -100123  ' }, base(), {}).value.chatId, '-100123');
  assert.strictEqual(cfgMod.validateUpdate({ chatId: '' }, base({ chatId: '-100123' }), {}).value.chatId, '');
  assert.strictEqual(cfgMod.validateUpdate({ chatId: '@mi_canal' }, base(), {}).value.chatId, '@mi_canal');
});

test('RA-02 validateUpdate: activar sin token o sin chat da error que indica qué falta', function () {
  var sinToken = cfgMod.validateUpdate({ enabled: true, chatId: '-100123' }, base(), {});
  assert.ok(sinToken.errors); assert.match(sinToken.errors.join(' '), /token/i);
  var sinChat = cfgMod.validateUpdate({ enabled: true }, base({ token: TOKEN }), {});
  assert.ok(sinChat.errors); assert.match(sinChat.errors.join(' '), /chat/i);
  var ninguno = cfgMod.validateUpdate({ enabled: true }, base(), {});
  assert.ok(ninguno.errors.length >= 2, 'indica las dos carencias: ' + ninguno.errors.join('|'));
});

test('RA-02 validateUpdate: activar con token del panel o de entorno y chat es válido', function () {
  assert.strictEqual(cfgMod.validateUpdate({ enabled: true, chatId: '-100123' }, base({ token: TOKEN }), {}).value.enabled, true);
  assert.strictEqual(cfgMod.validateUpdate({ enabled: true, chatId: '-100123' }, base(), { CENTINELA_TELEGRAM_TOKEN: TOKEN }).value.enabled, true);
});

test('RA-02 validateUpdate: desactivar siempre es válido, incluso sin token ni chat', function () {
  var r = cfgMod.validateUpdate({ enabled: false }, base({ enabled: true }), {});
  assert.ok(r.value); assert.strictEqual(r.value.enabled, false);
});

/* ---------------- publicView ---------------- */

test('RA-51 publicView: no contiene token ni alerted y trae tokenConfigured, tokenHint, tokenSource y blockedByEnv', function () {
  var c = base({ enabled: true, token: TOKEN, chatId: '-1001234567890', alerted: { t_1: 'down' } });
  var v = cfgMod.publicView(c, {});
  assert.strictEqual('token' in v, false);
  assert.strictEqual('alerted' in v, false);
  assert.strictEqual(v.tokenConfigured, true);
  assert.strictEqual(v.tokenHint, '…2345');
  assert.strictEqual(v.tokenSource, 'panel');
  assert.strictEqual(v.blockedByEnv, false);
  assert.strictEqual(v.enabled, true);
  assert.strictEqual(v.chatId, '-1001234567890');
  assert.deepStrictEqual(v.orgChats, {});
  assert.strictEqual(v.detail, 'minimal');
  assert.strictEqual(v.failsBeforeAlert, 2);
  assert.strictEqual(v.notifyRecovery, true);
  assert.strictEqual(v.notifyDegraded, false);
  assert.strictEqual(v.version, 1);
});

test('RA-20 publicView: ni el token completo ni más de los últimos 4 caracteres aparecen en la serialización', function () {
  [{}, { CENTINELA_TELEGRAM_TOKEN: TOKEN2 }].forEach(function (env) {
    var s = JSON.stringify(cfgMod.publicView(base({ token: TOKEN }), env));
    assert.ok(s.indexOf(TOKEN) < 0 && s.indexOf(TOKEN2) < 0);
    assert.ok(s.indexOf('123456789') < 0 && s.indexOf('987654321') < 0, 'ni la parte numérica del bot');
    assert.ok(s.indexOf('abcdefghij') < 0, 'ni trozos largos del secreto');
  });
});

test('RA-21/RA-04 publicView: refleja origen del token y bloqueo por entorno', function () {
  var v = cfgMod.publicView(base({ token: TOKEN }), { CENTINELA_TELEGRAM_TOKEN: TOKEN2, CENTINELA_ALERTS_DISABLED: 'true' });
  assert.strictEqual(v.tokenSource, 'env');
  assert.strictEqual(v.blockedByEnv, true);
  assert.strictEqual(cfgMod.publicView(base(), {}).tokenSource, 'none');
  assert.strictEqual(cfgMod.publicView(base(), {}).tokenConfigured, false);
});

test('RA-10 publicView: no comparte la referencia de orgChats con la configuración', function () {
  var c = base({ orgChats: { acme: '-100123' } });
  var v = cfgMod.publicView(c, {});
  v.orgChats.otra = 'x';
  assert.deepStrictEqual(c.orgChats, { acme: '-100123' });
});
