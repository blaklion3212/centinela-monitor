'use strict';
/*
 * Motor de avisos por Telegram: decide cuándo avisar (N fallos seguidos y `alerted` persistido),
 * agrupa por chat de destino y envía con una cola con ritmo y reintentos. No conoce la red:
 * usa el canal inyectado. Nunca bloquea al planificador (onResult retorna siempre de forma síncrona).
 */

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
  SAVE_DELAY_MS: 500      // retardo del guardado diferido de `alerted` (se coalescen varias escrituras)
};

var ICONS = { down: '🔴', degraded: '🟠', up: '🟢' };
var LABELS = { down: 'CAÍDO', degraded: 'DEGRADADO', up: 'RECUPERADO' };

function mergeConsts(over) {
  var out = {}, k;
  for (k in DEFAULTS) out[k] = DEFAULTS[k];
  if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
  return out;
}

/* ---------------------------------------------------------------------------------------------
 * Decisión (pura)
 * ------------------------------------------------------------------------------------------- */

// prev: { fails, downFails, alerted } con alerted en null|'down'|'degraded'. Implementa RA-40 a RA-44.
// `fails` cuenta resultados down o degraded consecutivos (según notifyDegraded); `downFails`, solo los down consecutivos.
// Solo se avisa cuando la gravedad sube: degraded avisado -> down exige N down seguidos; down avisado -> degraded no avisa.
function decide(prev, status, cfg) {
  var fails = (prev && prev.fails) || 0;
  var downFails = (prev && prev.downFails) || 0;
  var alerted = (prev && prev.alerted) || null;
  var n = (cfg && cfg.failsBeforeAlert) || 2;
  var action = null;

  if (status === 'up') {
    fails = 0; downFails = 0;
    if (alerted) {
      if (cfg && cfg.notifyRecovery) action = 'up';
      alerted = null; // sin aviso de recuperación sale de `alerted` en silencio
    }
  } else if (status === 'down' || (status === 'degraded' && cfg && cfg.notifyDegraded)) {
    fails++;
    downFails = status === 'down' ? downFails + 1 : 0;
    if (fails >= n) {
      if (status === 'down') {
        if (alerted !== 'down' && (alerted !== 'degraded' || downFails >= n)) { action = 'down'; alerted = 'down'; }
      } else if (!alerted) { action = 'degraded'; alerted = 'degraded'; }
    }
  }
  // 'degraded' con notifyDegraded apagado: ni cuenta ni reinicia; cualquier otro estado (unknown): sin efecto.
  return { next: { fails: fails, downFails: downFails, alerted: alerted }, action: action };
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
function clean(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' '); }

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

// item: { status, name, label, address, reason, ts }. Devuelve las líneas del aviso (la primera es la principal).
function itemLines(it, full, c) {
  var head = (ICONS[it.status] || '') + ' ' + (it.label ? '[' + clip(clean(it.label), c.MAX_NAME) + '] ' : '') +
    clip(clean(it.name), c.MAX_NAME) + ': ' + (LABELS[it.status] || String(it.status).toUpperCase());
  var lines = [head];
  if (full) {
    var reason = it.status === 'up' ? 'Servicio recuperado' : it.reason;
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
  var list = (items || []).slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
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
  var version = opts.version || VERSION_FALLBACK;
  var cfgApi = alertsStore.cfgApi;
  var chatsFromUpdates = opts.chatsFromUpdates || (channel && channel.chatsFromUpdates);

  var cfg = null;
  var sched = null, handler = null;
  var gen = 0;                 // se incrementa al vaciar: las respuestas antiguas dejan de actuar sobre la cola
  var seq = 0;
  var fails = {};              // id -> { fails, downFails } consecutivos (memoria)
  var redirect = {};           // chat viejo -> chat nuevo tras una migración (para ventanas de agrupación abiertas)
  var saveTimer = null, saveDirty = false; // guardado diferido de `alerted`
  var chats = {};              // chatId -> { queue, group, pumpTimer, sending, nextAt, log }
  var sendLog = [];            // instantes de envío globales (último segundo)
  var pausedUntil = 0;         // pausa global por 429 (solo si no se puede atribuir a un chat)
  var stats = { sentTotal: 0, failedTotal: 0, droppedTotal: 0, noDest: 0, lastSentAt: 0, lastError: null, failing: false, note: '' };

  function safeLog(m) { try { log(m); } catch (e) { /* el registro nunca debe romper el motor */ } }
  function now() { return clock.now(); }

  function loadCfg() {
    if (saveDirty) flushAlerted(); // no perder un guardado pendiente al releer el disco
    try { cfg = alertsStore.load(); } catch (e) { safeLog('No se pudo leer la configuración de alertas'); }
    if (!cfg) cfg = {};
    if (!cfg.alerted || typeof cfg.alerted !== 'object') cfg.alerted = {};
    return cfg;
  }
  function effective() { return !!(cfg && cfgApi.effectiveOn(cfg, env)); }

  // Guarda solo `alerted` sobre la configuración vigente en disco, para no pisar token o ajustes recién editados.
  function writeAlerted() {
    try {
      var fresh = alertsStore.load() || {};
      fresh.alerted = cfg.alerted;
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
        fresh.alerted = cfg.alerted;
        alertsStore.save(fresh);
        stats.note = 'El grupo pasó a supergrupo; chat actualizado';
        safeLog('El grupo pasó a supergrupo; chat actualizado (' + oldId + ' -> ' + newId + ')');
      }
    } catch (e) { safeLog('No se pudo guardar el chat migrado'); }
    return changed;
  }

  /* ---- agrupación ---- */
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
      }, c.GROUP_WINDOW_MS);
    }
    ch.group.items.push(item);
  }

  /* ---- entrada de resultados ---- */
  function onResult(r) {
    try {
      if (!r || !r.id) return;
      if (!cfg) loadCfg();
      if (!effective()) return;
      var st = r.status;
      if (st !== 'up' && st !== 'degraded' && st !== 'down') return;

      var prevAl = cfg.alerted[r.id] || null;
      var pf = fails[r.id] || {};
      var d = decide({ fails: pf.fails || 0, downFails: pf.downFails || 0, alerted: prevAl }, st, cfg);
      fails[r.id] = { fails: d.next.fails, downFails: d.next.downFails };
      if (d.next.alerted !== prevAl) {
        if (d.next.alerted) cfg.alerted[r.id] = d.next.alerted; else delete cfg.alerted[r.id];
        saveAlerted();
      }
      if (!d.action) return;

      // Datos capturados en este instante (el objetivo puede borrarse antes del envío).
      var target = store.findTarget(r.id) || {};
      var orgId = store.orgOf(r.id);
      var org = orgId ? store.getOrg(orgId) : null;
      var reason = d.action === 'up' ? 'Servicio recuperado' :
        ((r.reasons || []).filter(function (x) { return x && x.level !== 'info'; }).map(function (x) { return x.text; }).join(' · ') || 'Sin detalle');
      var item = {
        status: d.action, ts: r.ts || now(), name: target.name || r.id,
        // Etiqueta de organización solo cuando no es la principal ('default').
        label: (org && org.id !== DEFAULT_ORG) ? (org.name || '') : '',
        address: target.address || '', reason: reason
      };
      var dest = cfgApi.chatFor(cfg, orgId);
      if (!dest) { stats.noDest++; drop(1); return; }
      addToGroup(resolveKey(String(dest)), item);
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
      cfg.alerted = {}; saveDirty = true; flushAlerted();
      safeLog('Chat de destino cambiado: se volverán a avisar las caídas vigentes');
    }
    if (effective()) {
      if (!wasOn) { stats.failing = false; stats.lastError = null; } // pasa de apagado a encendido: estado de error limpio
      subscribe();
    } else {
      unsubscribe();
      clearAll();
      fails = {};
      if (Object.keys(cfg.alerted).length) { cfg.alerted = {}; saveDirty = true; flushAlerted(); } // al apagar se guarda de inmediato
    }
  }

  function prune() {
    try {
      if (!cfg) loadCfg();
      var ids = {};
      store.allTargets().forEach(function (t) { ids[t.id] = true; });
      var changed = false;
      Object.keys(cfg.alerted).forEach(function (id) { if (!ids[id]) { delete cfg.alerted[id]; changed = true; } });
      Object.keys(fails).forEach(function (id) { if (!ids[id]) delete fails[id]; });
      // Objetivos deshabilitados: pierden su racha de fallos; `alerted` se conserva para avisar la recuperación.
      store.allTargets().forEach(function (t) { if (t.enabled === false) delete fails[t.id]; });
      if (changed) saveAlerted();
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
      tokenSource: ti.source || 'none',
      note: stats.note || ''
    };
  }

  return {
    start: start, stop: stop, reload: reload, onResult: onResult, prune: prune,
    test: test, findChats: findChats, status: status
  };
}

module.exports = { create: create, decide: decide, formatMessage: formatMessage, DEFAULTS: DEFAULTS };
