'use strict';
/*
 * Alertas por Telegram: configuración y canal, correcciones de la revisión: QA-A3 (alerts.json con otro orden de claves no se
 * reescribe; directorio no escribible no impide cargar), SEC-A6 (caracteres del token) y SEC-A10 (username en chatsFromUpdates).
 * Sin red. QA-A3 con directorio real usa el módulo store con CENTINELA_DATA temporal (nunca data/).
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var tmp = require('./helpers/tmp');

// El módulo store fija su directorio al cargarse: se apunta a uno temporal antes de requerirlo.
var DIR = tmp.mkTmp('centinela-revcfg-');
process.env.CENTINELA_DATA = DIR;
var storeMod = require('../server/lib/store');
var cfgMod = require('../server/lib/alerts-config');
var tg = require('../server/lib/channels/telegram');

test.after(function () { try { fs.chmodSync(DIR, 0o700); } catch (e) { /* ya no existe */ } tmp.rmTmp(DIR); });

var TOKEN = '123456789:AAH_abcdefghijklmnopqrstuvwxyz012345';
var FILE = path.join(DIR, 'alerts.json');

function fakeStore(initial) {
  var s = { files: {}, writes: 0 };
  s.files['alerts.json'] = JSON.parse(JSON.stringify(initial));
  s.read = function (n) { return { exists: true, value: JSON.parse(JSON.stringify(s.files[n])) }; };
  s.write = function (n, o) { s.writes++; s.files[n] = JSON.parse(JSON.stringify(o)); };
  return s;
}
function invertir(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return o;
  var r = {};
  Object.keys(o).reverse().forEach(function (k) { r[k] = invertir(o[k]); });
  return r;
}

/* ---------------- QA-A3 ---------------- */

test('QA-A3 un alerts.json ya saneado con las claves en otro orden no se reescribe', function () {
  var ok = Object.assign(JSON.parse(JSON.stringify(cfgMod.DEFAULTS)), { enabled: true, token: TOKEN, chatId: '-1001234567890',
    detail: 'full', failsBeforeAlert: 3, notifyDegraded: true, alerted: { a1: 'down', b2: 'degraded', c3: 'down' } });
  var st = fakeStore(invertir(ok));
  assert.notStrictEqual(Object.keys(st.files['alerts.json'])[0], Object.keys(ok)[0], 'control: el orden de claves es otro');
  var c = cfgMod.load(st, ['default']);
  assert.strictEqual(st.writes, 0, 'sin cambios de contenido no se escribe');
  assert.deepStrictEqual(c, ok);
});

test('QA-A3 con contenido a sanear sí se reescribe (una vez) y el resultado es estable en la carga siguiente', function () {
  var st = fakeStore({ enabled: true, token: 'basura', chatId: '-1001234567890', failsBeforeAlert: 99, alerted: { x: 'down', y: 'raro' } });
  var c = cfgMod.load(st, ['default']);
  assert.strictEqual(st.writes, 1);
  assert.strictEqual(c.token, ''); assert.strictEqual(c.failsBeforeAlert, 10); assert.deepStrictEqual(c.alerted, { x: 'down' });
  cfgMod.load(st, ['default']);
  assert.strictEqual(st.writes, 1, 'la segunda carga ya no escribe');
});

test('QA-A3 si la escritura falla, load no lanza y devuelve el valor saneado (store falso)', function () {
  var st = fakeStore({ enabled: true, token: 'basura', chatId: '-100123', failsBeforeAlert: 0 });
  st.write = function () { throw new Error('EACCES: permission denied'); };
  var avisos = [], w = console.warn;
  console.warn = function (m) { avisos.push(String(m)); };
  var c;
  try { c = cfgMod.load(st, ['default']); } finally { console.warn = w; }
  assert.strictEqual(c.token, ''); assert.strictEqual(c.chatId, '-100123'); assert.strictEqual(c.failsBeforeAlert, 1);
  assert.strictEqual(avisos.length, 1);
  assert.ok(avisos[0].indexOf('EACCES') < 0 && avisos[0].indexOf(DIR) < 0, 'el aviso no vuelca rutas ni el error');
});

test('QA-A3 directorio de datos no escribible y contenido a sanear: load (store real) no lanza y devuelve el valor saneado', function (t) {
  if (process.platform === 'win32') return t.skip('Windows no aplica permisos POSIX de directorio');
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('se ejecuta como root: un directorio 0500 sigue siendo escribible');
  fs.writeFileSync(FILE, JSON.stringify({ enabled: true, token: 'no-es-un-token', chatId: '-1001234567890', failsBeforeAlert: 50, alerted: { a: 'down' } }), { mode: 0o600 });
  fs.chmodSync(DIR, 0o500);
  try {
    try { fs.writeFileSync(path.join(DIR, 'prueba-escritura'), 'x'); fs.unlinkSync(path.join(DIR, 'prueba-escritura')); return t.skip('el sistema permite escribir en un directorio 0500'); }
    catch (e) { /* esperado: no se puede escribir */ }
    var avisos = [], w = console.warn;
    console.warn = function (m) { avisos.push(String(m)); };
    var c;
    try { c = cfgMod.load(storeMod, ['default']); } finally { console.warn = w; }
    assert.strictEqual(c.token, ''); assert.strictEqual(c.failsBeforeAlert, 10); assert.deepStrictEqual(c.alerted, { a: 'down' });
    assert.strictEqual(c.chatId, '-1001234567890');
    assert.strictEqual(avisos.length, 1, 'avisa una vez de que no pudo reescribir');
    assert.strictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).failsBeforeAlert, 50, 'el archivo no cambió');
  } finally { fs.chmodSync(DIR, 0o700); }
});

test('QA-A3 con el directorio escribible el store real reescribe el contenido saneado', function () {
  fs.chmodSync(DIR, 0o700);
  fs.writeFileSync(FILE, JSON.stringify({ enabled: true, token: 'no-es-un-token', chatId: '-100123', failsBeforeAlert: 50 }), { mode: 0o600 });
  var c = cfgMod.load(storeMod, ['default']);
  assert.strictEqual(c.failsBeforeAlert, 10);
  assert.strictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).failsBeforeAlert, 10);
});

/* ---------------- SEC-A6 ---------------- */

var MALOS = ['123456789:AAH_abcdefghijklmnopqrstuvwxyz0123.45', '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123/45', '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123?x=1',
  '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123%2F45', '123456789:AAH_abcdefghijklmnopqrstuvwxyz 0123', '123456789:AAH_abcdefghijklmnopqrstuvwxyzé0123',
  '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123\n45', '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123#f', '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123:45',
  '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123@host', '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123\\45'];

test('SEC-A6 validateToken rechaza caracteres fuera de [A-Za-z0-9_-] en la parte secreta y acepta los permitidos', function () {
  MALOS.forEach(function (t) { assert.strictEqual(cfgMod.validateToken(t), false, JSON.stringify(t)); });
  assert.strictEqual(cfgMod.validateToken(TOKEN), true);
  assert.strictEqual(cfgMod.validateToken('1:' + new Array(31).join('a')), true, 'mínimo de 30');
  assert.strictEqual(cfgMod.validateToken('123456789:AA-H_abcdefghijklmnopqrstuvwxyz-01'), true, 'guion y guion bajo permitidos');
});

test('SEC-A6 un token inválido en alerts.json se descarta al cargar y tokenInfo lo ignora (también el de la variable de entorno)', function () {
  var st = fakeStore({ enabled: true, token: MALOS[0], chatId: '-100123' });
  assert.strictEqual(cfgMod.load(st, ['default']).token, '');
  var ti = cfgMod.tokenInfo({ token: TOKEN }, { CENTINELA_TELEGRAM_TOKEN: MALOS[1] });
  assert.strictEqual(ti.source, 'panel'); assert.strictEqual(ti.envInvalid, true);
});

test('SEC-A6 el canal nunca construye una ruta con un token fuera del patrón (invalid_token sin tocar la red)', async function () {
  var llamadas = 0;
  var fake = { request: function () { llamadas++; throw new Error('no debe usarse'); } };
  var canal = tg.create({ apiBase: 'http://127.0.0.1:9', httpModules: { http: fake, https: fake } });
  for (var i = 0; i < MALOS.length; i++) {
    var r = await canal.sendMessage(MALOS[i], '123', 'hola');
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'invalid_token');
  }
  assert.strictEqual(llamadas, 0);
});

/* ---------------- SEC-A10 ---------------- */

test('SEC-A10 chatsFromUpdates incluye username cuando viene y es válido, y no lo inventa cuando falta', function () {
  var r = tg.chatsFromUpdates([
    { message: { chat: { id: -1001, type: 'channel', title: 'Avisos', username: 'avisos_ti' } } },
    { message: { chat: { id: 55, type: 'private', first_name: 'Ana' } } },
    { channel_post: { chat: { id: -1002, type: 'channel', title: 'Otro', username: 'otro_canal' }, text: 'secreto' } }]);
  assert.deepStrictEqual(r, [
    { id: -1001, type: 'channel', title: 'Avisos', username: 'avisos_ti' },
    { id: 55, type: 'private', title: 'Ana' },
    { id: -1002, type: 'channel', title: 'Otro', username: 'otro_canal' }]);
  assert.ok(!('username' in r[1]));
});

test('SEC-A10 chatsFromUpdates descarta un username con caracteres no permitidos o demasiado largo (nunca HTML)', function () {
  ['<img src=x onerror=alert(1)>', 'con espacio', 'a-b', 'x'.repeat(33), '', 123, null, { a: 1 }].forEach(function (u) {
    var r = tg.chatsFromUpdates([{ message: { chat: { id: -9, type: 'group', title: 'G', username: u } } }]);
    assert.strictEqual(r.length, 1);
    assert.ok(!('username' in r[0]), 'sin username para ' + JSON.stringify(u));
  });
});

test('SEC-A10 chatsFromUpdates no expone el texto de los mensajes ni el remitente (solo el chat)', function () {
  var r = tg.chatsFromUpdates([{ message: { chat: { id: 7, type: 'private', first_name: 'Ana', username: 'ana_p' }, from: { id: 99, username: 'otro' }, text: 'clave-wifi' } }]);
  assert.ok(JSON.stringify(r).indexOf('clave-wifi') < 0 && JSON.stringify(r).indexOf('otro') < 0 && JSON.stringify(r).indexOf('99') < 0);
});
