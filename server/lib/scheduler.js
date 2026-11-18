'use strict';
/*
 * Planificador: ejecuta las verificaciones de cada objetivo según su intervalo, guarda el último
 * resultado, el historial para las gráficas y el registro de eventos (cambios de estado).
 */
var EventEmitter = require('events').EventEmitter;
var Evaluate = require('../../js/core/evaluate.js');
var checks = require('./checks');
var util = require('./util');

// Verificaciones simultáneas (todas las organizaciones comparten el mismo tope). Ajustable con CENTINELA_CONCURRENCY.
var MAX_CONCURRENT = Math.min(64, Math.max(2, parseInt(process.env.CENTINELA_CONCURRENCY || '16', 10) || 16));
var MAX_EVENTS = 300;
// Plazo global de una verificación completa: un chequeo colgado no debe bloquear el cupo ni el objetivo.
// Ajustable con CENTINELA_CHECK_TIMEOUT_MS (mínimo 5000).
var CHECK_TIMEOUT_MS = Math.max(5000, parseInt(process.env.CENTINELA_CHECK_TIMEOUT_MS || '120000', 10) || 120000);
var TIMEOUT_REASON = 'La verificación excedió el tiempo máximo';

function Scheduler(store) {
  EventEmitter.call(this);
  this.store = store;
  this.timers = new Map();
  this.sigs = new Map(); // id -> firma de la configuración con la que se programó
  this.running = new Set();
  this.results = new Map();
  this.history = new Map();
  this.events = [];
  this.active = 0;
  this.waiters = [];
  this.orphans = 0; // verificaciones con plazo vencido cuya sonda sigue viva
  this.stopped = false;
}
Scheduler.prototype = Object.create(EventEmitter.prototype);

// Capacidad efectiva: las verificaciones huérfanas (plazo vencido pero sonda aún viva) siguen consumiendo recursos,
// así que restan cupo, hasta un máximo de la mitad (nunca se bloquea del todo y el exceso queda acotado).
Scheduler.prototype.capacity = function () {
  return MAX_CONCURRENT - Math.min(this.orphans, Math.floor(MAX_CONCURRENT / 2));
};
Scheduler.prototype.drain = function () {
  while (this.waiters.length && this.active < this.capacity()) { this.active++; this.waiters.shift()(); }
};
Scheduler.prototype.acquire = function () {
  var self = this;
  if (self.active < self.capacity()) { self.active++; return Promise.resolve(); }
  return new Promise(function (res) { self.waiters.push(res); });
};
Scheduler.prototype.release = function () {
  if (this.active > 0) this.active--;
  this.drain();
};
// Estado de concurrencia (para pruebas y diagnóstico).
Scheduler.prototype.stats = function () {
  return { active: this.active, waiting: this.waiters.length, orphans: this.orphans, capacity: this.capacity(), max: MAX_CONCURRENT };
};

Scheduler.prototype.start = function () {
  this.stopped = false;
  this.reschedule();
};

Scheduler.prototype.stop = function () {
  this.stopped = true;
  this.timers.forEach(function (t) { clearTimeout(t); });
  this.timers.clear();
  this.sigs.clear();
};

// Firma de lo que obliga a reprogramar un objetivo (intervalo, checks, dirección, tipo y activación).
function signature(t) {
  return JSON.stringify([t.intervalSec, t.checks, t.address, t.kind, !!t.enabled]);
}

// Sincroniza los temporizadores con la lista actual de objetivos: solo toca los nuevos, eliminados o
// con cambios de intervalo, checks, dirección o activación; los demás conservan su temporizador.
Scheduler.prototype.reschedule = function () {
  var self = this;
  var targets = self.store.allTargets();
  var ids = {}, fresh = 0;
  targets.forEach(function (t) {
    ids[t.id] = true;
    var sig = signature(t);
    if (!t.enabled) { self.clear(t.id); self.sigs.set(t.id, sig); return; }
    if (self.sigs.get(t.id) === sig && self.timers.has(t.id)) return; // sin cambios: conserva su temporizador
    self.clear(t.id);
    self.sigs.set(t.id, sig);
    self.schedule(t, 300 + (fresh++ * 200) % 15000); // arranque escalonado para no lanzar todo a la vez
  });
  Array.from(self.timers.keys()).forEach(function (id) { if (!ids[id]) self.clear(id); });
  Array.from(self.sigs.keys()).forEach(function (id) { if (!ids[id]) self.sigs.delete(id); });
  Array.from(self.results.keys()).forEach(function (id) {
    if (!ids[id]) { self.results.delete(id); self.history.delete(id); }
  });
};

Scheduler.prototype.clear = function (id) {
  var t = this.timers.get(id);
  if (t) { clearTimeout(t); this.timers.delete(id); }
};

Scheduler.prototype.schedule = function (target, delayMs) {
  var self = this;
  var timer = setTimeout(async function () {
    if (self.stopped) return;
    var current = self.store.findTarget(target.id);
    if (!current || !current.enabled) return;
    try { await self.runOne(current); } catch (e) { console.error('[scheduler]', current.name, e.message); }
    if (self.stopped) return;
    var again = self.store.findTarget(target.id);
    if (again && again.enabled && self.timers.get(target.id) === timer) {
      self.schedule(again, (again.intervalSec || self.store.getSettings().intervalSec) * 1000);
    }
  }, delayMs);
  self.timers.set(target.id, timer);
};

// Indica si ya hay una verificación en curso para ese objetivo.
Scheduler.prototype.isRunning = function (id) { return this.running.has(id); };

Scheduler.prototype.runOne = async function (target) {
  var self = this, id = target.id;
  if (self.running.has(id)) return self.results.get(id) || null;
  self.running.add(id);
  var settings = self.store.getSettings();
  var r, acquired = false, held = false; // held: el id sigue en running tras vencer el plazo
  try {
    await self.acquire();
    acquired = true;
    var real = Promise.resolve(checks.checkTarget(target, settings));
    try {
      r = await util.withTimeout(real, CHECK_TIMEOUT_MS, 'verificación sin respuesta (plazo global agotado)');
    } catch (e) {
      if (!e || e.code !== 'ETIMEOUT') throw e;
      // Plazo global vencido: se registra el objetivo como DOWN y se libera el cupo, pero el id sigue en
      // "running" hasta que la verificación real termine (evita solapar dos verificaciones del mismo objetivo).
      r = { id: id, ts: Date.now(), status: Evaluate.STATUS.DOWN,
            reasons: [{ level: 'crit', text: TIMEOUT_REASON, down: true, code: 'timeout' }] };
      held = true;
      // Mientras siga viva cuenta como huérfana y reduce la capacidad efectiva (ver capacity).
      self.orphans++;
      console.warn('[scheduler] verificación huérfana: "' + (target.name || id) + '" excedió el plazo; huérfanas vivas: ' + self.orphans);
      // Tope a la huérfana (2 x plazo): pasado, se libera el id y se descuenta igualmente. "settled" evita el doble descuento.
      var settled = false, cap = null;
      var release = function (why) {
        if (settled) return;
        settled = true;
        if (cap) clearTimeout(cap);
        self.running.delete(id);
        self.orphans--;
        console.warn('[scheduler] verificación huérfana ' + why + ': "' + (target.name || id) + '"; huérfanas vivas: ' + self.orphans);
        self.drain();
      };
      cap = setTimeout(function () { release('liberada por tope de ' + (2 * CHECK_TIMEOUT_MS) + ' ms sin terminar'); }, 2 * CHECK_TIMEOUT_MS);
      if (cap.unref) cap.unref();
      real.then(function () {}, function () {}).then(function () { release('terminada'); });
    }
  } finally {
    if (acquired) self.release();
    if (!held) self.running.delete(id);
  }

  // Si el objetivo se eliminó mientras corría la verificación, se descarta.
  if (!self.store.findTarget(id)) return null;

  var prev = self.results.get(id);
  self.results.set(id, r);

  var hist = self.history.get(id) || [];
  hist.push(Evaluate.toPoint(r));
  var max = settings.historyPoints || 360;
  if (hist.length > max) hist.splice(0, hist.length - max);
  self.history.set(id, hist);

  var changed = prev ? prev.status !== r.status : (r.status === 'down' || r.status === 'degraded');
  if (changed) {
    var text = r.status === 'up' ? 'Servicio recuperado'
      : (r.reasons.filter(function (x) { return x.level !== 'info'; }).map(function (x) { return x.text; }).join(' · ') || 'Sin detalle');
    var org = self.store.getOrg(self.store.orgOf(id));
    var ev = { id: id + '-' + r.ts, ts: r.ts, targetId: id, name: target.name, org: org ? org.id : null, orgName: org ? org.name : '', orgColor: org ? org.color : null, from: prev ? prev.status : null, to: r.status, text: text };
    self.events.unshift(ev);
    if (self.events.length > MAX_EVENTS) self.events.length = MAX_EVENTS;
    self.emit('event', ev);
  }
  self.emit('result', r);
  return r;
};

// Resultados e historial solo de una organización (los eventos son globales) y estados compactos de todos los objetivos.
Scheduler.prototype.snapshot = function (orgId) {
  var self = this, results = {}, history = {};
  self.store.getTargets(orgId).forEach(function (t) {
    if (self.results.has(t.id)) results[t.id] = self.results.get(t.id);
    if (self.history.has(t.id)) history[t.id] = self.history.get(t.id);
  });
  return { results: results, history: history, events: self.events };
};

// { id: { o: orgId, s: estado, e: activo } } de todos los objetivos, para los indicadores por organización.
Scheduler.prototype.statuses = function () {
  var self = this, out = {};
  self.store.getOrgs().forEach(function (o) {
    self.store.getTargets(o.id).forEach(function (t) {
      var r = self.results.get(t.id);
      out[t.id] = { o: o.id, s: r ? r.status : 'unknown', e: !!t.enabled };
    });
  });
  return out;
};

module.exports = { Scheduler: Scheduler, CHECK_TIMEOUT_MS: CHECK_TIMEOUT_MS };
