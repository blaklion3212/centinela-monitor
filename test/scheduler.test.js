'use strict';
/* R6: planificador (server/lib/scheduler.js) con verificaciones simuladas (sin red). */
process.env.CENTINELA_CONCURRENCY = '2'; // cupo mínimo para que un chequeo colgado se note rápido
process.env.CENTINELA_CHECK_TIMEOUT_MS = '5000'; // plazo mínimo permitido; el reloj se acorta más abajo

var test = require('node:test');
var assert = require('node:assert');
var checks = require('../server/lib/checks.js');
var schedMod = require('../server/lib/scheduler.js');
var Scheduler = schedMod.Scheduler;
var path = require('path');
var execFileSync = require('child_process').execFileSync;

var realCheck = checks.checkTarget;
var realSetTimeout = global.setTimeout;
var acortado = false;

// El plazo global mínimo configurable es 5000 ms: se acorta sustituyendo el reloj (límite del sistema)
// solo para esa espera concreta (la de CHECK_TIMEOUT_MS), sin tocar el código de producción.
function acortarPlazoGlobal() {
  if (acortado) return;
  acortado = true;
  global.setTimeout = function (fn, ms) {
    var args = Array.prototype.slice.call(arguments);
    if (ms === schedMod.CHECK_TIMEOUT_MS) args[1] = 40;
    return realSetTimeout.apply(this, args);
  };
}
function restaurar() { global.setTimeout = realSetTimeout; acortado = false; checks.checkTarget = realCheck; }
test.afterEach(restaurar);

function tgt(id, extra) {
  return Object.assign({ id: id, name: 'obj ' + id, kind: 'host', address: '10.0.0.1', intervalSec: 60, enabled: true,
                         checks: { ping: true } }, extra || {});
}
function fakeStore(list) {
  var s = {
    list: list,
    allTargets: function () { return s.list; },
    findTarget: function (id) { return s.list.filter(function (t) { return t.id === id; })[0] || null; },
    getSettings: function () { return { intervalSec: 10, historyPoints: 5, thresholds: {} }; },
    getOrg: function () { return { id: 'default', name: 'Host', color: '#000000' }; },
    orgOf: function () { return 'default'; },
    getTargets: function () { return s.list; },
    getOrgs: function () { return [{ id: 'default' }]; }
  };
  return s;
}
function okResult(id, status) { return { id: id, ts: Date.now(), status: status || 'up', reasons: [], ping: { avg: 5, lossPct: 0 } }; }

test('R6: CHECK_TIMEOUT_MS es 5000 con CENTINELA_CHECK_TIMEOUT_MS=5000 (valor leído al cargar)', function () {
  assert.strictEqual(schedMod.CHECK_TIMEOUT_MS, 5000);
});

// Carga el módulo en un proceso aparte con otra variable de entorno y devuelve CHECK_TIMEOUT_MS.
function plazoCon(valor) {
  var env = Object.assign({}, process.env);
  delete env.CENTINELA_CHECK_TIMEOUT_MS;
  if (valor !== undefined) env.CENTINELA_CHECK_TIMEOUT_MS = valor;
  var mod = path.join(__dirname, '..', 'server', 'lib', 'scheduler.js');
  return Number(execFileSync(process.execPath, ['-e', 'console.log(require(' + JSON.stringify(mod) + ').CHECK_TIMEOUT_MS)'],
    { env: env, timeout: 15000 }).toString().trim());
}
test('R6: CHECK_TIMEOUT_MS: 120000 por defecto, configurable y con mínimo de 5000', function () {
  assert.strictEqual(plazoCon(undefined), 120000);
  assert.strictEqual(plazoCon('30000'), 30000);
  assert.strictEqual(plazoCon('7000'), 7000);
  assert.strictEqual(plazoCon('100'), 5000, 'por debajo del mínimo se sube a 5000');
  assert.strictEqual(plazoCon('abc'), 120000, 'valor no numérico => por defecto');
});

test('R6: al vencer el plazo runOne RESUELVE con DOWN y code timeout, y el cupo no se bloquea', async function () {
  acortarPlazoGlobal();
  var store = fakeStore([tgt('a'), tgt('b'), tgt('c')]);
  var s = new Scheduler(store);
  checks.checkTarget = function (t) { return t.id === 'c' ? Promise.resolve(okResult('c')) : new Promise(function () { /* cuelga */ }); };
  // a y b ocupan los 2 cupos y no terminan nunca por sí solos; c debe poder ejecutarse después del plazo.
  var pa = s.runOne(store.findTarget('a'));
  var pb = s.runOne(store.findTarget('b'));
  var rc = await Promise.race([
    s.runOne(store.findTarget('c')),
    new Promise(function (res) { realSetTimeout(function () { res('BLOQUEADO'); }, 3000); })
  ]);
  assert.notStrictEqual(rc, 'BLOQUEADO', 'el cupo debía liberarse tras el plazo global');
  assert.strictEqual(rc.status, 'up');
  var ra = await pa, rb = await pb; // resuelven, no rechazan
  [ra, rb].forEach(function (r, i) {
    assert.strictEqual(r.status, 'down');
    assert.strictEqual(r.id, ['a', 'b'][i]);
    assert.ok(Array.isArray(r.reasons) && r.reasons.some(function (x) { return x.code === 'timeout' && x.down === true && x.level === 'crit'; }), JSON.stringify(r.reasons));
  });
  assert.strictEqual(s.active, 0, 'cupos liberados');
  assert.strictEqual(s.results.get('a').status, 'down', 'el resultado DOWN queda registrado');
  assert.strictEqual(s.history.get('a').length, 1);
});

test('R6: tras el plazo el id sigue en running hasta que la verificación real termine (sin solapes)', async function () {
  acortarPlazoGlobal();
  var store = fakeStore([tgt('a')]);
  var s = new Scheduler(store);
  var llamadas = 0, terminar;
  checks.checkTarget = function () {
    llamadas++;
    if (llamadas === 1) return new Promise(function (res) { terminar = function () { res(okResult('a')); }; });
    return Promise.resolve(okResult('a'));
  };
  var r1 = await s.runOne(store.findTarget('a'));
  assert.strictEqual(r1.status, 'down');
  assert.strictEqual(s.active, 0);
  assert.ok(s.running.has('a'), 'sigue marcado como en ejecución');
  // Mientras tanto, otra ejecución del mismo objetivo no lanza una verificación nueva y devuelve el DOWN guardado.
  var r2 = await s.runOne(store.findTarget('a'));
  assert.strictEqual(llamadas, 1, 'no se solapa con la verificación colgada');
  assert.strictEqual(r2.status, 'down');
  // La verificación real termina: el id se libera y se puede volver a ejecutar.
  terminar();
  await new Promise(function (r) { realSetTimeout(r, 20); });
  assert.strictEqual(s.running.has('a'), false);
  var r3 = await s.runOne(store.findTarget('a'));
  assert.strictEqual(r3.status, 'up');
  assert.strictEqual(llamadas, 2);
});

test('R6: si la verificación colgada termina con error, el id también se libera', async function () {
  acortarPlazoGlobal();
  var store = fakeStore([tgt('a')]);
  var s = new Scheduler(store);
  var fallar;
  checks.checkTarget = function () { return new Promise(function (_, rej) { fallar = function () { rej(new Error('boom')); }; }); };
  assert.strictEqual((await s.runOne(store.findTarget('a'))).status, 'down');
  fallar();
  await new Promise(function (r) { realSetTimeout(r, 20); });
  assert.strictEqual(s.running.has('a'), false);
});

test('R6: el plazo vencido emite el evento de cambio de estado a DOWN con el motivo', async function () {
  acortarPlazoGlobal();
  var store = fakeStore([tgt('a')]);
  var s = new Scheduler(store);
  var eventos = [];
  s.on('event', function (e) { eventos.push(e); });
  checks.checkTarget = function () { return new Promise(function () {}); };
  await s.runOne(store.findTarget('a'));
  assert.strictEqual(eventos.length, 1);
  assert.strictEqual(eventos[0].to, 'down');
  assert.match(eventos[0].text, /tiempo máximo/);
});

test('R6: un error de la verificación distinto del plazo sigue propagándose y libera el cupo', async function () {
  var store = fakeStore([tgt('a')]);
  var s = new Scheduler(store);
  checks.checkTarget = function () { return Promise.reject(new Error('fallo interno')); };
  await assert.rejects(s.runOne(store.findTarget('a')), /fallo interno/);
  assert.strictEqual(s.active, 0);
  assert.strictEqual(s.running.size, 0);
});

test('R6: no hay ejecuciones solapadas del mismo id', async function () {
  var store = fakeStore([tgt('a'), tgt('b')]);
  var s = new Scheduler(store);
  var llamadas = {}, enCurso = 0, maxEnCurso = 0, liberar = [];
  checks.checkTarget = function (t) {
    llamadas[t.id] = (llamadas[t.id] || 0) + 1;
    if (t.id === 'a') { enCurso++; maxEnCurso = Math.max(maxEnCurso, enCurso); }
    return new Promise(function (res) { liberar.push(function () { if (t.id === 'a') enCurso--; res(okResult(t.id)); }); });
  };
  var p1 = s.runOne(store.findTarget('a'));
  var p2 = s.runOne(store.findTarget('a'));
  var p3 = s.runOne(store.findTarget('b'));
  await new Promise(function (r) { setImmediate(r); });
  assert.strictEqual(llamadas.a, 1, 'a solo se verifica una vez mientras sigue en curso');
  assert.strictEqual(llamadas.b, 1, 'otro id sí corre en paralelo');
  assert.strictEqual(await p2, null, 'la segunda llamada no ejecuta ni devuelve resultado previo inexistente');
  liberar.forEach(function (f) { f(); });
  await Promise.all([p1, p3]);
  assert.strictEqual(maxEnCurso, 1);
  // Terminada la primera, una nueva ejecución es válida.
  var p4 = s.runOne(store.findTarget('a'));
  await new Promise(function (r) { setImmediate(r); });
  assert.strictEqual(llamadas.a, 2);
  liberar.forEach(function (f) { f(); });
  await p4;
});

test('R6: un objetivo eliminado durante la verificación descarta el resultado', async function () {
  var store = fakeStore([tgt('a')]);
  var s = new Scheduler(store);
  var liberar;
  checks.checkTarget = function () { return new Promise(function (res) { liberar = function () { res(okResult('a')); }; }); };
  var p = s.runOne(store.findTarget('a'));
  await new Promise(function (r) { setImmediate(r); });
  store.list = [];
  liberar();
  assert.strictEqual(await p, null);
  assert.strictEqual(s.results.has('a'), false);
});

test('R6: reschedule no reprograma objetivos sin cambios', function () {
  var store = fakeStore([tgt('a'), tgt('b')]);
  var s = new Scheduler(store);
  try {
    s.reschedule();
    var ta = s.timers.get('a'), tb = s.timers.get('b');
    assert.ok(ta && tb);
    s.reschedule();
    assert.strictEqual(s.timers.get('a'), ta, 'a conserva su temporizador');
    assert.strictEqual(s.timers.get('b'), tb, 'b conserva su temporizador');
    // Un objeto nuevo con el mismo contenido tampoco reprograma.
    store.list = [JSON.parse(JSON.stringify(store.list[0])), JSON.parse(JSON.stringify(store.list[1]))];
    s.reschedule();
    assert.strictEqual(s.timers.get('a'), ta);
  } finally { s.stop(); }
});

test('R6: reschedule reprograma solo lo que cambió y limpia lo eliminado o desactivado', function () {
  var store = fakeStore([tgt('a'), tgt('b'), tgt('c')]);
  var s = new Scheduler(store);
  try {
    s.reschedule();
    var ta = s.timers.get('a'), tb = s.timers.get('b');
    store.list = [tgt('a', { intervalSec: 30 }), tgt('b'), tgt('c', { enabled: false })];
    s.reschedule();
    assert.notStrictEqual(s.timers.get('a'), ta, 'a cambió de intervalo');
    assert.strictEqual(s.timers.get('b'), tb, 'b no cambió');
    assert.strictEqual(s.timers.has('c'), false, 'c desactivado sin temporizador');
    store.list = [tgt('b')];
    s.reschedule();
    assert.strictEqual(s.timers.has('a'), false);
    assert.strictEqual(s.sigs.has('a'), false);
    assert.strictEqual(s.timers.get('b'), tb);
  } finally { s.stop(); }
});

test('R6: runOne guarda resultado e historial acotado y emite evento solo al cambiar de estado', async function () {
  var store = fakeStore([tgt('a')]);
  var s = new Scheduler(store);
  var eventos = [], estados = ['up', 'up', 'down', 'down', 'up'];
  s.on('event', function (e) { eventos.push(e); });
  var i = 0;
  checks.checkTarget = function () {
    var st = estados[i++];
    return Promise.resolve({ id: 'a', ts: Date.now() + i, status: st, reasons: st === 'down' ? [{ level: 'crit', text: 'caído', down: true }] : [] });
  };
  for (var k = 0; k < 5; k++) await s.runOne(store.findTarget('a'));
  assert.strictEqual(s.results.get('a').status, 'up');
  assert.deepStrictEqual(eventos.map(function (e) { return e.to; }), ['down', 'up']);
  assert.strictEqual(eventos[0].text, 'caído');
  assert.strictEqual(eventos[1].text, 'Servicio recuperado');
  for (k = 0; k < 10; k++) { i = 0; await s.runOne(store.findTarget('a')); }
  assert.ok(s.history.get('a').length <= 5, 'historyPoints = 5');
});
