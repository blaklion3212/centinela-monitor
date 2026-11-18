'use strict';
/*
 * N-05: cupo del planificador con verificaciones huérfanas (plazo vencido y sonda aún viva).
 * Usa CENTINELA_CONCURRENCY=6 (floor(6/2)=3) para que la fórmula capacity = MAX - min(orphans, floor(MAX/2))
 * sea distinguible; scheduler.test.js usa 2 y no permite ver el tope. Verificaciones simuladas, sin red.
 */
process.env.CENTINELA_CONCURRENCY = '6';
process.env.CENTINELA_CHECK_TIMEOUT_MS = '5000'; // mínimo permitido; el reloj se acorta más abajo

var test = require('node:test');
var assert = require('node:assert');
var checks = require('../server/lib/checks.js');
var schedMod = require('../server/lib/scheduler.js');
var Scheduler = schedMod.Scheduler;

var realCheck = checks.checkTarget;
var realSetTimeout = global.setTimeout;
// Plazo corto (ms) que sustituye al global solo mientras vale un número; con null el plazo real (5000) se respeta.
var plazoCorto = 40;
// Tope de la huérfana (2 x plazo): solo se acorta cuando una prueba lo pide; con null se respeta el real (10000 ms, unref).
var topeCorto = null;
global.setTimeout = function (fn, ms) {
  var args = Array.prototype.slice.call(arguments);
  if (ms === schedMod.CHECK_TIMEOUT_MS && plazoCorto !== null) args[1] = plazoCorto;
  else if (ms === 2 * schedMod.CHECK_TIMEOUT_MS && topeCorto !== null) args[1] = topeCorto;
  return realSetTimeout.apply(this, args);
};
test.after(function () { global.setTimeout = realSetTimeout; });
test.beforeEach(function () { plazoCorto = 40; topeCorto = null; });
test.afterEach(function () { checks.checkTarget = realCheck; plazoCorto = 40; topeCorto = null; });

function tgt(id) {
  return { id: id, name: 'obj ' + id, kind: 'host', address: '10.0.0.1', intervalSec: 60, enabled: true, checks: { ping: true } };
}
function fakeStore(ids) {
  var list = ids.map(tgt);
  return {
    allTargets: function () { return list; },
    findTarget: function (id) { return list.filter(function (t) { return t.id === id; })[0] || null; },
    getSettings: function () { return { intervalSec: 10, historyPoints: 5, thresholds: {} }; },
    getOrg: function () { return { id: 'default', name: 'Host', color: '#000000' }; },
    orgOf: function () { return 'default'; },
    getTargets: function () { return list; },
    getOrgs: function () { return [{ id: 'default' }]; }
  };
}
function okResult(id) { return { id: id, ts: Date.now(), status: 'up', reasons: [] }; }
async function esperar(cond, ms, motivo) {
  var fin = Date.now() + (ms || 3000);
  while (Date.now() < fin) { if (cond()) return; await new Promise(function (r) { realSetTimeout(r, 5); }); }
  assert.fail('plazo agotado esperando: ' + (motivo || 'condición'));
}
// Controla cada verificación: ctl[id].ok() / ctl[id].fail() la terminan; sin llamarlas, queda colgada.
function controlar() {
  var ctl = {};
  checks.checkTarget = function (t) {
    return new Promise(function (res, rej) { ctl[t.id] = { ok: function () { res(okResult(t.id)); }, fail: function () { rej(new Error('boom')); } }; });
  };
  return ctl;
}
// Crea n huérfanas (ids h1..hn) y espera a que el planificador las cuente.
async function crearHuerfanas(s, store, n) {
  var ps = [];
  for (var i = 1; i <= n; i++) ps.push(s.runOne(store.findTarget('h' + i)));
  var rs = await Promise.all(ps);
  rs.forEach(function (r) { assert.strictEqual(r.status, 'down'); });
}
function huerfanaTerminada(s, n) { return function () { return s.stats().orphans === n; }; }

test('N-05: stats() inicial tiene la forma { active, waiting, orphans, capacity, max } sin huérfanas', function () {
  var s = new Scheduler(fakeStore([]));
  assert.deepStrictEqual(s.stats(), { active: 0, waiting: 0, orphans: 0, capacity: 6, max: 6 });
  assert.strictEqual(s.orphans, 0);
  assert.strictEqual(s.capacity(), 6);
});

test('N-05: al vencer el plazo con la sonda viva orphans sube y capacity baja; el cupo activo se libera', async function () {
  var store = fakeStore(['h1']);
  var s = new Scheduler(store);
  controlar();
  var r = await s.runOne(store.findTarget('h1'));
  assert.strictEqual(r.status, 'down');
  assert.deepStrictEqual(s.stats(), { active: 0, waiting: 0, orphans: 1, capacity: 5, max: 6 });
});

test('N-05: capacity = MAX - min(orphans, floor(MAX/2)): 1->5, 2->4, 3->3 y se queda en 3 con más huérfanas', async function () {
  var store = fakeStore(['h1', 'h2', 'h3', 'h4', 'h5']);
  var s = new Scheduler(store);
  controlar();
  var esperadas = [5, 4, 3, 3, 3];
  for (var i = 1; i <= 5; i++) {
    await s.runOne(store.findTarget('h' + i));
    assert.strictEqual(s.stats().orphans, i);
    assert.strictEqual(s.capacity(), esperadas[i - 1], i + ' huérfanas');
    assert.strictEqual(s.stats().max, 6, 'max no cambia');
  }
});

test('N-05: aunque todas las verificaciones queden huérfanas el planificador sigue ejecutando verificaciones nuevas', async function () {
  var store = fakeStore(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nueva']);
  var s = new Scheduler(store);
  var ctl = controlar();
  await crearHuerfanas(s, store, 6);
  assert.strictEqual(s.stats().orphans, 6);
  assert.strictEqual(s.capacity(), 3, 'nunca baja de la mitad');
  plazoCorto = null;
  var p = s.runOne(store.findTarget('nueva'));
  await esperar(function () { return ctl.nueva; }, 2000, 'la verificación nueva arrancó');
  ctl.nueva.ok();
  assert.strictEqual((await p).status, 'up');
});

test('N-05: al terminar una huérfana (bien o con error) se recupera la capacidad y su id queda libre', async function () {
  var store = fakeStore(['h1', 'h2']);
  var s = new Scheduler(store);
  var ctl = controlar();
  await crearHuerfanas(s, store, 2);
  assert.strictEqual(s.capacity(), 4);
  assert.strictEqual(s.running.has('h1'), true, 'sigue en running mientras la sonda viva');
  ctl.h1.ok();
  await esperar(huerfanaTerminada(s, 1), 2000, 'h1 terminó');
  assert.strictEqual(s.capacity(), 5);
  assert.strictEqual(s.running.has('h1'), false);
  ctl.h2.fail(); // una sonda que revienta también debe devolver la capacidad
  await esperar(huerfanaTerminada(s, 0), 2000, 'h2 terminó con error');
  assert.deepStrictEqual(s.stats(), { active: 0, waiting: 0, orphans: 0, capacity: 6, max: 6 });
  assert.strictEqual(s.running.has('h2'), false);
});

test('N-05: los que esperan se despiertan al terminar una huérfana (la capacidad vuelve a subir)', async function () {
  var ids = ['h1', 'h2', 'h3', 'a1', 'a2', 'a3', 'w1', 'w2'];
  var store = fakeStore(ids);
  var s = new Scheduler(store);
  var ctl = controlar();
  await crearHuerfanas(s, store, 3);          // capacity = 3
  assert.strictEqual(s.capacity(), 3);
  plazoCorto = null;                           // desde aquí las verificaciones no vencen solas
  var activas = ['a1', 'a2', 'a3'].map(function (id) { return s.runOne(store.findTarget(id)); });
  await esperar(function () { return s.stats().active === 3; }, 2000, '3 activas');
  var esperando = ['w1', 'w2'].map(function (id) { return s.runOne(store.findTarget(id)); });
  await esperar(function () { return s.stats().waiting === 2; }, 2000, '2 en espera');
  assert.deepStrictEqual(s.stats(), { active: 3, waiting: 2, orphans: 3, capacity: 3, max: 6 });
  assert.strictEqual(ctl.w1, undefined, 'w1 aún no empezó: no hay cupo');

  ctl.h1.ok();                                 // capacity 4 => despierta a uno
  await esperar(function () { return s.stats().waiting === 1; }, 2000, 'se despertó uno');
  assert.deepStrictEqual(s.stats(), { active: 4, waiting: 1, orphans: 2, capacity: 4, max: 6 });
  await esperar(function () { return ctl.w1; }, 2000, 'w1 arrancó');
  ctl.h2.ok();                                 // capacity 5 => despierta al segundo
  await esperar(function () { return s.stats().waiting === 0; }, 2000, 'se despertó el otro');
  assert.deepStrictEqual(s.stats(), { active: 5, waiting: 0, orphans: 1, capacity: 5, max: 6 });
  await esperar(function () { return ctl.w2; }, 2000, 'w2 arrancó');

  ['a1', 'a2', 'a3', 'w1', 'w2', 'h3'].forEach(function (id) { ctl[id].ok(); });
  var rs = await Promise.all(activas.concat(esperando));
  rs.forEach(function (r) { assert.strictEqual(r.status, 'up'); });
  await esperar(huerfanaTerminada(s, 0), 2000, 'sin huérfanas');
  assert.deepStrictEqual(s.stats(), { active: 0, waiting: 0, orphans: 0, capacity: 6, max: 6 });
});

test('N-05: un resultado a tiempo no crea huérfanas ni toca la capacidad', async function () {
  var store = fakeStore(['x']);
  var s = new Scheduler(store);
  var ctl = controlar();
  plazoCorto = null;
  var p = s.runOne(store.findTarget('x'));
  await esperar(function () { return ctl.x; }, 2000, 'arrancó');
  assert.strictEqual(s.stats().active, 1);
  ctl.x.ok();
  await p;
  assert.deepStrictEqual(s.stats(), { active: 0, waiting: 0, orphans: 0, capacity: 6, max: 6 });
});

test('N-05: pasado el tope de 2 x plazo la huérfana libera su id y baja orphans aunque la sonda siga viva', async function () {
  topeCorto = 60;
  var store = fakeStore(['h1']);
  var s = new Scheduler(store);
  controlar();
  await s.runOne(store.findTarget('h1'));
  assert.strictEqual(s.stats().orphans, 1);
  assert.strictEqual(s.isRunning('h1'), true, 'mientras no llegue el tope el id sigue ocupado');
  await esperar(huerfanaTerminada(s, 0), 2000, 'el tope liberó la huérfana');
  assert.strictEqual(s.isRunning('h1'), false, 'el id queda libre tras el tope');
  assert.deepStrictEqual(s.stats(), { active: 0, waiting: 0, orphans: 0, capacity: 6, max: 6 });
});

test('N-05: si la sonda termina después del tope no se descuenta dos veces (orphans nunca negativo)', async function () {
  topeCorto = 60;
  var store = fakeStore(['h1', 'h2']);
  var s = new Scheduler(store);
  var ctl = controlar();
  await crearHuerfanas(s, store, 2);
  assert.strictEqual(s.stats().orphans, 2);
  ctl.h2.ok(); // h2 termina antes del tope: se descuenta una vez
  await esperar(huerfanaTerminada(s, 1), 2000, 'h2 terminó');
  await esperar(function () { return !s.isRunning('h1'); }, 2000, 'el tope liberó h1');
  assert.strictEqual(s.stats().orphans, 0, 'h1 liberada por tope');
  // Terminan tarde (después del tope): no debe descontarse otra vez.
  ctl.h1.ok();
  await new Promise(function (r) { realSetTimeout(r, 100); }); // control negativo: dar margen a un descuento indebido
  assert.strictEqual(s.stats().orphans, 0, 'sin doble descuento');
  assert.ok(s.orphans >= 0, 'nunca negativo');
  assert.strictEqual(s.capacity(), 6);
  // Control positivo: el id liberado vuelve a poder verificarse.
  plazoCorto = null;
  var p = s.runOne(store.findTarget('h1'));
  await esperar(function () { return ctl.h1 && s.isRunning('h1'); }, 2000, 'nueva verificación de h1');
  ctl.h1.ok();
  assert.strictEqual((await p).status, 'up');
});

test('N-05: una huérfana liberada por tope sigue sin cupo propio: la otra huérfana viva conserva su cuenta', async function () {
  topeCorto = 60;
  var store = fakeStore(['h1', 'h2']);
  var s = new Scheduler(store);
  var ctl = controlar();
  await s.runOne(store.findTarget('h1'));
  topeCorto = 5000; // h2 con un tope largo: sigue viva cuando h1 ya se liberó
  await s.runOne(store.findTarget('h2'));
  assert.strictEqual(s.stats().orphans, 2);
  await esperar(function () { return !s.isRunning('h1'); }, 2000, 'tope de h1');
  assert.strictEqual(s.stats().orphans, 1, 'solo h1 descontada');
  assert.strictEqual(s.isRunning('h2'), true);
  ctl.h1.ok(); // tardía: no cambia nada
  await new Promise(function (r) { realSetTimeout(r, 100); });
  assert.strictEqual(s.stats().orphans, 1);
  ctl.h2.ok();
  await esperar(huerfanaTerminada(s, 0), 2000, 'h2 terminó');
});
