'use strict';
/*
 * Tipos de alerta seleccionables (2.5.0): configuración (server/lib/alerts-config.js) y API (/api/alerts*, servidor real con
 * datos temporales y simulador local de Telegram). Requisitos: RT-10, RT-11 (límites al cargar), RT-22 (migración de `notify`),
 * RT-23 (migración de `alerted`, extremo a extremo), RT-40 (modelo), RT-41 (GET y status), RT-42 (PUT), RT-43 (permisos) y
 * RT-60 (sin filtraciones). Sin red real: todo es 127.0.0.1.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var http = require('http');
var cfgMod = require('../server/lib/alerts-config');
var AT = require('../server/lib/alert-types');
var A = require('./helpers/alerts-server');

test.after(async function () { await A.limpiar(); cerrarLentos(); });

/* ---------------------------------------------------------------------------------------------
 * Ayudantes
 * ------------------------------------------------------------------------------------------- */
var DEFAULTS_NOTIFY = { down: true, recovery: true, certExpired: true, certExpiring: false, certTrust: false, latency: false, resources: false, disk: false, other: false };
var CLAVES = ['down', 'recovery', 'certExpired', 'certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other'];
var DEGRADADOS = ['certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other'];

function fakeStore(initial) {
  var s = { files: {}, writes: 0 };
  if (initial !== undefined) s.files['alerts.json'] = JSON.parse(JSON.stringify(initial));
  s.read = function (n) { return Object.prototype.hasOwnProperty.call(s.files, n) ? { exists: true, value: JSON.parse(JSON.stringify(s.files[n])) } : { exists: false }; };
  s.write = function (n, o) { s.writes++; s.files[n] = JSON.parse(JSON.stringify(o)); };
  return s;
}
// Archivo de 2.4.0 (sin notify, con notifyRecovery y notifyDegraded).
function viejo(extra) {
  return Object.assign({ version: 1, enabled: false, token: A.TOKEN, chatId: A.CHAT, orgChats: {}, detail: 'minimal', failsBeforeAlert: 2, groupWindowSec: 30,
    notifyRecovery: true, notifyDegraded: false, alerted: {} }, extra || {});
}
// Archivo de 2.5.0.
function nuevo(extra) {
  return Object.assign({ version: 2, enabled: false, token: A.TOKEN, chatId: A.CHAT, orgChats: {}, detail: 'minimal', failsBeforeAlert: 2, groupWindowSec: 30,
    notify: Object.assign({}, DEFAULTS_NOTIFY), alerted: {} }, extra || {});
}
function cargar(archivo) { var st = fakeStore(archivo); var c = cfgMod.load(st, ['default']); return { cfg: c, store: st, escrito: st.files['alerts.json'] }; }

/* =============================================================================================
 * RT-22. Migración de `notify`
 * ========================================================================================== */

[[true, true], [true, false], [false, true], [false, false]].forEach(function (c) {
  test('RT-22 migración con notifyRecovery=' + c[0] + ' y notifyDegraded=' + c[1], function () {
    var r = cargar(viejo({ notifyRecovery: c[0], notifyDegraded: c[1] }));
    var esperado = { down: true, recovery: c[0], certExpired: true };
    DEGRADADOS.forEach(function (k) { esperado[k] = c[1]; });
    assert.deepStrictEqual(r.cfg.notify, esperado);
    assert.strictEqual(r.cfg.version, 2);
    assert.ok(!('notifyRecovery' in r.cfg) && !('notifyDegraded' in r.cfg), 'sin los campos antiguos en memoria');
    // Se reescribe el archivo: version 2, notify completo y sin los campos antiguos.
    assert.strictEqual(r.store.writes, 1);
    assert.strictEqual(r.escrito.version, 2);
    assert.deepStrictEqual(r.escrito.notify, esperado);
    assert.ok(!('notifyRecovery' in r.escrito) && !('notifyDegraded' in r.escrito), 'sin los campos antiguos en el archivo');
    assert.deepStrictEqual(Object.keys(r.escrito.notify).sort(), CLAVES.slice().sort());
  });
});

test('RT-22 un archivo sin ninguno de los dos campos antiguos ni notify usa los valores por defecto de la sección 3', function () {
  var a = viejo(); delete a.notifyRecovery; delete a.notifyDegraded;
  var r = cargar(a);
  assert.deepStrictEqual(r.cfg.notify, DEFAULTS_NOTIFY);
  assert.deepStrictEqual(r.escrito.notify, DEFAULTS_NOTIFY);
});

test('RT-22 notifyRecovery o notifyDegraded no booleanos se tratan como ausentes (valores por defecto)', function () {
  var r = cargar(viejo({ notifyRecovery: 'si', notifyDegraded: 'yes' }));
  assert.deepStrictEqual(r.cfg.notify, DEFAULTS_NOTIFY);
});

test('RT-22 un archivo de version 1 con notify ya presente: se respeta y se descartan los campos antiguos', function () {
  var n = Object.assign({}, DEFAULTS_NOTIFY, { disk: true, down: false });
  var r = cargar(viejo({ notify: n, notifyDegraded: false, notifyRecovery: false }));
  assert.deepStrictEqual(r.cfg.notify, n, 'manda notify: no se migra desde los campos antiguos');
  assert.strictEqual(r.cfg.version, 2);
  assert.strictEqual(r.escrito.version, 2);
  assert.ok(!('notifyRecovery' in r.escrito) && !('notifyDegraded' in r.escrito));
});

test('RT-22 un archivo ya en el formato nuevo no se reescribe al cargar', function () {
  var r = cargar(nuevo());
  assert.strictEqual(r.store.writes, 0);
  assert.deepStrictEqual(r.cfg.notify, DEFAULTS_NOTIFY);
});

test('RT-22 sin archivo se cargan los valores por defecto (notify de la sección 3, version 2)', function () {
  var c = cfgMod.load(fakeStore(), ['default']);
  assert.deepStrictEqual(c.notify, DEFAULTS_NOTIFY);
  assert.strictEqual(c.version, 2);
  assert.deepStrictEqual(cfgMod.DEFAULTS.notify, DEFAULTS_NOTIFY);
  assert.ok(!('notifyRecovery' in cfgMod.DEFAULTS) && !('notifyDegraded' in cfgMod.DEFAULTS));
});

/* =============================================================================================
 * RT-40. Modelo y carga tolerante
 * ========================================================================================== */

test('RT-40 carga tolerante: claves ausentes o no booleanas de notify toman el valor por defecto y se reescribe saneado', function () {
  var r = cargar(nuevo({ notify: { down: 'false', recovery: 0, certExpired: null, disk: true, other: [], inventada: true, latency: 1 } }));
  assert.deepStrictEqual(r.cfg.notify, Object.assign({}, DEFAULTS_NOTIFY, { disk: true }));
  assert.ok(!('inventada' in r.cfg.notify), 'las claves desconocidas se descartan');
  assert.strictEqual(r.store.writes, 1);
  assert.deepStrictEqual(r.escrito.notify, r.cfg.notify);
});

test('RT-40 un notify que no es objeto (texto, número, lista, null) se trata como ausente y migra desde los campos antiguos', function () {
  [ 'si', 7, [], null, true ].forEach(function (v) {
    var r = cargar(viejo({ notify: v, notifyDegraded: true, notifyRecovery: false }));
    assert.strictEqual(r.cfg.notify.recovery, false, JSON.stringify(v));
    DEGRADADOS.forEach(function (k) { assert.strictEqual(r.cfg.notify[k], true, JSON.stringify(v) + ' ' + k); });
  });
});

test('RT-40 el modelo guardado siempre tiene 9 booleanos, version 2 y ningún campo antiguo', function () {
  var r = cargar({});
  assert.strictEqual(r.cfg.version, 2);
  CLAVES.forEach(function (k) { assert.strictEqual(typeof r.cfg.notify[k], 'boolean', k); });
  assert.deepStrictEqual(Object.keys(r.cfg.notify).sort(), CLAVES.slice().sort());
});

test('RT-40 un archivo ilegible o con basura vuelve a los valores por defecto sin lanzar', function () {
  [null, 'texto', 42, [], { notify: 'x', alerted: 'y' }].forEach(function (v) {
    var c;
    assert.doesNotThrow(function () { c = cfgMod.load(fakeStore(v), ['default']); }, JSON.stringify(v));
    assert.deepStrictEqual(c.notify, DEFAULTS_NOTIFY);
    assert.deepStrictEqual(c.alerted, {});
  });
});

/* =============================================================================================
 * RT-10 y RT-11. `alerted`: claves válidas, descartes y límites
 * ========================================================================================== */

test('RT-10 ida y vuelta: las claves válidas se conservan (sin reescribir) y las inválidas se descartan', function () {
  var validas = { 'abc123|down': 'on', 'abc123|certExpired': 'on', 'abc123|certExpiring': 'crit', 'abc123|certTrust': 'on', 'abc123|latency|ttfb': 'on',
    'abc123|resources|cpu': 'on', 'abc123|disk|%2Fvar': 'warn', 'abc123|disk|%2F': 'crit', 'abc123|other|agent': 'on', 'a_b-1|down': 'on' };
  var r = cargar(nuevo({ alerted: validas }));
  assert.deepStrictEqual(r.cfg.alerted, validas);
  assert.strictEqual(r.store.writes, 0, 'un archivo válido no se reescribe');
});

test('RT-10 se descartan: tipo desconocido, id inválido, __proto__, valor fuera de on|warn|crit y subclave de más de 200 caracteres', function () {
  var malas = { 'abc|inventado': 'on', 'abc|down': 'enorme', 'abc|disk|%2Fvar': 'ON', 'abc|latency|x': 1, 'abc|latency|y': null,
    'a b|down': 'on', 'a/b|down': 'on', '|down': 'on',
    'abc|disk|%E0%A4%A': 'warn', 'abc|down|x|y': 'on', 'solo': 'x', 'abc|': 'on', 'abc|down<': 'on' };
  malas['x'.repeat(65) + '|down'] = 'on';
  malas['abc|disk|' + 'a'.repeat(201)] = 'warn';
  malas['abc|disk|' + 'a'.repeat(200)] = 'warn';  // no canónica: la subclave se recorta a 100 caracteres
  malas['abc|disk|' + 'a'.repeat(101)] = 'warn';
  malas['abc|disk|' + encodeURIComponent('/a\nb')] = 'warn'; // con carácter de control
  var buenas = { 'ok1|down': 'on' };
  buenas['ok1|disk|' + 'a'.repeat(100)] = 'warn';
  var proto = JSON.parse('{"__proto__|down":"on","__proto__":"down"}');
  var r = cargar(nuevo({ alerted: Object.assign({}, malas, proto, buenas) }));
  assert.deepStrictEqual(Object.keys(r.cfg.alerted).sort(), Object.keys(buenas).sort());
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(Object.getPrototypeOf(r.cfg.alerted), Object.prototype);
});

test('RT-10 alerted que no es objeto (lista, texto, número) se trata como vacío', function () {
  [[], 'x', 5, null].forEach(function (v) { assert.deepStrictEqual(cargar(nuevo({ alerted: v })).cfg.alerted, {}); });
});

test('RT-11 se conservan como máximo 5000 claves en total (con 5001 cargadas)', function () {
  var a = {};
  for (var i = 0; i < 5001; i++) a['obj' + i + '|down'] = 'on';
  var r = cargar(nuevo({ alerted: a }));
  assert.strictEqual(Object.keys(r.cfg.alerted).length, 5000);
  assert.strictEqual(cfgMod.MAX_ALERTED, 5000);
  assert.strictEqual(r.store.writes, 1, 'se reescribe saneado');
});

test('RT-11 se conservan como máximo 64 claves por objetivo (con 70 particiones)', function () {
  var a = {};
  for (var i = 0; i < 70; i++) a['t1|disk|' + encodeURIComponent('/m' + i)] = 'warn';
  a['t2|down'] = 'on';
  var r = cargar(nuevo({ alerted: a }));
  var ks = Object.keys(r.cfg.alerted);
  assert.strictEqual(ks.filter(function (k) { return /^t1\|/.test(k); }).length, 64);
  assert.ok(ks.indexOf('t2|down') >= 0, 'otro objetivo no se ve afectado');
  assert.strictEqual(cfgMod.MAX_ALERTED_PER_TARGET, 64);
});

test('RT-10 / RT-23 el formato antiguo {id: down|degraded} se migra a claves nuevas (down con nivel migrado, degraded a legacy)', function () {
  var r = cargar(viejo({ alerted: { aaa: 'down', bbb: 'degraded', ccc: 'otra-cosa' } }));
  assert.deepStrictEqual(Object.keys(r.cfg.alerted).sort(), ['aaa|down', 'bbb|legacy']);
  assert.ok(['m', 'on'].indexOf(r.cfg.alerted['aaa|down']) >= 0, 'nivel de la caída migrada: ' + r.cfg.alerted['aaa|down']);
  assert.strictEqual(r.cfg.alerted['bbb|legacy'], 'on');
  assert.strictEqual(r.escrito.alerted['bbb|legacy'], 'on', 'y se reescribe el archivo');
});

test('RT-10 / RT-61 una clave canónica con subclave hostil (|, <, %00 literal) sobrevive a la carga; la no canónica (con salto de línea) se descarta', function () {
  var canon = AT.encodeKey('t1', 'disk', '/a|b<c>%00');
  var noCanon = 't1|disk|' + encodeURIComponent('/a|b<c>\n%00');
  assert.notStrictEqual(AT.encodeKey('t1', 'disk', '/a|b<c>\n%00'), noCanon);
  var r = cargar(nuevo({ alerted: { [canon]: 'warn', [noCanon]: 'warn' } }));
  assert.deepStrictEqual(Object.keys(r.cfg.alerted), [canon]);
  assert.strictEqual(AT.parseKey(canon).sub, '/a|b<c>%00');
});

/* =============================================================================================
 * RT-42. validateUpdate (unidad)
 * ========================================================================================== */

function actual(over) { return Object.assign(cfgMod.load(fakeStore(nuevo()), ['default']), over || {}); }

test('RT-42 validateUpdate acepta notify parcial y solo cambia esa clave', function () {
  var v = cfgMod.validateUpdate({ notify: { disk: true } }, actual(), {});
  assert.ok(v.value, JSON.stringify(v.errors));
  assert.deepStrictEqual(v.value.notify, Object.assign({}, DEFAULTS_NOTIFY, { disk: true }));
});

test('RT-42 validateUpdate no muta la configuración recibida (todo o nada)', function () {
  var cur = actual();
  var antes = JSON.stringify(cur);
  cfgMod.validateUpdate({ detail: 'full', notify: { disk: true, dwon: true } }, cur, {});
  assert.strictEqual(JSON.stringify(cur), antes);
});

test('RT-42 validateUpdate: errores en español para valor no booleano, clave desconocida y notify que no es objeto', function () {
  var e1 = cfgMod.validateUpdate({ notify: { disk: 'true' } }, actual(), {}).errors;
  assert.ok(e1 && e1.length && /notify\.disk.*verdadero o falso/.test(e1[0]), JSON.stringify(e1));
  var e2 = cfgMod.validateUpdate({ notify: { dwon: true } }, actual(), {}).errors;
  assert.ok(e2 && /dwon/.test(e2[0]) && /down/.test(e2[0]) && /recovery/.test(e2[0]), 'menciona la clave y la lista válida: ' + e2[0]);
  ['x', 5, null, [], true].forEach(function (v) {
    var e = cfgMod.validateUpdate({ notify: v }, actual(), {}).errors;
    assert.ok(e && /notify/.test(e[0]) && /objeto/.test(e[0]), JSON.stringify(v) + ' -> ' + JSON.stringify(e));
  });
});

test('RT-42 validateUpdate: ambos formatos -> manda notify y se ignoran los campos antiguos', function () {
  var v = cfgMod.validateUpdate({ notify: { disk: true }, notifyDegraded: true, notifyRecovery: false }, actual(), {});
  assert.deepStrictEqual(v.value.notify, Object.assign({}, DEFAULTS_NOTIFY, { disk: true }));
});

test('RT-42 validateUpdate: los campos antiguos se traducen (notifyRecovery -> recovery, notifyDegraded -> seis tipos)', function () {
  var v = cfgMod.validateUpdate({ notifyRecovery: false, notifyDegraded: true }, actual(), {});
  var esperado = Object.assign({}, DEFAULTS_NOTIFY, { recovery: false });
  DEGRADADOS.forEach(function (k) { esperado[k] = true; });
  assert.deepStrictEqual(v.value.notify, esperado);
  var v2 = cfgMod.validateUpdate({ notifyDegraded: false }, actual({ notify: Object.assign({}, DEFAULTS_NOTIFY, { disk: true, latency: true }) }), {});
  assert.deepStrictEqual(v2.value.notify, DEFAULTS_NOTIFY, 'false apaga los seis tipos de degradación');
});

test('RT-42 validateUpdate: validaciones de tipo de los campos antiguos, como antes', function () {
  ['true', 1, null, [], {}].forEach(function (x) {
    assert.ok(cfgMod.validateUpdate({ notifyRecovery: x }, actual(), {}).errors, 'notifyRecovery ' + JSON.stringify(x));
    assert.ok(cfgMod.validateUpdate({ notifyDegraded: x }, actual(), {}).errors, 'notifyDegraded ' + JSON.stringify(x));
  });
});

test('RT-42 validateUpdate: activar con los nueve tipos en false es válido', function () {
  var todoFalse = {}; CLAVES.forEach(function (k) { todoFalse[k] = false; });
  var v = cfgMod.validateUpdate({ enabled: true, notify: todoFalse }, actual(), {});
  assert.ok(v.value, JSON.stringify(v.errors));
  assert.strictEqual(v.value.enabled, true);
  assert.deepStrictEqual(v.value.notify, todoFalse);
});

test('RT-42 validateUpdate: un notify vacío es válido y no cambia nada', function () {
  var v = cfgMod.validateUpdate({ notify: {} }, actual(), {});
  assert.deepStrictEqual(v.value.notify, DEFAULTS_NOTIFY);
});

/* =============================================================================================
 * RT-41. publicView
 * ========================================================================================== */

test('RT-41 publicView devuelve notify completo, notifyRecovery derivado, notifyDegraded verdadero solo con los seis tipos y version 2', function () {
  var v = cfgMod.publicView(actual(), {});
  assert.deepStrictEqual(v.notify, DEFAULTS_NOTIFY);
  assert.strictEqual(v.notifyRecovery, true);
  assert.strictEqual(v.notifyDegraded, false);
  assert.strictEqual(v.version, 2);
  var seis = Object.assign({}, DEFAULTS_NOTIFY); DEGRADADOS.forEach(function (k) { seis[k] = true; });
  assert.strictEqual(cfgMod.publicView(actual({ notify: seis }), {}).notifyDegraded, true);
  DEGRADADOS.forEach(function (k) {
    var n = Object.assign({}, seis); n[k] = false;
    assert.strictEqual(cfgMod.publicView(actual({ notify: n }), {}).notifyDegraded, false, 'falta ' + k);
  });
  assert.strictEqual(cfgMod.publicView(actual({ notify: Object.assign({}, DEFAULTS_NOTIFY, { recovery: false }) }), {}).notifyRecovery, false);
});

test('RT-41 / RT-60 publicView no incluye alerted ni el token', function () {
  var v = cfgMod.publicView(actual({ alerted: { 'abc|disk|%2Fvar': 'warn' } }), {});
  var txt = JSON.stringify(v);
  assert.ok(!('alerted' in v));
  assert.ok(!/abc|%2Fvar|AAH_/.test(txt), txt);
});

/* =============================================================================================
 * API: servidor real compartido (administrador, operador y lector)
 * ========================================================================================== */

var comp = null;
async function compartido() {
  if (comp) return comp;
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: nuevo() });
  comp = { h: h, sim: sim, op: await A.nuevoUsuario(h, 'operador1', 'operator'), lec: await A.nuevoUsuario(h, 'lector1', 'viewer') };
  return comp;
}
async function reiniciarAjustes(h) {
  var r = await h.api('PUT', '/api/alerts', { enabled: false, detail: 'minimal', failsBeforeAlert: 2, groupWindowSec: 30, notify: DEFAULTS_NOTIFY });
  assert.strictEqual(r.status, 200, r.text);
}
function archivo(h) { return A.leerAlerts(h.dir); }

test('RT-41 GET /api/alerts devuelve notify (9 booleanos), notifyRecovery, notifyDegraded y version 2; sin alerted ni token', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('GET', '/api/alerts');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.notify, DEFAULTS_NOTIFY);
  assert.strictEqual(r.json.notifyRecovery, true);
  assert.strictEqual(r.json.notifyDegraded, false);
  assert.strictEqual(r.json.version, 2);
  assert.ok(!('alerted' in r.json) && !('token' in r.json));
  assert.ok(r.text.indexOf(A.TOKEN) < 0);
});

test('RT-41 los campos derivados siguen a notify: con los seis tipos activos notifyDegraded es true', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var n = {}; DEGRADADOS.forEach(function (k) { n[k] = true; });
  var r = await c.h.api('PUT', '/api/alerts', { notify: n });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.notifyDegraded, true);
  var g = await c.h.api('GET', '/api/alerts');
  assert.strictEqual(g.json.notifyDegraded, true);
  await c.h.api('PUT', '/api/alerts', { notify: { disk: false } });
  assert.strictEqual((await c.h.api('GET', '/api/alerts')).json.notifyDegraded, false);
});

test('RT-42 PUT con notify parcial modifica solo esa clave y la persiste en el archivo (0600, version 2, sin campos antiguos)', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('PUT', '/api/alerts', { notify: { disk: true } });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.notify, Object.assign({}, DEFAULTS_NOTIFY, { disk: true }));
  var f = archivo(c.h);
  assert.deepStrictEqual(f.notify, Object.assign({}, DEFAULTS_NOTIFY, { disk: true }));
  assert.strictEqual(f.version, 2);
  assert.ok(!('notifyRecovery' in f) && !('notifyDegraded' in f));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(c.h.dir, 'alerts.json')).mode & 0o777, 0o600);
  // Otra modificación parcial no deshace la anterior.
  var r2 = await c.h.api('PUT', '/api/alerts', { notify: { latency: true } });
  assert.deepStrictEqual(r2.json.notify, Object.assign({}, DEFAULTS_NOTIFY, { disk: true, latency: true }));
});

test('RT-42 PUT con valor «true» en cadena: 400 con errors en español y nada cambia (todo o nada)', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('PUT', '/api/alerts', { detail: 'full', notify: { disk: 'true' } });
  assert.strictEqual(r.status, 400);
  assert.ok(Array.isArray(r.json.errors) && r.json.errors.length >= 1);
  assert.ok(/notify\.disk/.test(r.json.errors[0]) && /verdadero o falso/.test(r.json.errors[0]), r.json.errors[0]);
  var g = (await c.h.api('GET', '/api/alerts')).json;
  assert.strictEqual(g.detail, 'minimal', 'el detalle tampoco cambió');
  assert.strictEqual(g.notify.disk, false);
});

test('RT-42 PUT con valores no booleanos (0, 1, null, lista, objeto): 400', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  for (var v of [0, 1, null, [], {}, 'false']) {
    var r = await c.h.api('PUT', '/api/alerts', { notify: { latency: v } });
    assert.strictEqual(r.status, 400, JSON.stringify(v));
  }
  assert.deepStrictEqual((await c.h.api('GET', '/api/alerts')).json.notify, DEFAULTS_NOTIFY);
});

test('RT-42 PUT con la clave «dwon»: 400 con la clave y la lista de claves válidas', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('PUT', '/api/alerts', { notify: { dwon: true } });
  assert.strictEqual(r.status, 400);
  var msg = r.json.errors.join(' ');
  assert.ok(/dwon/.test(msg), msg);
  CLAVES.forEach(function (k) { assert.ok(msg.indexOf(k) >= 0, 'lista válida incluye ' + k); });
  assert.deepStrictEqual((await c.h.api('GET', '/api/alerts')).json.notify, DEFAULTS_NOTIFY);
});

test('RT-42 PUT con una clave desconocida acompañada de claves válidas: todo o nada', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('PUT', '/api/alerts', { notify: { disk: true, dwon: true } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await c.h.api('GET', '/api/alerts')).json.notify.disk, false, 'disk no se aplicó');
});

test('RT-42 / RT-61 una clave desconocida enorme o «__proto__» recibe 400 y el mensaje se acota', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('PUT', '/api/alerts', { notify: JSON.parse('{"' + 'x'.repeat(100000) + '": true}') });
  assert.strictEqual(r.status, 400);
  assert.ok(r.text.length < 2000, 'mensaje acotado: ' + r.text.length);
  var p = await c.h.api('PUT', '/api/alerts', '{"notify":{"__proto__":true}}');
  assert.strictEqual(p.status, 400, p.text);
  assert.deepStrictEqual((await c.h.api('GET', '/api/alerts')).json.notify, DEFAULTS_NOTIFY);
});

test('RT-42 PUT con notify que no es objeto: 400 (texto, número, null, lista, booleano)', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  for (var v of ['disk', 5, null, [], [{ disk: true }], true]) {
    var r = await c.h.api('PUT', '/api/alerts', { notify: v });
    assert.strictEqual(r.status, 400, JSON.stringify(v));
    assert.ok(/notify/.test(r.json.errors[0]));
  }
});

test('RT-42 PUT con ambos formatos: mandan los de notify y los antiguos se ignoran', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('PUT', '/api/alerts', { notify: { disk: true }, notifyDegraded: true, notifyRecovery: false });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.notify, Object.assign({}, DEFAULTS_NOTIFY, { disk: true }));
  assert.strictEqual(r.json.notifyRecovery, true);
  assert.strictEqual(r.json.notifyDegraded, false);
});

test('RT-42 PUT con ambos formatos y un campo antiguo mal tipado: 400', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('PUT', '/api/alerts', { notify: { disk: true }, notifyDegraded: 'si' });
  assert.strictEqual(r.status, 400);
});

test('RT-42 PUT con solo los campos antiguos se traduce a notify (compatibilidad de clientes)', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var r = await c.h.api('PUT', '/api/alerts', { notifyDegraded: true, notifyRecovery: false });
  assert.strictEqual(r.status, 200, r.text);
  var esperado = Object.assign({}, DEFAULTS_NOTIFY, { recovery: false }); DEGRADADOS.forEach(function (k) { esperado[k] = true; });
  assert.deepStrictEqual(r.json.notify, esperado);
  assert.strictEqual(r.json.notifyDegraded, true);
  assert.strictEqual(r.json.notifyRecovery, false);
  var f = archivo(c.h);
  assert.ok(!('notifyRecovery' in f) && !('notifyDegraded' in f), 'el archivo no vuelve a guardar los campos antiguos');
  var r2 = await c.h.api('PUT', '/api/alerts', { notifyDegraded: false });
  assert.deepStrictEqual(r2.json.notify, Object.assign({}, DEFAULTS_NOTIFY, { recovery: false }));
});

test('RT-42 activar con los nueve tipos en false es válido (no es un error)', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var todoFalse = {}; CLAVES.forEach(function (k) { todoFalse[k] = false; });
  var r = await c.h.api('PUT', '/api/alerts', { enabled: true, notify: todoFalse });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.enabled, true);
  assert.deepStrictEqual(r.json.notify, todoFalse);
  assert.strictEqual(r.json.notifyDegraded, false);
  assert.strictEqual(r.json.notifyRecovery, false);
  await reiniciarAjustes(c.h);
});

test('RT-42 el cuerpo vacío o sin notify no toca notify', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  await c.h.api('PUT', '/api/alerts', { notify: { disk: true } });
  var r = await c.h.api('PUT', '/api/alerts', { detail: 'full' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.notify.disk, true);
  await reiniciarAjustes(c.h);
});

test('RT-60 el log del servidor registra solo los nombres de los tipos cambiados, sin valores sensibles', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  await c.h.api('PUT', '/api/alerts', { notify: { disk: true, other: true } });
  var linea = c.h.log().split('\n').filter(function (l) { return /ajustes guardados/.test(l) && /disk/.test(l); }).pop();
  assert.ok(linea && /tipos: .*disk/.test(linea), 'línea de log: ' + linea);
  assert.ok(c.h.log().indexOf(A.TOKEN) < 0);
});

/* =============================================================================================
 * RT-43. Permisos
 * ========================================================================================== */

test('RT-43 operador y lector reciben 403 sin notify ni activeByType en GET, PUT y status', async function () {
  var c = await compartido(); await reiniciarAjustes(c.h);
  var casos = [['GET', '/api/alerts'], ['PUT', '/api/alerts', { notify: { disk: true } }], ['GET', '/api/alerts/status']];
  for (var cookie of [c.op, c.lec]) {
    for (var caso of casos) {
      var r = await c.h.request(caso[0], caso[1], { cookie: cookie, body: caso[2] });
      assert.strictEqual(r.status, 403, caso[0] + ' ' + caso[1]);
      assert.ok(!/notify|activeByType|notifyDegraded|notifyRecovery/.test(r.text), r.text);
    }
  }
  assert.strictEqual((await c.h.api('GET', '/api/alerts')).json.notify.disk, false, 'el PUT denegado no cambió nada');
});

test('RT-43 los operadores y lectores no reciben notify por /api/state ni /api/settings', async function () {
  var c = await compartido();
  for (var cookie of [c.op, c.lec]) {
    for (var ruta of ['/api/state', '/api/settings']) {
      var r = await c.h.request('GET', ruta, { cookie: cookie });
      assert.ok(!/"notify"|activeByType|notifyDegraded|notifyRecovery/.test(r.text), ruta);
    }
  }
});

/* =============================================================================================
 * RT-41 / RT-60. activeByType en /api/alerts/status con estado persistido
 * ========================================================================================== */

var lentos = [];
function cerrarLentos() { lentos.forEach(function (s) { s.closeAllConnections && s.closeAllConnections(); s.close(); }); lentos.length = 0; }
// Servicio vigilado cuya respuesta se retrasa `delay` ms (para producir un TTFB de advertencia con umbrales bajos).
async function nuevoLento(delay) {
  var c = { delay: delay, hits: 0 };
  var s = http.createServer(function (req, res) {
    c.hits++;
    setTimeout(function () { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('x'); }, c.delay);
  });
  await new Promise(function (r) { s.listen(0, '127.0.0.1', r); });
  c.url = 'http://127.0.0.1:' + s.address().port + '/';
  lentos.push(s);
  return c;
}

test('RT-41 /api/alerts/status incluye activeByType con los 8 tipos y recuentos de claves persistidas, sin ids ni particiones (RT-60)', async function () {
  var sim = await A.nuevoSim();
  var dir = A.nuevoDir();
  var h1 = await A.arrancar({ sim: sim, dir: dir, alerts: nuevo() });
  var ctl = await A.nuevoCtl(200);
  // Objetivo deshabilitado: no se verifica, así que sus claves persistidas se conservan intactas.
  var id = await A.nuevoObjetivo(h1, 'Reservado', ctl, null, { enabled: false });
  await A.parar(h1);
  var alerted = {};
  alerted[id + '|down'] = 'on'; alerted[id + '|disk|%2Fvar-secreto'] = 'warn'; alerted[id + '|disk|%2F'] = 'crit';
  alerted[id + '|latency|ttfb'] = 'on'; alerted[id + '|certExpiring'] = 'warn';
  fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify(nuevo({ enabled: true, alerted: alerted, notify: Object.assign({}, DEFAULTS_NOTIFY, { disk: true, latency: true, certExpiring: true }) })), { mode: 0o600 });
  var h2 = await A.arrancar({ sim: sim, dir: dir });
  var r = await h2.api('GET', '/api/alerts/status');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.activeByType, { down: 1, certExpired: 0, certExpiring: 1, certTrust: 0, latency: 1, resources: 0, disk: 2, other: 0 });
  assert.ok(!/var-secreto|ttfb|Reservado/.test(r.text) && r.text.indexOf(id) < 0, 'sin ids, nombres ni particiones: ' + r.text);
  assert.ok(!('alerted' in r.json));
  var g = await h2.api('GET', '/api/alerts');
  assert.ok(!('alerted' in g.json) && g.text.indexOf(id) < 0);
  assert.strictEqual(sim.sent().length, 0, 'sin mensajes por el estado persistido');
});

test('RT-41 activeByType cuenta como «down» una clave migrada de 2.4.0', async function () {
  var sim = await A.nuevoSim();
  var dir = A.nuevoDir();
  var h1 = await A.arrancar({ sim: sim, dir: dir, alerts: nuevo() });
  var ctl = await A.nuevoCtl(200);
  var id = await A.nuevoObjetivo(h1, 'Reservado', ctl, null, { enabled: false });
  await A.parar(h1);
  var a = {}; a[id] = 'down';
  fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify(viejo({ enabled: true, alerted: a })), { mode: 0o600 });
  var h2 = await A.arrancar({ sim: sim, dir: dir });
  assert.strictEqual((await h2.api('GET', '/api/alerts/status')).json.activeByType.down, 1);
});

/* =============================================================================================
 * RT-23 de extremo a extremo: alerts.json de 2.4.0 -> 0 mensajes extra tras arrancar
 * ========================================================================================== */

// Prepara un directorio con un objetivo ya creado y un alerts.json de 2.4.0 con el estado dado, y arranca el servidor.
async function migrar(o) {
  var sim = await A.nuevoSim();
  var dir = A.nuevoDir();
  var h1 = await A.arrancar({ sim: sim, dir: dir, alerts: viejo({ enabled: false }) });
  var ctl = o.lento ? await nuevoLento(o.lento) : await A.nuevoCtl(o.status);
  if (o.lento) {
    var st = await h1.api('PUT', '/api/settings', { thresholds: { ttfbWarnMs: 40, ttfbCritMs: 100000 } });
    assert.ok(st.status === 200, 'umbrales: ' + st.text);
  }
  var id = await A.nuevoObjetivo(h1, 'Portal', ctl);
  await A.parar(h1);
  var alerted = {}; alerted[id] = o.alerted;
  fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify(viejo({ enabled: true, notifyDegraded: o.degraded, notifyRecovery: o.recovery === undefined ? true : o.recovery, alerted: alerted })), { mode: 0o600 });
  var hits0 = ctl.hits;
  var h = await A.arrancar({ sim: sim, dir: dir });
  return { sim: sim, dir: dir, h: h, ctl: ctl, id: id, hits0: hits0 };
}
async function dosVerificaciones(m) {
  await A.esperar(function () { return m.ctl.hits >= m.hits0 + 2; }, 10000, 'dos verificaciones tras arrancar');
  await A.pausa(400);
}

[true, false].forEach(function (degradado) {
  test('RT-22/RT-23 e2e alerts.json de 2.4.0 con notifyDegraded=' + degradado + ' y caída ya avisada: 0 mensajes tras arrancar y la recuperación pendiente sí se avisa', async function () {
    var m = await migrar({ status: 500, alerted: 'down', degraded: degradado });
    var g = await m.h.api('GET', '/api/alerts');
    var esperado = { down: true, recovery: true, certExpired: true }; DEGRADADOS.forEach(function (k) { esperado[k] = degradado; });
    assert.deepStrictEqual(g.json.notify, esperado, 'notify migrado');
    assert.strictEqual(g.json.version, 2);
    var f = A.leerAlerts(m.dir);
    assert.strictEqual(f.version, 2);
    assert.deepStrictEqual(f.notify, esperado);
    assert.ok(!('notifyRecovery' in f) && !('notifyDegraded' in f), 'el archivo se reescribió sin campos antiguos');
    await dosVerificaciones(m);
    assert.strictEqual(m.sim.sent().length, 0, 'ningún mensaje extra: ' + JSON.stringify(m.sim.texts()));
    await A.esperar(function () { return A.leerAlerts(m.dir).alerted[m.id + '|down'] === 'on'; }, 5000, 'la clave migrada pasa a nivel on');
    m.ctl.status = 200;
    await A.esperar(function () { return m.sim.sent().length >= 1; }, 8000, 'recuperación pendiente');
    assert.deepStrictEqual(m.sim.texts(), ['🟢 Portal: RECUPERADO']);
    await A.esperar(function () { return Object.keys(A.leerAlerts(m.dir).alerted).length === 0; }, 4000, 'alerted vacío');
  });

  test('RT-22/RT-23 e2e alerts.json de 2.4.0 con notifyDegraded=' + degradado + ' y degradación avisada que sigue: 0 mensajes y adopción silenciosa', async function () {
    var m = await migrar({ lento: 90, alerted: 'degraded', degraded: degradado });
    await dosVerificaciones(m);
    assert.strictEqual(m.sim.sent().length, 0, 'ningún mensaje extra: ' + JSON.stringify(m.sim.texts()));
    var al = A.leerAlerts(m.dir).alerted;
    assert.ok(!(m.id + '|legacy' in al), 'la clave legacy se eliminó');
    if (degradado) assert.strictEqual(al[m.id + '|other|ttfb'], 'on', 'la condición actual se adoptó como avisada');
    else assert.deepStrictEqual(al, {}, 'con los tipos desactivados no se adopta nada');
    // Sigue sin avisos mientras la condición continúa.
    var hits = m.ctl.hits;
    await A.esperar(function () { return m.ctl.hits >= hits + 2; }, 10000, 'más verificaciones');
    await A.pausa(300);
    assert.strictEqual(m.sim.sent().length, 0);
    m.ctl.delay = 0;
    if (degradado) {
      await A.esperar(function () { return m.sim.sent().length >= 1; }, 10000, 'recuperación del tipo adoptado');
      assert.deepStrictEqual(m.sim.texts(), ['🟢 Portal: RECUPERADO']);
    }
  });
});

test('RT-23 e2e degradación de 2.4.0 ya resuelta (objetivo «up»): se avisa «RECUPERADO» como en 2.4.0 y se borra la clave', async function () {
  var m = await migrar({ status: 200, alerted: 'degraded', degraded: false });
  await A.esperar(function () { return m.sim.sent().length >= 1; }, 10000, 'recuperación pendiente');
  assert.deepStrictEqual(m.sim.texts(), ['🟢 Portal: RECUPERADO']);
  await dosVerificaciones(m);
  assert.strictEqual(m.sim.sent().length, 1, 'una sola vez');
  await A.esperar(function () { return Object.keys(A.leerAlerts(m.dir).alerted).length === 0; }, 4000, 'alerted vacío');
});

test('RT-23 e2e con notifyRecovery=false: la caída migrada se recupera en silencio', async function () {
  var m = await migrar({ status: 500, alerted: 'down', degraded: false, recovery: false });
  await dosVerificaciones(m);
  m.ctl.status = 200;
  await A.esperar(function () { return Object.keys(A.leerAlerts(m.dir).alerted).length === 0; }, 8000, 'clave eliminada');
  await A.pausa(300);
  assert.strictEqual(m.sim.sent().length, 0);
  assert.strictEqual((await m.h.api('GET', '/api/alerts')).json.notify.recovery, false);
});

test('RT-24 e2e una caída nueva con la configuración migrada se avisa tras N fallos como en 2.4.0 («CAÍDO»)', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: viejo({ enabled: true }) });
  var c = await A.nuevoCtl(500);
  await A.nuevoObjetivo(h, 'Portal', c);
  await A.esperar(function () { return sim.sent().length >= 1; }, 10000, 'aviso de caída');
  assert.strictEqual(sim.sent()[0].body.text, '🔴 Portal: CAÍDO');
  assert.ok(c.hits >= 2, 'hacen falta N=2 verificaciones');
  c.status = 200;
  await A.esperar(function () { return sim.sent().length >= 2; }, 8000, 'recuperación');
  assert.strictEqual(sim.sent()[1].body.text, '🟢 Portal: RECUPERADO');
});
