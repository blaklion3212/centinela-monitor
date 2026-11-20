'use strict';
/*
 * Tipos de alerta seleccionables (2.5.0): pruebas de regresión de la revisión de calidad y seguridad (QA-T1 a QA-T10,
 * SEC-T1 a SEC-T4). Cada título lleva el id del hallazgo. Mezcla decisión pura (alert-types.decideTarget con `checksOn`),
 * motor con reloj y canal falsos (helpers/alerts-harness.js), carga de configuración e interfaz sobre el DOM mínimo.
 * Sin red ni esperas reales.
 */
var test = require('node:test');
var assert = require('node:assert');
var AT = require('../server/lib/alert-types');
var cfgMod = require('../server/lib/alerts-config');
var E = require('../js/core/evaluate.js');
var Defaults = require('../js/config/defaults.js');
var H = require('./helpers/alerts-harness');
var L = require('./helpers/alerts-ui-loader');

var TH = Defaults.SETTINGS.thresholds;
var VENTANA = 31000;
var PING_OK = { sent: 4, received: 4, lossPct: 0, avg: 10, jitter: 1 };
function ping(o) { return Object.assign({}, PING_OK, o || {}); }
function agent(o) { return Object.assign({ cpu: { usagePct: 10, ioWaitPct: 1 }, mem: { usedPct: 10 }, disks: [], services: [] }, o || {}); }
function discos(lista) { return { agent: agent({ disks: lista.map(function (d) { return { mount: d[0], usedPct: d[1] }; }) }) }; }
function notifyDe(over) { var n = {}; AT.NOTIFY_KEYS.forEach(function (k) { n[k] = true; }); return Object.assign(n, over || {}); }

/* ---------------------------------------------------------------------------------------------
 * Decisión pura con `checksOn`
 * ------------------------------------------------------------------------------------------- */
var ts = 1700000000000;
function res(raw) {
  if (raw.manual) return Object.assign({ id: 't1', ts: ++ts }, raw.manual);
  var e = E.evaluate({ checks: { ping: true } }, raw, TH);
  return Object.assign({ id: 't1', ts: ++ts, status: e.status, reasons: e.reasons }, raw);
}
// Resultado sin ninguna fuente medida: fallo de DNS o plazo agotado.
var DNS = { manual: { status: 'down', dns: { error: 'ENOTFOUND' }, reasons: [{ level: 'crit', text: 'No se resuelve el nombre (ENOTFOUND)', down: true, code: 'dns' }] } };
var TIMEOUT = { manual: { status: 'down', reasons: [{ level: 'crit', text: 'Plazo agotado', down: true, code: 'timeout' }] } };
var TODAS = { ping: true, http: false, ssl: true, agent: true };

function sim(o) {
  o = o || {};
  var s = { alerted: o.alerted || {}, counters: {}, notify: o.notify || notifyDe(), n: o.n || 2, checksOn: o.checksOn };
  s.step = function (raw) {
    var d = AT.decideTarget({ id: 't1', r: res(raw), alerted: s.alerted, counters: s.counters, notify: s.notify, n: s.n, thresholds: TH, checksOn: s.checksOn });
    s.alerted = d.alerted; s.counters = d.counters;
    return d.events;
  };
  s.rep = function (raw, veces) { var out = []; for (var i = 0; i < veces; i++) out = out.concat(s.step(raw)); return out; };
  return s;
}
function ks(ev) { return ev.map(function (e) { return e.kind + ':' + e.type + (e.sub ? ':' + e.sub : '') + '@' + e.level; }); }
function soloTipo(ev, tipo) { return ev.filter(function (e) { return e.type === tipo; }); }

/* =============================================================================================
 * QA-T1. Un resultado sin fuentes medidas (DNS, timeout) no borra claves ni recupera
 * ========================================================================================== */

test('QA-T1 (A) certificado vencido ×2 avisa; un fallo de DNS sin ping/http/ssl conserva la clave; vencido ×2 después no avisa de nuevo', function () {
  var s = sim({ n: 2, checksOn: TODAS });
  assert.deepStrictEqual(ks(s.rep({ ssl: { daysLeft: -3 } }, 2)), ['alert:certExpired@on']);
  var ev = s.step(DNS);
  assert.deepStrictEqual(soloTipo(ev, 'certExpired'), [], 'sin recuperación ni aviso de certExpired');
  assert.ok('certExpired' in s.alerted, 'la clave se conserva');
  assert.deepStrictEqual(soloTipo(s.rep({ ssl: { daysLeft: -3 } }, 2), 'certExpired'), [], 'sin aviso nuevo');
  assert.ok('certExpired' in s.alerted);
});

test('QA-T1 (A) también con un plazo agotado (timeout) la clave certExpired se conserva', function () {
  var s = sim({ n: 2, checksOn: TODAS });
  s.rep({ ssl: { daysLeft: -3 } }, 2);
  s.rep(TIMEOUT, 3);
  assert.ok('certExpired' in s.alerted);
});

test('QA-T1 (B) latencia crítica ×2 avisa; un timeout sin fuentes conserva la clave; la latencia normal medible recupera', function () {
  var s = sim({ n: 2, checksOn: TODAS });
  assert.deepStrictEqual(ks(s.rep({ ping: ping({ avg: 500 }) }, 2)), ['alert:latency:latency@on']);
  assert.deepStrictEqual(soloTipo(s.rep(TIMEOUT, 2), 'latency'), []);
  assert.ok('latency|latency' in s.alerted);
  assert.deepStrictEqual(soloTipo(s.step({ ping: ping() }), 'latency').map(function (e) { return e.kind; }), ['recovery']);
  assert.ok(!('latency|latency' in s.alerted));
});

test('QA-T1 (C) disco 95 % ×2 avisa; un timeout conserva la clave; 95 % ×2 no duplica el aviso', function () {
  var s = sim({ n: 2, checksOn: TODAS });
  assert.deepStrictEqual(ks(s.rep(discos([['/', 95]]), 2)), ['alert:disk:/@crit']);
  assert.deepStrictEqual(soloTipo(s.step(TIMEOUT), 'disk'), []);
  assert.ok('disk|%2F' in s.alerted);
  assert.deepStrictEqual(soloTipo(s.rep(discos([['/', 95]]), 2), 'disk'), [], 'sin duplicado');
});

test('QA-T1 con la comprobación desactivada en el objetivo (checksOn) la clave de esa fuente se borra en silencio', function () {
  [['ssl', { ssl: { daysLeft: -3 } }, 'certExpired'], ['ping', { ping: ping({ avg: 500 }) }, 'latency|latency'], ['agent', discos([['/', 95]]), 'disk|%2F']].forEach(function (c) {
    var checksOn = Object.assign({}, TODAS); checksOn[c[0]] = false;
    var s = sim({ n: 1, checksOn: TODAS });
    s.step(c[1]);
    assert.ok(c[2] in s.alerted, c[0]);
    s.checksOn = checksOn;
    var ev = s.step(DNS);
    assert.deepStrictEqual(soloTipo(ev, c[2].split('|')[0].replace('certExpired', 'certExpired')).filter(function (e) { return e.kind === 'recovery'; }), [], c[0] + ': sin recuperación');
    assert.ok(!(c[2] in s.alerted), c[0] + ': clave borrada');
  });
});

test('QA-T1 sin checksOn (resultado con la fuente ausente) sigue borrando en silencio por presencia', function () {
  var s = sim({ n: 1 });
  s.step(discos([['/', 95]]));
  assert.deepStrictEqual(s.step({ ping: ping() }), []);
  assert.deepStrictEqual(Object.keys(s.alerted), []);
});

// Motor: el objetivo declara sus comprobaciones y el motor las pasa a la decisión.
function motor(o) {
  o = o || {};
  var h = H.harness({ cfg: Object.assign({ failsBeforeAlert: 1, notify: notifyDe() }, o.cfg || {}), targets: o.targets, consts: o.consts });
  return h;
}
function emitir(h, id, raw, extra) {
  var r = res(raw);
  h.emit(id, r.status, Object.assign({}, r, { id: id, ts: h.clock.now() }, extra || {}));
}
async function enviar(h) { await h.clock.advance(VENTANA); }
async function ciclo(h, raw, id) { var a = h.chan.calls.length; emitir(h, id || 't1', raw); await enviar(h); return h.chan.texts().slice(a); }
function declarar(h, checks) { var t = h.store.findTarget('t1'); t.kind = 'url'; t.checks = checks; }

test('QA-T1 (motor) con ssl activo en el objetivo, un DNS fallido no recupera ni borra «CERTIFICADO VENCIDO»; al desactivar ssl sí se borra en silencio', async function () {
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  declarar(h, { ping: true, ssl: true });
  emitir(h, 't1', { ssl: { daysLeft: -3 } }); emitir(h, 't1', { ssl: { daysLeft: -3 } });
  await enviar(h);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: CERTIFICADO VENCIDO']);
  var antes = h.chan.texts().length;
  emitir(h, 't1', DNS); await enviar(h);
  emitir(h, 't1', { ssl: { daysLeft: -3 } }); emitir(h, 't1', { ssl: { daysLeft: -3 } }); await enviar(h);
  assert.ok(h.chan.texts().slice(antes).every(function (t) { return !/VENCIDO|RENOVADO/.test(t); }), h.chan.texts().join(' | '));
  assert.ok('t1|certExpired' in h.disk.cfg.alerted);
  declarar(h, { ping: true, ssl: false });
  emitir(h, 't1', { ping: ping() }); await enviar(h);
  assert.ok(!('t1|certExpired' in h.disk.cfg.alerted), 'borrada');
  assert.ok(h.chan.texts().slice(antes).every(function (t) { return !/RENOVADO/.test(t); }), 'sin recuperación');
});

test('QA-T1 (motor) latencia: el timeout conserva la clave y la latencia normal medible avisa «LATENCIA NORMAL»', async function () {
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  declarar(h, { ping: true });
  emitir(h, 't1', { ping: ping({ avg: 500 }) }); emitir(h, 't1', { ping: ping({ avg: 500 }) });
  await enviar(h);
  assert.deepStrictEqual(h.chan.texts(), ['🟠 Portal: LATENCIA ALTA']);
  emitir(h, 't1', TIMEOUT); await enviar(h);
  assert.strictEqual(h.chan.texts().filter(function (t) { return /NORMAL/.test(t); }).length, 0);
  emitir(h, 't1', { ping: ping() }); await enviar(h);
  assert.ok(/LATENCIA NORMAL/.test(h.chan.texts()[h.chan.texts().length - 1]), h.chan.texts().join(' | '));
});

test('QA-T1 (motor) disco: el timeout conserva la clave y 95 % ×2 no duplica el aviso', async function () {
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  declarar(h, { ping: true, agent: { enabled: true } });
  emitir(h, 't1', discos([['/', 95]])); emitir(h, 't1', discos([['/', 95]]));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, 1);
  emitir(h, 't1', TIMEOUT); await enviar(h);
  emitir(h, 't1', discos([['/', 95]])); emitir(h, 't1', discos([['/', 95]]));
  await enviar(h);
  assert.strictEqual(h.chan.texts().filter(function (t) { return /DISCO/.test(t); }).length, 1, h.chan.texts().join(' | '));
});

/* =============================================================================================
 * QA-T2. Aviso directo al nivel actual (sin aviso warn intermedio)
 * ========================================================================================== */

test('QA-T2 disco 86 → 92 → 92 con N=2: un solo aviso disk@crit y ninguno warn', function () {
  var s = sim({ n: 2 });
  var todo = [].concat(s.step(discos([['/', 86]])), s.step(discos([['/', 92]])), s.step(discos([['/', 92]])));
  assert.deepStrictEqual(ks(todo), ['alert:disk:/@crit']);
});

test('QA-T2 certificado 20 → 5 → 5 días con N=2: un solo aviso certExpiring crit («URGENTE»)', function () {
  var s = sim({ n: 2 });
  var todo = [].concat(s.step({ ssl: { daysLeft: 20 } }), s.step({ ssl: { daysLeft: 5 } }), s.step({ ssl: { daysLeft: 5 } }));
  assert.deepStrictEqual(ks(todo), ['alert:certExpiring@crit']);
});

test('QA-T2 (motor) los textos enviados: «ESPACIO EN DISCO CRÍTICO» y «CERTIFICADO POR VENCER (URGENTE)», sin versión warn', async function () {
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  [86, 92, 92].forEach(function (p) { emitir(h, 't1', discos([['/', p]])); });
  await enviar(h);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: ESPACIO EN DISCO CRÍTICO']);
  var h2 = motor({ cfg: { failsBeforeAlert: 2 } });
  [20, 5, 5].forEach(function (d) { emitir(h2, 't1', { ssl: { daysLeft: d } }); });
  await enviar(h2);
  assert.deepStrictEqual(h2.chan.texts(), ['🔴 Portal: CERTIFICADO POR VENCER (URGENTE)']);
});

test('QA-T2 escalado desde un warn ya avisado sigue exigiendo N resultados críticos seguidos', function () {
  var s = sim({ n: 2 });
  assert.deepStrictEqual(ks(s.rep(discos([['/', 88]]), 2)), ['alert:disk:/@warn']);
  assert.deepStrictEqual(s.step(discos([['/', 92]])), [], 'un solo crit no basta');
  assert.deepStrictEqual(ks(s.step(discos([['/', 92]]))), ['alert:disk:/@crit']);
  var c = sim({ n: 2 });
  c.rep({ ssl: { daysLeft: 20 } }, 2);
  assert.deepStrictEqual(c.step({ ssl: { daysLeft: 5 } }), []);
  assert.deepStrictEqual(c.step({ ssl: { daysLeft: 20 } }), [], 'un warn entre medias reinicia la cuenta crítica');
  assert.deepStrictEqual(c.step({ ssl: { daysLeft: 5 } }), []);
  assert.deepStrictEqual(ks(c.step({ ssl: { daysLeft: 5 } })), ['alert:certExpiring@crit']);
});

/* =============================================================================================
 * QA-T3. Ver las pruebas «RT-23/QA-T3» de alerts-tipos-decision.test.js (down migrado con certExpired desactivado)
 * ========================================================================================== */

test('QA-T3 con certExpired activo la transferencia silenciosa de «m» sigue funcionando', function () {
  var s = sim({ n: 2, alerted: { down: 'm' } });
  assert.deepStrictEqual(s.rep({ ssl: { daysLeft: -5 } }, 3), []);
  assert.deepStrictEqual(Object.keys(s.alerted), ['certExpired']);
});

test('QA-T3 un «down» real que se recupera con el certificado vencido: RECUPERADO y luego CERTIFICADO VENCIDO (certExpired activo)', function () {
  var s = sim({ n: 2, alerted: { down: 'on' } });
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: -5 } })), ['recovery:down@on']);
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: -5 } })), ['alert:certExpired@on']);
});

/* =============================================================================================
 * QA-T4. Montaje largo y no ASCII
 * ========================================================================================== */

test('QA-T4 montaje «/media/usuario/» + 60 «ñ»: aviso al 90 % ×2, se mantiene al 84 % ×2 (histéresis) y recupera al 50 %', async function () {
  var mount = '/media/usuario/' + new Array(61).join('ñ');
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  declarar(h, { ping: true, agent: { enabled: true } });
  var t = await ciclo(h, discos([[mount, 90]])); assert.deepStrictEqual(t, []);
  t = await ciclo(h, discos([[mount, 90]]));
  assert.deepStrictEqual(t, ['🔴 Portal: ESPACIO EN DISCO CRÍTICO']);
  var claves = Object.keys(h.disk.cfg.alerted);
  assert.strictEqual(claves.length, 1);
  assert.ok(claves[0].length <= 'ta|disk|'.length + 200 + 3, 'subclave acotada');
  assert.deepStrictEqual(await ciclo(h, discos([[mount, 84]])), []);
  assert.deepStrictEqual(await ciclo(h, discos([[mount, 84]])), [], 'histéresis: sin borrado ni aviso');
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted), claves, 'la clave se mantiene');
  assert.deepStrictEqual(await ciclo(h, discos([[mount, 50]])), ['🟢 Portal: ESPACIO EN DISCO NORMAL']);
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('QA-T4 (decisión) con el montaje largo la clave se encuentra otra vez en cada resultado (misma clave canónica)', function () {
  var mount = '/media/usuario/' + new Array(61).join('ñ');
  var s = sim({ n: 1 });
  s.step(discos([[mount, 90]]));
  assert.strictEqual(Object.keys(s.alerted).length, 1);
  assert.deepStrictEqual(s.step(discos([[mount, 84]])), []);
  assert.strictEqual(Object.keys(s.alerted).length, 1, 'no se trata como partición desaparecida');
  assert.deepStrictEqual(s.rep(discos([[mount, 84]]), 5), []);
  assert.strictEqual(Object.keys(s.alerted).length, 1);
});

/* =============================================================================================
 * QA-T5. Certificado ilegible
 * ========================================================================================== */

test('QA-T5 certificado ilegible ×2 avisa como other (subclave ssl); al leerse con 10 días se recupera y certExpiring sigue su ciclo', function () {
  var s = sim({ n: 2 });
  var a = s.rep({ ssl: { error: 'ECONNRESET' } }, 2);
  assert.deepStrictEqual(ks(a), ['alert:other:ssl@on']);
  assert.deepStrictEqual(Object.keys(s.alerted), ['other|ssl']);
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 10 } })), ['recovery:other:ssl@on']);
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 10 } })), ['alert:certExpiring@warn']);
  assert.deepStrictEqual(Object.keys(s.alerted), ['certExpiring']);
  assert.deepStrictEqual(s.rep({ ssl: { daysLeft: 10 } }, 3), []);
});

test('QA-T5 un certificado ilegible no recupera ni cuenta un certExpiring avisado (no medible)', function () {
  var s = sim({ n: 1 });
  s.step({ ssl: { daysLeft: 10 } });
  var ev = s.rep({ ssl: { error: 'x' } }, 3);
  assert.deepStrictEqual(ks(ev), ['alert:other:ssl@on']);
  assert.ok('certExpiring' in s.alerted);
});

test('QA-T5 (motor) el aviso por ilegible se persiste con clave estable y se recupera con «RECUPERADO»', async function () {
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  emitir(h, 't1', { ssl: { error: 'x' } }); emitir(h, 't1', { ssl: { error: 'x' } });
  await enviar(h);
  assert.deepStrictEqual(h.chan.texts(), ['🟠 Portal: DEGRADADO']);
  assert.strictEqual(Object.keys(h.disk.cfg.alerted).length, 1);
  emitir(h, 't1', { ssl: { daysLeft: 300 } }); await enviar(h);
  assert.strictEqual(h.chan.texts()[1], '🟢 Portal: RECUPERADO');
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

/* =============================================================================================
 * QA-T7 / SEC-T4. Límites: una línea de log y sin reenvíos
 * ========================================================================================== */

function lista(n, pct, pre) { var l = []; for (var i = 0; i < n; i++) l.push([(pre || '/m') + i, pct]); return l; }
function lineasLimite(h) { return h.logs.filter(function (l) { return /Límite de avisos recordados alcanzado/.test(l); }).length; }

test('QA-T7 con el límite lleno la línea de log no se repite al rotar claves (algunas se recuperan y aparecen otras mientras sigue el episodio)', async function () {
  var h = motor();
  declarar(h, { ping: true, agent: { enabled: true } });
  await ciclo(h, discos(lista(70, 95)));
  assert.strictEqual(lineasLimite(h), 1);
  for (var ronda = 0; ronda < 3; ronda++) {
    // Se recuperan 2 particiones (liberan 2 huecos) y aparecen 2 nuevas; siguen quedando claves solo en memoria.
    var l = [];
    for (var i = 0; i < 70; i++) l.push(['/m' + i, i >= ronda * 2 && i < ronda * 2 + 2 ? 10 : (i < ronda * 2 ? 10 : 95)]);
    l.push(['/n' + ronda + 'a', 95], ['/n' + ronda + 'b', 95]);
    await ciclo(h, discos(l));
  }
  assert.strictEqual(lineasLimite(h), 1, 'una sola línea mientras siga el mismo episodio: ' + h.logs.join(' | '));
});

test('QA-T7 SEC-T4 con las claves volátiles llenas el aviso rechazado no se reenvía en cada resultado y se cuenta como descartado', async function () {
  var h = motor({ consts: { MAX_ALERTED: 4, MAX_ALERTED_PER_TARGET: 2 } });
  declarar(h, { ping: true, agent: { enabled: true } });
  var t = await ciclo(h, discos(lista(8, 95)));
  assert.strictEqual(t.length, 1);
  assert.ok(/^6 avisos\n/.test(t[0]), 'solo 6 de 8 caben (2 persistidas + 4 en memoria): ' + t[0].split('\n')[0]);
  var enviados = h.chan.texts().length, caidos = h.notifier.status().droppedTotal;
  for (var i = 0; i < 4; i++) emitir(h, 't1', discos(lista(8, 95)));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, enviados, 'sin reenvíos: ' + h.chan.texts().slice(enviados).join(' | '));
  assert.ok(h.notifier.status().droppedTotal >= caidos, 'los descartes se cuentan');
  assert.strictEqual(lineasLimite(h), 1);
});

test('QA-T7 al liberar sitio las claves en memoria pasan a persistirse', async function () {
  var h = motor({ consts: { MAX_ALERTED: 10, MAX_ALERTED_PER_TARGET: 2 } });
  declarar(h, { ping: true, agent: { enabled: true } });
  await ciclo(h, discos(lista(4, 95)));
  assert.strictEqual(Object.keys(h.disk.cfg.alerted).length, 2, 'solo 2 persistidas');
  await ciclo(h, discos([['/m0', 10], ['/m1', 10], ['/m2', 95], ['/m3', 95]]));
  await h.clock.advance(2000);
  assert.strictEqual(Object.keys(h.disk.cfg.alerted).length, 2, 'las de memoria ocuparon los huecos libres');
  assert.ok('t1|disk|%2Fm2' in h.disk.cfg.alerted && 't1|disk|%2Fm3' in h.disk.cfg.alerted);
});

/* =============================================================================================
 * QA-T8 / SEC-T2. Claves persistidas hostiles al cargar
 * ========================================================================================== */

function fakeStore(initial) {
  var s = { files: { 'alerts.json': JSON.parse(JSON.stringify(initial)) }, writes: 0 };
  s.read = function (n) { return { exists: true, value: JSON.parse(JSON.stringify(s.files[n])) }; };
  s.write = function (n, o) { s.writes++; s.files[n] = JSON.parse(JSON.stringify(o)); };
  return s;
}
function cargar(alerted) {
  return cfgMod.load(fakeStore({ version: 2, enabled: false, token: '', chatId: '', orgChats: {}, detail: 'minimal', failsBeforeAlert: 2, groupWindowSec: 30,
    notify: AT.DEFAULT_NOTIFY, alerted: alerted }), ['default']);
}

test('QA-T8/SEC-T2 se descartan: legacy con subclave, %2f en minúscula, latency|constructor y otras subclaves no canónicas o no válidas', function () {
  var malas = {
    't1|legacy|x': 'on', 't1|disk|%2fvar': 'warn', 't1|latency|constructor': 'on', 't1|latency|__proto__': 'on', 't1|resources|nada': 'on',
    't1|down|x': 'on', 't1|certExpired|x': 'on', 't1|certExpiring|x': 'crit', 't1|certTrust|x': 'on', ['t1|disk|' + encodeURIComponent('a\nb')]: 'warn'
  };
  var buenas = { 't1|legacy': 'on', 't1|disk|%2Fvar': 'warn', 't1|latency|ttfb': 'on', 't1|resources|cpu': 'on', 't1|other|agent': 'on' };
  var c = cargar(Object.assign({}, malas, buenas));
  assert.deepStrictEqual(Object.keys(c.alerted).sort(), Object.keys(buenas).sort());
});

test('QA-T8/SEC-T2 un id «constructor» con 100 claves queda limitado a 64 y no rompe nada', function () {
  var a = {};
  for (var i = 0; i < 100; i++) a['constructor|disk|' + encodeURIComponent('/m' + i)] = 'warn';
  a['toString|down'] = 'on';
  var c = cargar(a);
  var ks2 = Object.keys(c.alerted);
  assert.strictEqual(ks2.filter(function (k) { return /^constructor\|/.test(k); }).length, 64);
  assert.ok('toString|down' in c.alerted);
  assert.strictEqual(typeof c.alerted.hasOwnProperty, 'function');
});

test('QA-T8 un código inventado con nombre de propiedad de Object no rompe la decisión (constructor, __proto__, toString)', function () {
  var s = sim({ n: 1 });
  var reasons = ['constructor', '__proto__', 'toString', 'hasOwnProperty'].map(function (c) { return { level: 'warn', text: 'x ' + c, down: false, code: c }; });
  var ev;
  assert.doesNotThrow(function () { ev = s.step({ manual: { status: 'degraded', reasons: reasons } }); });
  assert.strictEqual(ev.length, 4);
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(typeof ({}).toString, 'function');
});

/* =============================================================================================
 * SEC-T1. Una clave persistida maliciosa no rompe el mensaje del grupo
 * ========================================================================================== */

test('SEC-T1 claves persistidas maliciosas no impiden enviar los avisos legítimos del mismo grupo', async function () {
  var evil = {
    't1|disk|%E0%A4%A': 'warn',
    ['t1|latency|' + new Array(100001).join('x')]: 'on',
    ['t1|disk|' + encodeURIComponent('‮<b>x</b>\n')]: 'warn',
    't1|other|constructor': 'on'
  };
  var h = motor({ targets: [['t1', 'Alfa', '10.0.0.1'], ['t2', 'Beta', '10.0.0.2']], cfg: { alerted: evil, detail: 'full' } });
  declarar(h, { ping: true, agent: { enabled: true } });
  emitir(h, 't2', { ports: [{ port: 22, open: false }] });
  emitir(h, 't1', Object.assign({ ping: ping() }, discos([['/', 40]])));
  emitir(h, 't2', { ports: [{ port: 22, open: false }] });
  await enviar(h);
  var textos = h.chan.texts();
  assert.ok(textos.length >= 1, 'se envió algo');
  assert.ok(textos.every(function (t) { return t.length <= 4096; }));
  assert.ok(textos.join('\n').indexOf('Beta: CAÍDO') >= 0, 'el aviso legítimo de t2 llegó: ' + textos.join(' | ').slice(0, 300));
  assert.ok(!h.logs.some(function (l) { return /Error interno/.test(l); }), h.logs.join(' | '));
});

test('SEC-T1 el aviso legítimo sale aunque la recuperación de una clave hostil comparta el grupo (modo mínimo)', async function () {
  var h = motor({ cfg: { alerted: { ['t1|other|' + new Array(5000).join('é')]: 'on', 't1|latency|__proto__': 'on' } } });
  var t = await ciclo(h, Object.assign({ ports: [{ port: 22, open: false }] }));
  assert.ok(t.join('\n').indexOf('Portal: CAÍDO') >= 0, t.join(' | ').slice(0, 300));
  assert.ok(!h.logs.some(function (l) { return /Error interno/.test(l); }));
});

/* =============================================================================================
 * SEC-T3. Caracteres de formato Unicode
 * ========================================================================================== */

var PELIGROSOS = /[‮​﻿\u0085\u009F\u0080⁦⁩‏]/;

test('SEC-T3 nombre y montaje con U+202E, U+200B, U+FEFF y C1 no aparecen en el texto enviado (modo completo) ni en la clave', async function () {
  var nombre = 'Po‮rta​l﻿\u0085x\u009F';
  var h = motor({ cfg: { detail: 'full' }, targets: [['t1', nombre, '10.0.0.1‮']] });
  declarar(h, { ping: true, agent: { enabled: true } });
  var t = await ciclo(h, discos([['/ab‮c​d﻿e\u0085f\u009F', 95]]));
  assert.strictEqual(t.length, 1);
  assert.ok(!PELIGROSOS.test(t[0]), JSON.stringify(t[0]));
  assert.ok(/Portal|Po ?rta ?l/.test(t[0]) || t[0].indexOf('Po') >= 0);
  var claves = Object.keys(h.disk.cfg.alerted);
  assert.strictEqual(claves.length, 1);
  assert.ok(!PELIGROSOS.test(decodeURIComponent(claves[0])), 'sin caracteres peligrosos en la clave: ' + claves[0]);
  assert.strictEqual(AT.parseKey(claves[0]).sub, '/abcdef');
  // La recuperación encuentra la clave aunque el montaje siga trayendo esos caracteres.
  var r = await ciclo(h, discos([['/ab‮c​d﻿e\u0085f\u009F', 40]]));
  assert.strictEqual(r.length, 1);
  assert.ok(!PELIGROSOS.test(r[0]));
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('SEC-T3 la clasificación limpia los caracteres de formato del montaje y de la subclave', function () {
  var k = AT.classify({ level: 'warn', text: 't', down: false, code: 'disk', sub: '/a‮b​c﻿d\u0085' });
  assert.strictEqual(k.sub, '/abcd');
  assert.strictEqual(AT.encodeKey('t1', 'disk', '/a‮b'), AT.encodeKey('t1', 'disk', '/ab'));
});

test('SEC-T3 una clave persistida con esos caracteres codificados se descarta al cargar (no canónica)', function () {
  var c = cargar({ ['t1|disk|' + encodeURIComponent('/a‮b')]: 'warn', 't1|disk|%2Fab': 'warn' });
  assert.deepStrictEqual(Object.keys(c.alerted), ['t1|disk|%2Fab']);
});

/* =============================================================================================
 * QA-T10. Interfaz: casillas deshabilitadas durante el guardado
 * ========================================================================================== */

function cfgN(o) {
  return Object.assign({ enabled: false, blockedByEnv: false, tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel', chatId: '-1001234567890',
    orgChats: {}, detail: 'minimal', failsBeforeAlert: 2, groupWindowSec: 30, notify: Object.assign({}, AT.DEFAULT_NOTIFY), notifyRecovery: true, notifyDegraded: false, version: 2 }, o || {});
}
function diferido() { var d = {}; d.promesa = new Promise(function (r) { d.resolver = r; }); return d; }

test('QA-T10 durante el guardado las casillas «Qué avisar» están deshabilitadas y al terminar vuelven a su estado', async function () {
  var d = diferido();
  var u = await L.montar({ routes: { 'GET /api/alerts': cfgN(), 'PUT /api/alerts': function (b) { return d.promesa.then(function () { return cfgN({ notify: b.notify }); }); } } });
  var caja = u.q('[data-notify="disk"]');
  caja.checked = true;
  L.D.click(u.q('[data-save]'));
  await L.D.settle();
  u.qa('[data-notify]').forEach(function (c) { assert.strictEqual(c.disabled, true, c.getAttribute('data-notify') + ' deshabilitada durante el guardado'); });
  assert.strictEqual(u.llamadas('PUT /api/alerts').length, 1);
  d.resolver();
  await L.D.settle();
  u.qa('[data-notify]').forEach(function (c) { assert.strictEqual(c.disabled, false, c.getAttribute('data-notify') + ' habilitada al terminar'); });
  assert.strictEqual(u.q('[data-notify="disk"]').checked, true, 'conserva el estado guardado');
});

test('QA-T10 si el guardado falla (400) las casillas se habilitan de nuevo y conservan lo marcado', async function () {
  var d = diferido();
  var u = await L.montar({ routes: { 'GET /api/alerts': cfgN(), 'PUT /api/alerts': function () { return d.promesa.then(function () { return L.http(400, { errors: ['no'] }); }); } } });
  u.q('[data-notify="latency"]').checked = true;
  L.D.click(u.q('[data-save]'));
  await L.D.settle();
  assert.ok(u.qa('[data-notify]').every(function (c) { return c.disabled; }));
  d.resolver();
  await L.D.settle();
  assert.ok(u.qa('[data-notify]').every(function (c) { return !c.disabled; }), 'habilitadas tras el error');
  assert.strictEqual(u.q('[data-notify="latency"]').checked, true);
});

test('QA-T10 con blockedByEnv las casillas siguen deshabilitadas durante y después del guardado', async function () {
  var d = diferido();
  var u = await L.montar({ routes: { 'GET /api/alerts': cfgN({ blockedByEnv: true }), 'PUT /api/alerts': function (b) { return d.promesa.then(function () { return cfgN({ blockedByEnv: true, notify: b.notify }); }); } } });
  L.D.click(u.q('[data-save]'));
  await L.D.settle();
  assert.ok(u.qa('[data-notify]').every(function (c) { return c.disabled; }), 'durante');
  d.resolver();
  await L.D.settle();
  assert.ok(u.qa('[data-notify]').every(function (c) { return c.disabled; }), 'después siguen bloqueadas por el entorno');
});
