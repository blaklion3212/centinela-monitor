'use strict';
/*
 * Motor de avisos por Telegram: decide cuándo avisar por tipo de alerta (alert-types.decideTarget: N fallos seguidos
 * y `alerted` persistido), agrupa por chat de destino y envía con una cola con ritmo y reintentos. No conoce la red:
 * usa el canal inyectado. Nunca bloquea al planificador (onResult retorna siempre de forma síncrona).
 */

var AT = require('./alert-types');
var Defaults = require('../../js/config/defaults.js');

var DEFAULT_ORG = 'default';
var VERSION_FALLBACK = '';

// Constantes de la sección 4 de los requisitos (sobrescribibles con `consts`).
var DEFAULTS = {
  GROUP_WINDOW_MS: 30000,
  MAX_ATTEMPTS: 5,
  BACKOFF_MS: [2000, 4000, 8000, 16000],
  MAX_QUEUE: 200,
  TG_MAX_TEXT: 4096,
  TG_MIN_GAP_CHAT_MS: 1000,
  TG_MAX_PER_MIN_GROUP: 20,
  TG_MAX_PER_SEC_GLOBAL: 30,
  MAX_GROUP_LINES: 20,
  MAX_RETRY_AFTER_S: 3600,
  MAX_RATE_RETRIES: 20,   // tope de esperas por 429 por mensaje, para no reintentar para siempre
  MAX_NAME: 200,
  SAVE_DELAY_MS: 500,     // retardo del guardado diferido de `alerted` (se coalescen varias escrituras)
  MAX_ALERTED: 5000,      // tope de claves avisadas persistidas (RT-11)
  MAX_ALERTED_PER_TARGET: 64
};

// Formato antiguo (item.status): se conserva para quien lo use directamente.
var ICONS = { down: '🔴', degraded: '🟠', up: '🟢' };
var LABELS = { down: 'CAÍDO', degraded: 'DEGRADADO', up: 'RECUPERADO' };

// Etiquetas por evento (RT-30). Las de latencia y recursos dependen del `code`.
var CODE_ALERT = {
  latency: 'LATENCIA ALTA', loss: 'PÉRDIDA DE PAQUETES', jitter: 'JITTER ALTO', ttfb: 'RESPUESTA LENTA',
  cpu: 'CPU ALTA', mem: 'MEMORIA ALTA', io: 'I/O LENTO'
};
// Consulta segura: el código viene del exterior y no puede resolver a propiedades heredadas.
function lookup(tbl, key) { return Object.prototype.hasOwnProperty.call(tbl, key) ? tbl[key] : ''; }
var CODE_NORMAL = {
  latency: 'Latencia normal', loss: 'Pérdida de paquetes normal', jitter: 'Jitter normal', ttfb: 'Respuesta normal',
  cpu: 'CPU normal', mem: 'Memoria normal', io: 'I/O normal'
};
// Prioridad dentro de un grupo a igualdad de ts (RT-31); las recuperaciones van al final.
var PRIORITY = ['down', 'certExpired', 'certExpiring', 'disk', 'resources', 'latency', 'certTrust', 'other'];

// -> { icon, label } del item (nuevo con `event` o antiguo con `status`).
function iconLabel(it) {
  if (!it.event) return { icon: ICONS[it.status] || '', label: LABELS[it.status] || String(it.status).toUpperCase() };
  var t = it.type || it.event;
  if (it.event === 'recovery') {
    var rl = 'RECUPERADO';
    if (t === 'certExpired' || t === 'certExpiring') rl = 'CERTIFICADO RENOVADO';
    else if (t === 'certTrust') rl = 'CERTIFICADO CONFIABLE';
    else if (t === 'disk') rl = 'ESPACIO EN DISCO NORMAL';
    else if ((t === 'latency' || t === 'resources') && lookup(CODE_NORMAL, it.sub)) rl = lookup(CODE_NORMAL, it.sub).toUpperCase();
    return { icon: '🟢', label: rl };
  }
  var crit = it.level === 'crit';
  if (t === 'down') return { icon: '🔴', label: 'CAÍDO' };
  if (t === 'certExpired') return { icon: '🔴', label: 'CERTIFICADO VENCIDO' };
  if (t === 'certExpiring') return { icon: crit ? '🔴' : '🟠', label: crit ? 'CERTIFICADO POR VENCER (URGENTE)' : 'CERTIFICADO POR VENCER' };
  if (t === 'certTrust') return { icon: '🟠', label: 'CERTIFICADO NO CONFIABLE' };
  if (t === 'disk') return { icon: crit ? '🔴' : '🟠', label: crit ? 'ESPACIO EN DISCO CRÍTICO' : 'ESPACIO EN DISCO BAJO' };
  if (t === 'latency' || t === 'resources') return { icon: '🟠', label: lookup(CODE_ALERT, it.code) || lookup(CODE_ALERT, it.sub) || 'DEGRADADO' };
  return { icon: '🟠', label: 'DEGRADADO' };
}

// Texto fijo del motivo de una recuperación (solo modo completo, RT-30).
function recoveryReason(it) {
  var t = it.type || '';
  if (t === 'certExpired' || t === 'certExpiring') return 'Certificado renovado';
  if (t === 'certTrust') return 'Certificado confiable';
  if (t === 'disk') return (it.sub ? 'Disco ' + it.sub + ': ' : '') + 'espacio normal';
  if ((t === 'latency' || t === 'resources') && lookup(CODE_NORMAL, it.sub)) return lookup(CODE_NORMAL, it.sub);
  return 'Servicio recuperado';
}

function itemRank(it) {
  if (it.event === 'recovery') return PRIORITY.length;
  var i = PRIORITY.indexOf(it.event ? (it.type || it.event) : (it.status === 'down' ? 'down' : 'other'));
  return i < 0 ? PRIORITY.length - 1 : i;
}

function mergeConsts(over) {
  var out = {}, k;
  for (k in DEFAULTS) out[k] = DEFAULTS[k];
  if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
  return out;
}

/* ---------------------------------------------------------------------------------------------
 * Formato (puro)
 * ------------------------------------------------------------------------------------------- */

function clip(s, max) {
  s = String(s == null ? '' : s);
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtTime(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// Sustituye caracteres de control (y separadores de línea Unicode) por espacios, para que un nombre o motivo
// no pueda falsear líneas del aviso.
// También C1 y caracteres de formato/bidi (U+200B-200F, U+202A-202E, U+2060-206F, U+FEFF).
function clean(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, ' '); }

// Quita de una URL usuario, contraseña, query y fragmento (queda protocolo://host[:puerto]/ruta). Un host o IP queda igual.
function cleanAddress(a) {
  var s = clean(a);
  var m = /^([A-Za-z][A-Za-z0-9+.\-]*:)\/\/(.*)$/.exec(s);
  if (!m) return s;
  try {
    var u = new URL(s);
    var hasPath = /^[^:]+:\/\/[^\/?#]*\//.test(s);
    return m[1] + '//' + u.host + (u.pathname === '/' && !hasPath ? '' : u.pathname);
  } catch (e) {
    var rest = m[2], slash = rest.indexOf('/'), seg = slash < 0 ? rest : rest.slice(0, slash), at = seg.lastIndexOf('@');
    if (at >= 0) rest = rest.slice(at + 1);
    return m[1] + '//' + rest.replace(/[?#].*$/, '');
  }
}

// item: { event, type, level, code, sub, name, label, address, reason, ts } (o el antiguo con `status`).
// Devuelve las líneas del aviso (la primera es la principal). En modo mínimo no salen sub ni motivo (RT-60).
function itemLines(it, full, c) {
  var il = iconLabel(it);
  var head = il.icon + ' ' + (it.label ? '[' + clip(clean(it.label), c.MAX_NAME) + '] ' : '') +
    clip(clean(it.name), c.MAX_NAME) + ': ' + il.label;
  var lines = [head];
  if (full) {
    var reason = it.event === 'recovery' ? recoveryReason(it) : (it.status === 'up' ? 'Servicio recuperado' : it.reason);
    if (it.address) lines.push('Dirección: ' + clip(cleanAddress(it.address), 300));
    if (reason) lines.push('Motivo: ' + clip(clean(reason), 500));
    var t = fmtTime(it.ts);
    if (t) lines.push('Hora: ' + t);
  }
  return lines;
}

// items: lista de avisos del mismo chat. Devuelve un único texto de como máximo TG_MAX_TEXT caracteres.
function formatMessage(items, cfg, consts) {
  var c = mergeConsts(consts);
  var full = !!(cfg && cfg.detail === 'full');
  var list = (items || []).slice().sort(function (a, b) { return ((a.ts || 0) - (b.ts || 0)) || (itemRank(a) - itemRank(b)); });
  if (!list.length) return '';
  if (list.length === 1) return clip(itemLines(list[0], full, c).join('\n'), c.TG_MAX_TEXT);

  var blocks = list.map(function (it) {
    var ls = itemLines(it, full, c);
    return full ? [ls[0]].concat(ls.slice(1).map(function (x) { return '   ' + x; })).join('\n') : ls[0];
  });
  var header = list.length + ' avisos';
  var show = Math.min(blocks.length, c.MAX_GROUP_LINES);

  function build(k) {
    var out = header + '\n' + blocks.slice(0, k).join('\n');
    if (k < blocks.length) out += '\n… y ' + (blocks.length - k) + ' más';
    return out;
  }
  var text = build(show);
  while (text.length > c.TG_MAX_TEXT && show > 1) { show--; text = build(show); }
  return clip(text, c.TG_MAX_TEXT);
}

/* ---------------------------------------------------------------------------------------------
 * Motor
 * ------------------------------------------------------------------------------------------- */

function realClock() {
  return {
    now: function () { return Date.now(); },
    setTimeout: function (fn, ms) { var t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout: function (t) { clearTimeout(t); }
  };
}

function create(opts) {
  opts = opts || {};
  var store = opts.store;
  var alertsStore = opts.alertsStore;
  var channel = opts.channel;
  var env = opts.env || process.env;
  var log = opts.log || function (m) { console.log('[alertas] ' + m); };
  var clock = opts.clock || realClock();
  var c = mergeConsts(opts.consts);
  // Si GROUP_WINDOW_MS llega en `consts` (variable interna de pruebas) manda sobre el ajuste groupWindowSec.
  var fixedWindow = !!(opts.consts && Object.prototype.hasOwnProperty.call(opts.consts, 'GROUP_WINDOW_MS'));
  var version = opts.version || VERSION_FALLBACK;
  var cfgApi = alertsStore.cfgApi;
  var chatsFromUpdates = opts.chatsFromUpdates || (channel && channel.chatsFromUpdates);

  var cfg = null;
  var sched = null, handler = null;
  var gen = 0;                 // se incrementa al vaciar: las respuestas antiguas dejan de actuar sobre la cola
  var seq = 0;
  var counters = {};           // id -> { 'tipo|sub': { level, count, crit, missing } } (memoria)
  var volatileKeys = {};       // claves avisadas que superaron un límite: viven solo en memoria (RT-11)
  var limitLogged = false;     // una sola línea de log por episodio de límite alcanzado
  var redirect = {};           // chat viejo -> chat nuevo tras una migración (para ventanas de agrupación abiertas)
  var saveTimer = null, saveDirty = false; // guardado diferido de `alerted`
  var chats = {};              // chatId -> { queue, group, pumpTimer, sending, nextAt, log }
  var sendLog = [];            // instantes de envío globales (último segundo)
  var pausedUntil = 0;         // pausa global por 429 (solo si no se puede atribuir a un chat)
  var stats = { alertedLimitHits: 0, sentTotal: 0, failedTotal: 0, droppedTotal: 0, noDest: 0, lastSentAt: 0, lastError: null, failing: false, note: '' };

  function safeLog(m) { try { log(m); } catch (e) { /* el registro nunca debe romper el motor */ } }
  function now() { return clock.now(); }

  function loadCfg() {
    if (saveDirty) flushAlerted(); // no perder un guardado pendiente al releer el disco
    try { cfg = alertsStore.load(); } catch (e) { safeLog('No se pudo leer la configuración de alertas'); }
    if (!cfg) cfg = {};
    if (!cfg.alerted || typeof cfg.alerted !== 'object') cfg.alerted = {};
    Object.keys(volatileKeys).forEach(function (k) { cfg.alerted[k] = volatileKeys[k]; }); // claves solo en memoria
    return cfg;
  }
  // Casillas «Qué avisar» vigentes (9 booleanos); lo que falte toma el valor por defecto.
  function notifyOf() {
    var n = {}, src = cfg && cfg.notify && typeof cfg.notify === 'object' ? cfg.notify : {};
    AT.NOTIFY_KEYS.forEach(function (k) { n[k] = typeof src[k] === 'boolean' ? src[k] : AT.DEFAULT_NOTIFY[k]; });
    return n;
  }
  function thresholdsNow() {
    var t = null;
    try { t = typeof opts.thresholds === 'function' ? opts.thresholds() : opts.thresholds; } catch (e) { t = null; }
    return (t && typeof t === 'object') ? t : Defaults.SETTINGS.thresholds;
  }
  function effective() { return !!(cfg && cfgApi.effectiveOn(cfg, env)); }

  // `alerted` sin las claves que solo viven en memoria por haber superado un límite.
  function persistable() {
    var o = {};
    Object.keys(cfg.alerted).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(volatileKeys, k)) o[k] = cfg.alerted[k]; });
    return o;
  }
  // Guarda solo `alerted` sobre la configuración vigente en disco, para no pisar token o ajustes recién editados.
  function writeAlerted() {
    try {
      var fresh = alertsStore.load() || {};
      fresh.alerted = persistable();
      alertsStore.save(fresh);
    } catch (e) { safeLog('No se pudo guardar el estado de avisos (alerted)'); }
  }
  // Guardado diferido y coalescido: varios cambios seguidos producen una sola escritura.
  function saveAlerted() {
    saveDirty = true;
    if (saveTimer) return;
    saveTimer = clock.setTimeout(function () { saveTimer = null; flushAlerted(); }, c.SAVE_DELAY_MS);
  }
  function flushAlerted() {
    if (saveTimer) { clock.clearTimeout(saveTimer); saveTimer = null; }
    if (!saveDirty) return;
    saveDirty = false;
    if (cfg) writeAlerted();
  }

  /* ---- vaciado ---- */
  function clearAll() {
    gen++;
    Object.keys(chats).forEach(function (k) {
      var ch = chats[k];
      if (ch.pumpTimer) clock.clearTimeout(ch.pumpTimer);
      if (ch.group && ch.group.timer) clock.clearTimeout(ch.group.timer);
    });
    chats = {};
    sendLog = [];
    pausedUntil = 0;
    redirect = {};
  }

  function chatState(key) {
    return chats[key] || (chats[key] = { queue: [], group: null, pumpTimer: null, sending: false, nextAt: 0, log: [] });
  }
  function totalQueued() { var n = 0; Object.keys(chats).forEach(function (k) { n += chats[k].queue.length; }); return n; }
  function totalInWindow() { var n = 0; Object.keys(chats).forEach(function (k) { if (chats[k].group) n += chats[k].group.items.length; }); return n; }

  // Descartes sin intento de envío (cola llena, sin destino, función apagada): cuentan solo en droppedTotal.
  function drop(n) { stats.droppedTotal += (n || 1); }
  // Chat nuevo de una migración (si el viejo se movió), para no encolar con el identificador antiguo.
  function resolveKey(key) { return Object.prototype.hasOwnProperty.call(redirect, key) ? redirect[key] : key; }

  // Id de migración de Telegram normalizado a texto de entero y validado; '' si no es válido.
  function normMigrate(v) {
    var s = String(v == null ? '' : v).trim();
    return /^-?[1-9]\d{0,19}$/.test(s) && cfgApi.validateChatId(s) ? s : '';
  }

  // Mueve cola y estado del chat viejo al nuevo. Devuelve el estado destino.
  function moveChat(oldKey, newKey) {
    var ch = chats[oldKey];
    redirect[oldKey] = newKey;
    if (!ch) return null;
    delete chats[oldKey];
    var dst = chats[newKey];
    if (!dst) { chats[newKey] = ch; return ch; }
    dst.queue = dst.queue.concat(ch.queue); // al final: el mensaje en vuelo del destino sigue en la posición 0
    dst.nextAt = Math.max(dst.nextAt, ch.nextAt);
    dst.log = dst.log.concat(ch.log);
    ch.queue = [];
    return dst;
  }

  /* ---- cola ---- */
  function enqueue(key, text) {
    var ch = chatState(key);
    ch.queue.push({ chatId: key, text: text, attempts: 0, rl: 0, migrated: false, seq: ++seq });
    // Tope: descarta los más antiguos (nunca el que va en vuelo).
    while (totalQueued() > c.MAX_QUEUE) {
      var best = null, bestKey = null, bestIdx = 0;
      Object.keys(chats).forEach(function (k) {
        var q = chats[k].queue, idx = chats[k].sending ? 1 : 0;
        if (q[idx] && (!best || q[idx].seq < best.seq)) { best = q[idx]; bestKey = k; bestIdx = idx; }
      });
      if (!best) break;
      chats[bestKey].queue.splice(bestIdx, 1);
      drop(1);
    }
    pump(key);
  }

  function isGroupChat(id) { return String(id).charAt(0) === '-'; }

  function waitFor(ch, msg) {
    var t = now(), w = 0, lim;
    w = Math.max(w, ch.nextAt - t, pausedUntil - t);
    while (sendLog.length && sendLog[0] <= t - 1000) sendLog.shift();
    if (sendLog.length >= c.TG_MAX_PER_SEC_GLOBAL) w = Math.max(w, sendLog[0] + 1000 - t);
    if (isGroupChat(msg.chatId)) {
      while (ch.log.length && ch.log[0] <= t - 60000) ch.log.shift();
      if (ch.log.length >= c.TG_MAX_PER_MIN_GROUP) w = Math.max(w, ch.log[0] + 60000 - t);
    }
    lim = w > 0 ? Math.ceil(w) : 0;
    return lim;
  }

  function pump(key) {
    var ch = chats[key];
    if (!ch || ch.sending || ch.pumpTimer || !ch.queue.length) return;
    var w = waitFor(ch, ch.queue[0]);
    if (w > 0) {
      var g = gen;
      ch.pumpTimer = clock.setTimeout(function () {
        if (g !== gen) return;
        ch.pumpTimer = null;
        pump(key);
      }, w);
      return;
    }
    send(key, ch);
  }

  function setError(code, message) {
    stats.failing = true;
    stats.lastError = { at: now(), code: code || 'unknown', message: message || 'Error al enviar' };
  }

  function finish(key, ch, g) {
    ch.sending = false;
    ch.nextAt = Math.max(ch.nextAt, now() + c.TG_MIN_GAP_CHAT_MS);
    if (g === gen) pump(key);
  }

  function send(key, ch) {
    var msg = ch.queue[0];
    var g = gen;
    var ti = cfgApi.tokenInfo(cfg, env);
    if (!effective() || !ti || !ti.token) { // se desactivó o perdió el token entre medias
      ch.queue.shift(); drop(1); pump(key); return;
    }
    ch.sending = true;
    var t0 = now();
    sendLog.push(t0);
    if (isGroupChat(msg.chatId)) ch.log.push(t0); // el tope por minuto solo aplica a grupos
    ch.nextAt = t0 + c.TG_MIN_GAP_CHAT_MS;

    var p;
    try { p = Promise.resolve(channel.sendMessage(ti.token, msg.chatId, msg.text)); }
    catch (e) { p = Promise.resolve({ ok: false, code: 'unknown', message: 'Error interno al enviar', transient: true }); }
    p.then(function (res) { return res; }, function () {
      return { ok: false, code: 'unknown', message: 'Error interno al enviar', transient: true };
    }).then(function (res) {
      if (g !== gen) { ch.sending = false; return; } // se vació mientras iba en vuelo
      try { handleResult(key, ch, msg, res || {}, g); }
      catch (e) { safeLog('Error interno al procesar la respuesta de envío'); ch.sending = false; }
    });
  }

  function handleResult(key, ch, msg, res, g) {
    if (res.ok) {
      ch.queue.shift();
      stats.sentTotal++;
      stats.lastSentAt = now();
      stats.failing = false;
      return finish(key, ch, g);
    }
    // El id de migración debe ser un identificador válido; si no, se trata como un error desconocido.
    var mig = res.migrateTo != null ? normMigrate(res.migrateTo) : '';
    if (res.migrateTo != null && !mig) res = { ok: false, code: 'unknown', message: 'Respuesta inesperada de Telegram', transient: false };
    var message = res.message || 'Error al enviar';
    setError(res.code, message);

    // Grupo migrado a supergrupo: actualizar el chat guardado, mover la cola y reintentar una vez.
    if (mig && !msg.migrated && migrateChat(msg.chatId, mig)) {
      // Se guarda el id viejo antes: msg es queue[0] y se reasigna en la primera vuelta.
      var oldId = msg.chatId;
      ch.queue.forEach(function (m) { if (m.chatId === oldId) m.chatId = mig; });
      msg.migrated = true;
      var dst = moveChat(key, mig);
      if (dst === ch) return finish(mig, ch, g);
      ch.sending = false;
      if (dst && g === gen) pump(mig);
      return;
    }

    if (res.code === 'rate_limited' || (res.retryAfterS != null && res.retryAfterS > 0)) {
      var r = Math.min(Math.max(Number(res.retryAfterS) || 0, 0), c.MAX_RETRY_AFTER_S);
      if (r > 0) {
        // La espera pedida por Telegram se atribuye al chat; la pausa global solo si no hay chat conocido.
        if (ch) ch.nextAt = Math.max(ch.nextAt, now() + r * 1000);
        else pausedUntil = Math.max(pausedUntil, now() + r * 1000);
        if (msg.rl < c.MAX_RATE_RETRIES) {
          msg.rl++; // espera pedida por Telegram: no consume intentos
        } else {
          ch.queue.shift(); stats.failedTotal++; // tope de esperas agotado: se descarta, nunca antes de la espera
        }
        return finish(key, ch, g);
      }
      res = { transient: true }; // sin retry_after: usa el retroceso habitual
    }

    if (res.transient || res.code === 'rate_limited') {
      msg.attempts++;
      if (msg.attempts >= c.MAX_ATTEMPTS) {
        ch.queue.shift(); stats.failedTotal++;
        return finish(key, ch, g);
      }
      var back = c.BACKOFF_MS[Math.min(msg.attempts - 1, c.BACKOFF_MS.length - 1)];
      ch.nextAt = Math.max(ch.nextAt, now() + back);
      return finish(key, ch, g);
    }

    // Error definitivo: se descarta y se sigue con el siguiente.
    ch.queue.shift(); stats.failedTotal++;
    finish(key, ch, g);
  }

  // Si el chat viejo es el general o uno de orgChats, lo sustituye y guarda. Devuelve true si cambió algo.
  function migrateChat(oldId, newId) {
    var changed = false;
    try {
      var fresh = alertsStore.load() || {};
      if (fresh.chatId === oldId) { fresh.chatId = newId; cfg.chatId = newId; changed = true; }
      if (fresh.orgChats) Object.keys(fresh.orgChats).forEach(function (o) {
        if (fresh.orgChats[o] === oldId) { fresh.orgChats[o] = newId; if (cfg.orgChats) cfg.orgChats[o] = newId; changed = true; }
      });
      if (changed) {
        fresh.alerted = persistable();
        alertsStore.save(fresh);
        stats.note = 'El grupo pasó a supergrupo; chat actualizado';
        safeLog('El grupo pasó a supergrupo; chat actualizado (' + oldId + ' -> ' + newId + ')');
      }
    } catch (e) { safeLog('No se pudo guardar el chat migrado'); }
    return changed;
  }

  /* ---- agrupación ---- */
  function groupWindowMs() {
    if (fixedWindow) return c.GROUP_WINDOW_MS;
    var s = cfg && typeof cfg.groupWindowSec === 'number' ? cfg.groupWindowSec : c.GROUP_WINDOW_MS / 1000;
    return s * 1000;
  }
  function addToGroup(key, item) {
    var ch = chatState(key);
    if (!ch.group) {
      var g = gen;
      ch.group = { items: [], timer: null };
      ch.group.timer = clock.setTimeout(function () {
        if (g !== gen) return;
        var grp = ch.group;
        ch.group = null;
        if (!grp || !grp.items.length) return;
        try { enqueue(resolveKey(key), formatMessage(grp.items, cfg, c)); }
        catch (e) { safeLog('Error interno al preparar un aviso'); }
      }, groupWindowMs());
    }
    ch.group.items.push(item);
  }

  /* ---- estado avisado por objetivo ---- */
  // Vista local de un objetivo: claves 'tipo[|sub]' sin el prefijo 'id|'.
  // Recorre todo el mapa plano: medido en ~0,3 ms por resultado con 5000 claves (suficiente; no se indexa por objetivo).
  function viewOf(id) {
    var pre = id + '|', o = {};
    Object.keys(cfg.alerted).forEach(function (k) { if (k.indexOf(pre) === 0) o[k.slice(pre.length)] = cfg.alerted[k]; });
    return o;
  }
  function sameMap(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(function (k) { return Object.prototype.hasOwnProperty.call(b, k) && b[k] === a[k]; });
  }
  function isVolatile(k) { return Object.prototype.hasOwnProperty.call(volatileKeys, k); }
  function persistedCount(pre) {
    var n = 0;
    Object.keys(cfg.alerted).forEach(function (k) { if (!isVolatile(k) && (!pre || k.indexOf(pre) === 0)) n++; });
    return n;
  }
  function overLimit(pre) { return persistedCount('') >= c.MAX_ALERTED || persistedCount(pre) >= c.MAX_ALERTED_PER_TARGET; }

  // Al liberarse espacio, las claves solo en memoria pasan a persistidas si caben (RT-11).
  function promoteVolatile() {
    var moved = false;
    Object.keys(volatileKeys).forEach(function (k) {
      var pre = k.slice(0, k.indexOf('|') + 1);
      if (!overLimit(pre)) { delete volatileKeys[k]; moved = true; }
    });
    if (!Object.keys(volatileKeys).length) limitLogged = false; // el episodio de límite terminó
    if (moved) saveAlerted();
  }

  // Aplica la vista nueva al mapa plano. Una clave nueva que supera un límite (RT-11) no se persiste: queda en memoria.
  // Devuelve las claves nuevas rechazadas (límite y memoria agotados); su aviso se descarta, contado en el estado.
  function mergeView(id, oldV, newV) {
    var pre = id + '|', rejected = {}, removed = false;
    Object.keys(oldV).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(newV, k)) { delete cfg.alerted[pre + k]; delete volatileKeys[pre + k]; removed = true; }
    });
    Object.keys(newV).forEach(function (k) {
      var full = pre + k, isNew = !Object.prototype.hasOwnProperty.call(oldV, k);
      if (isNew && overLimit(pre)) {
        stats.alertedLimitHits++;
        if (!limitLogged) { limitLogged = true; safeLog('Límite de avisos recordados alcanzado'); }
        if (Object.keys(volatileKeys).length >= c.MAX_ALERTED) { rejected[full] = true; return; }
        volatileKeys[full] = newV[k];
      } else if (isVolatile(full)) volatileKeys[full] = newV[k];
      cfg.alerted[full] = newV[k];
    });
    if (removed) promoteVolatile();
    return rejected;
  }

  // Fuentes habilitadas del objetivo según su configuración (RT-13); null si no se conoce (se decide por presencia).
  function checksOnOf(t) {
    var ck = t && t.checks;
    if (!ck || typeof ck !== 'object') return null;
    return { ping: !!ck.ping, http: t.kind === 'url' && !!ck.http, ssl: !!ck.ssl, agent: !!(ck.agent && ck.agent.enabled) };
  }

  function itemOf(ev, r, target, org) {
    var recovery = ev.kind === 'recovery';
    return {
      event: recovery ? 'recovery' : ev.type, type: ev.type, level: ev.level, code: ev.code, sub: ev.sub || '',
      ts: ev.ts || r.ts || now(), name: target.name || r.id,
      // Etiqueta de organización solo cuando no es la principal ('default').
      label: (org && org.id !== DEFAULT_ORG) ? (org.name || '') : '',
      address: target.address || '',
      reason: recovery ? '' : (ev.reasons.join(' · ') || 'Sin detalle')
    };
  }

  /* ---- entrada de resultados ---- */
  function onResult(r) {
    try {
      if (!r || !r.id) return;
      if (!cfg) loadCfg();
      if (!effective()) return;
      var st = r.status;
      if (st !== 'up' && st !== 'degraded' && st !== 'down') return;

      var target = store.findTarget(r.id) || {};
      var oldV = viewOf(r.id);
      var d = AT.decideTarget({ id: r.id, r: r, alerted: oldV, counters: counters[r.id] || {}, notify: notifyOf(),
        n: cfg.failsBeforeAlert || 2, thresholds: thresholdsNow(), checksOn: checksOnOf(target) });
      if (Object.keys(d.counters).length) counters[r.id] = d.counters; else delete counters[r.id];
      var events = d.events;
      if (!sameMap(oldV, d.alerted)) {
        var rej = mergeView(r.id, oldV, d.alerted);
        events = events.filter(function (ev) { return ev.kind !== 'alert' || !rej[AT.encodeKey(r.id, ev.type, ev.sub)]; });
        stats.droppedTotal += d.events.length - events.length;
        saveAlerted();
      }
      if (!events.length) return;

      // Datos capturados en este instante (el objetivo puede borrarse antes del envío).
      var orgId = store.orgOf(r.id);
      var org = orgId ? store.getOrg(orgId) : null;
      var dest = cfgApi.chatFor(cfg, orgId);
      if (!dest) { stats.noDest++; drop(events.length); return; }
      var key = resolveKey(String(dest));
      events.forEach(function (ev) { addToGroup(key, itemOf(ev, r, target, org)); });
    } catch (e) {
      safeLog('Error interno al procesar un resultado');
    }
  }

  /* ---- ciclo de vida ---- */
  function subscribe() {
    if (!sched || handler) return;
    handler = function (r) { onResult(r); };
    sched.on('result', handler);
  }
  function unsubscribe() {
    if (sched && handler) sched.removeListener('result', handler);
    handler = null;
  }

  function start(scheduler) {
    sched = scheduler;
    loadCfg();
    dropDisabledTypes();   // claves de tipos desactivados: se eliminan en silencio al cargar (RT-21)
    flushAlerted();
    if (effective()) subscribe();
  }

  function stop() {
    unsubscribe();
    clearAll();
    flushAlerted(); // el guardado pendiente no se pierde al parar
  }

  function reload() {
    var wasOn = !!cfg && effective();
    var prevChat = cfg ? cfgApi.chatFor(cfg, null) : '';
    loadCfg();
    // Cambio de chat general: las caídas avisadas al chat anterior se olvidan, para que el nuevo destino las reciba
    // (tras N fallos, como cualquier caída). Así una alerta que falló por un chat mal puesto se repite al corregirlo.
    if (wasOn && prevChat && cfgApi.chatFor(cfg, null) !== prevChat && Object.keys(cfg.alerted).length) {
      cfg.alerted = {}; volatileKeys = {}; limitLogged = false; saveDirty = true; flushAlerted();
      safeLog('Chat de destino cambiado: se volverán a avisar las caídas vigentes');
    }
    if (effective()) {
      if (!wasOn) { stats.failing = false; stats.lastError = null; } // pasa de apagado a encendido: estado de error limpio
      dropDisabledTypes();
      subscribe();
    } else {
      unsubscribe();
      clearAll();
      counters = {}; volatileKeys = {}; limitLogged = false;
      if (Object.keys(cfg.alerted).length) { cfg.alerted = {}; saveDirty = true; flushAlerted(); } // al apagar se guarda de inmediato
    }
  }

  // Tipos desactivados en «Qué avisar»: sus claves y contadores se eliminan en silencio (RT-13, RT-17).
  function dropDisabledTypes() {
    var nf = notifyOf(), changed = false;
    function off(type) { return AT.TYPES.indexOf(type) >= 0 && !nf[type]; }
    Object.keys(cfg.alerted).forEach(function (k) {
      var p = AT.parseKey(k);
      if (p && off(p.type)) { delete cfg.alerted[k]; delete volatileKeys[k]; changed = true; }
    });
    Object.keys(counters).forEach(function (id) {
      Object.keys(counters[id]).forEach(function (lk) { if (off(lk.split('|')[0])) delete counters[id][lk]; });
      if (!Object.keys(counters[id]).length) delete counters[id];
    });
    if (changed) saveAlerted();
  }

  function prune() {
    try {
      if (!cfg) loadCfg();
      var ids = {};
      store.allTargets().forEach(function (t) { ids[t.id] = true; });
      var changed = false;
      // Claves 'id|tipo[|sub]' de objetivos que ya no existen: se borran sin avisar recuperación.
      Object.keys(cfg.alerted).forEach(function (k) {
        var p = AT.parseKey(k);
        if (!p || !ids[p.id]) { delete cfg.alerted[k]; delete volatileKeys[k]; changed = true; }
      });
      Object.keys(counters).forEach(function (id) { if (!ids[id]) delete counters[id]; });
      // Objetivos deshabilitados: pierden sus contadores; `alerted` se conserva para avisar la recuperación.
      store.allTargets().forEach(function (t) { if (t.enabled === false) delete counters[t.id]; });
      if (changed) { promoteVolatile(); saveAlerted(); }
    } catch (e) { safeLog('Error interno al limpiar avisos'); }
  }

  /* ---- acciones explícitas del administrador ---- */
  function precheck(needChat, chatIdOpt) {
    loadCfg();
    if (cfgApi.blockedByEnv(env)) return { ok: false, code: 'alerts_disabled_by_env', message: 'Las alertas están bloqueadas por la variable CENTINELA_ALERTS_DISABLED' };
    var ti = cfgApi.tokenInfo(cfg, env);
    if (!ti || !ti.token) return { ok: false, code: 'no_token', message: 'Falta el token del bot' };
    if (needChat) {
      var chat = (chatIdOpt != null && String(chatIdOpt) !== '') ? String(chatIdOpt) : cfgApi.chatFor(cfg, null);
      if (!chat) return { ok: false, code: 'no_chat', message: 'Falta el chat de destino' };
      if (!cfgApi.validateChatId(chat)) return { ok: false, code: 'no_chat', message: 'El chat de destino no tiene un formato válido' };
      return { ok: true, token: ti.token, chat: chat, saved: !(chatIdOpt != null && String(chatIdOpt) !== '') || chat === cfgApi.chatFor(cfg, null) };
    }
    return { ok: true, token: ti.token };
  }

  function failOut(res) {
    var o = { ok: false, code: res.code || 'unknown', message: res.message || 'Error al contactar con Telegram' };
    if (res.retryAfterS != null) o.retryAfterS = res.retryAfterS;
    if (res.migrateTo != null) o.migrateTo = res.migrateTo;
    return o;
  }

  function callChannel(fn) {
    var p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.resolve(null); }
    return p.then(function (r) { return r; }, function () { return null; })
      .then(function (r) { return r || { ok: false, code: 'unknown', message: 'Error interno al contactar con Telegram', transient: true }; });
  }

  function test(chatIdOpt) {
    var pc = precheck(true, chatIdOpt);
    if (!pc.ok) return Promise.resolve(pc);
    var text = '✅ Centinela: mensaje de prueba' + (version ? '\nVersión ' + version : '');
    function attempt(chat, retried) {
      return callChannel(function () { return channel.sendMessage(pc.token, chat, text); }).then(function (res) {
        if (res.ok) {
          var okOut = { ok: true, message: 'Mensaje de prueba enviado' };
          if (retried) { okOut.chatId = chat; okOut.migratedTo = chat; } // el chat guardado cambió: la interfaz lo refleja
          return okOut;
        }
        var mig = res.migrateTo != null ? normMigrate(res.migrateTo) : '';
        if (res.migrateTo != null && !mig) return { ok: false, code: 'unknown', message: 'Respuesta inesperada de Telegram' };
        if (mig && !retried) {
          if (pc.saved && migrateChat(chat, mig)) return attempt(mig, true);
          var o = failOut(res);
          o.migrateTo = mig;
          o.message = 'El grupo pasó a supergrupo; el nuevo id de chat es ' + mig;
          return o;
        }
        return failOut(res);
      });
    }
    return attempt(pc.chat, false);
  }

  function findChats() {
    var pc = precheck(false);
    if (!pc.ok) return Promise.resolve(pc);
    return callChannel(function () { return channel.getUpdates(pc.token); }).then(function (res) {
      if (!res.ok) return failOut(res);
      var list = [];
      try { list = chatsFromUpdates ? chatsFromUpdates(res.result) : []; } catch (e) { list = []; }
      var out = { ok: true, chats: list };
      if (!list.length) out.hint = 'Escríbele un mensaje al bot y vuelve a pulsar';
      return out;
    });
  }

  // Recuento de claves avisadas por tipo, sin ids, nombres ni particiones (RT-41, RT-60).
  function activeByType() {
    var out = {};
    AT.TYPES.forEach(function (t) { out[t] = 0; });
    Object.keys(cfg.alerted || {}).forEach(function (k) {
      var p = AT.parseKey(k);
      if (p && Object.prototype.hasOwnProperty.call(out, p.type)) out[p.type]++;
    });
    return out;
  }

  function status() {
    if (!cfg) loadCfg();
    var ti = cfgApi.tokenInfo(cfg, env) || {};
    var state;
    if (cfgApi.blockedByEnv(env)) state = 'blocked';
    else if (!effective()) state = 'off';
    else state = stats.failing ? 'error' : 'ok';
    return {
      state: state,
      lastSentAt: stats.lastSentAt || null,
      lastError: stats.lastError,
      queued: totalQueued(),
      inWindow: totalInWindow(),
      sentTotal: stats.sentTotal,
      failedTotal: stats.failedTotal,
      droppedTotal: stats.droppedTotal,
      alertedLimitHits: stats.alertedLimitHits,
      activeByType: activeByType(),
      tokenSource: ti.source || 'none',
      note: stats.note || ''
    };
  }

  return {
    start: start, stop: stop, reload: reload, onResult: onResult, prune: prune,
    test: test, findChats: findChats, status: status
  };
}

module.exports = { create: create, formatMessage: formatMessage, DEFAULTS: DEFAULTS };
