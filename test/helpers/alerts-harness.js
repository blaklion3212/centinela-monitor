'use strict';
/*
 * Dobles de prueba del motor de avisos (server/lib/notify.js), solo en los límites del sistema:
 *   - reloj falso (now, setTimeout, clearTimeout) que avanza a mano y ejecuta los temporizadores en orden;
 *   - canal falso programable (lo que hay al otro lado del motor es el canal de Telegram);
 *   - store de objetivos y almacén de configuración en memoria;
 *   - planificador falso (EventEmitter) que emite 'result'.
 * Ninguna prueba que lo use espera tiempo real ni toca disco ni red.
 */
var EventEmitter = require('events').EventEmitter;
var cfgMod = require('../../server/lib/alerts-config');
var tg = require('../../server/lib/channels/telegram');
var notify = require('../../server/lib/notify');

var TOKEN = '123456789:AAH_abcdefghijklmnopqrstuvwxyz012345';
var TOKEN_ENV = '987654321:BBH_abcdefghijklmnopqrstuvwxyz067890';

function flush() { return new Promise(function (r) { setImmediate(r); }).then(function () { return new Promise(function (r) { setImmediate(r); }); }); }

function fakeClock() {
  var t = 1700000000000, timers = [], seq = 0;
  var c = {
    now: function () { return t; },
    setTimeout: function (fn, ms) { var h = { at: t + Math.max(0, Number(ms) || 0), fn: fn, id: ++seq }; timers.push(h); return h; },
    clearTimeout: function (h) { var i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    pending: function () { return timers.length; },
    flush: flush,
    // Avanza ms milisegundos ejecutando, en orden, los temporizadores que vencen.
    advance: async function (ms) {
      var target = t + ms;
      await flush();
      for (;;) {
        var next = null;
        timers.forEach(function (h) { if (h.at <= target && (!next || h.at < next.at || (h.at === next.at && h.id < next.id))) next = h; });
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        if (next.at > t) t = next.at;
        next.fn();
        await flush();
      }
      t = target;
      await flush();
    }
  };
  return c;
}

// Canal falso. program(res...) encola resultados; un resultado puede ser un objeto de Res, o { hold: true } para dejar
// la petición sin resolver (devuelve un resolvedor en chan.held).
function fakeChannel(clock) {
  var ch = { calls: [], held: [], queue: [], def: null, chatsFromUpdates: tg.chatsFromUpdates, updatesCalls: 0 };
  ch.program = function () { for (var i = 0; i < arguments.length; i++) ch.queue.push(arguments[i]); return ch; };
  ch.setDefault = function (r) { ch.def = r; return ch; };
  function next(def) { return ch.queue.length ? ch.queue.shift() : (ch.def || def); }
  ch.sendMessage = function (token, chat, text) {
    ch.calls.push({ t: clock.now(), token: token, chat: String(chat), text: text });
    var r = next({ ok: true, result: { message_id: 1 } });
    if (r && r.hold) return new Promise(function (resolve) { ch.held.push(resolve); });
    if (r && r.throws) return Promise.reject(new Error('fallo inesperado'));
    return Promise.resolve(r);
  };
  ch.getUpdates = function (token) {
    ch.updatesCalls++;
    return Promise.resolve(ch.updatesRes || { ok: true, result: [] });
  };
  ch.getMe = function () { return Promise.resolve({ ok: true, result: {} }); };
  ch.texts = function () { return ch.calls.map(function (c) { return c.text; }); };
  return ch;
}

var ORGS = { default: { id: 'default', name: 'Principal' }, acme: { id: 'acme', name: 'Cliente ACME' } };

function fakeTargets() {
  var targets = {}, orgOf = {};
  var s = {
    add: function (id, name, address, org) { targets[id] = { id: id, name: name, address: address || '', org: org || 'default' }; orgOf[id] = org || 'default'; return s; },
    remove: function (id) { delete targets[id]; delete orgOf[id]; },
    findTarget: function (id) { return targets[id] || null; },
    orgOf: function (id) { return orgOf[id] || null; },
    getOrg: function (id) { return ORGS[id] || (id && { id: id, name: 'Org ' + id }) || null; },
    allTargets: function () { return Object.keys(targets).map(function (k) { return targets[k]; }); }
  };
  return s;
}

function baseCfg(over) {
  var c = Object.assign(JSON.parse(JSON.stringify(cfgMod.DEFAULTS)),
    { enabled: true, token: TOKEN, chatId: '-100111', failsBeforeAlert: 2 }, over || {});
  // `notify` parcial (p. ej. { latency: true }) se completa con los valores por defecto de las 9 casillas.
  c.notify = Object.assign({}, cfgMod.DEFAULTS.notify, (over && over.notify) || {});
  return c;
}

/*
 * Arma un motor completo. opts: cfg (sobrescribe la configuración en "disco"), env, consts, targets ([ [id, name, address, org] ]),
 * noStart (no llama a start). Devuelve { notifier, clock, chan, sched, store, disk, logs, down(id), up(id), emit(id, status, extra),
 * restart() }.
 */
function harness(opts) {
  opts = opts || {};
  var clock = fakeClock();
  var chan = fakeChannel(clock);
  var sched = new EventEmitter();
  var store = fakeTargets();
  var disk = { cfg: baseCfg(opts.cfg), saves: 0 };
  var logs = [];
  (opts.targets || [['t1', 'Portal', '10.0.0.1']]).forEach(function (a) { store.add.apply(store, a); });
  var alertsStore = {
    load: function () { return JSON.parse(JSON.stringify(disk.cfg)); },
    save: function (c) { disk.saves++; disk.cfg = JSON.parse(JSON.stringify(c)); },
    cfgApi: cfgMod
  };
  var env = opts.env || {};
  function build() {
    return notify.create({ store: store, alertsStore: alertsStore, channel: chan, env: env, log: function (m) { logs.push(m); },
      clock: clock, consts: opts.consts, version: '9.9.9', chatsFromUpdates: tg.chatsFromUpdates });
  }
  var h = { clock: clock, chan: chan, sched: sched, store: store, disk: disk, logs: logs, env: env };
  h.notifier = build();
  if (!opts.noStart) h.notifier.start(sched);
  // Motivos por defecto según el estado (contrato 2.5.0):
  //   up       -> sin motivos;
  //   degraded -> un motivo de latencia crítica, sin `down` (clasifica como tipo `latency`; con `warn` sería `other`);
  //   down     -> un motivo con `down: true` (clasifica como tipo `down`).
  // Para emitir motivos concretos: h.emit(id, status, { reasons: [ H.reason(...) ] }).
  function defaultReasons(status) {
    if (status === 'up') return [];
    if (status === 'degraded') return [{ level: 'crit', text: 'latencia alta', down: false, code: 'latency' }];
    return [{ level: 'crit', text: 'sin respuesta', down: true }];
  }
  h.emit = function (id, status, extra) {
    // `ping` medible por omisión: la latencia cuenta como medida y puede recuperarse (RT-15); pásalo en `extra` para cambiarlo.
    sched.emit('result', Object.assign({ id: id, ts: clock.now(), status: status, reasons: defaultReasons(status), ping: { received: 4 } }, extra || {}));
  };
  // Emite un resultado con el estado y los motivos dados (atajo de emit con `reasons`).
  h.emitReasons = function (id, status, reasons, extra) {
    h.emit(id, status, Object.assign({ reasons: reasons }, extra || {}));
  };
  h.down = function (id) { h.emit(id || 't1', 'down'); };
  h.up = function (id) { h.emit(id || 't1', 'up'); };
  // Simula un reinicio del servidor: motor nuevo sobre el mismo "disco"; la cola y los contadores se pierden.
  h.restart = function () {
    h.notifier.stop();
    h.notifier = build();
    h.notifier.start(sched);
    return h.notifier;
  };
  return h;
}

// Construye un motivo del evaluador: reason('crit', 'latency', { text: '...', sub: '/' }).
function reason(level, code, o) {
  return Object.assign({ level: level, code: code, down: false, text: 'motivo ' + code }, o || {});
}

module.exports = { harness: harness, reason: reason, fakeClock: fakeClock, fakeChannel: fakeChannel, fakeTargets: fakeTargets, baseCfg: baseCfg, TOKEN: TOKEN,
  TOKEN_ENV: TOKEN_ENV, flush: flush };
