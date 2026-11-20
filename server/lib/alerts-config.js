'use strict';
/*
 * Configuración de las alertas por Telegram (data/alerts.json, 0600). Sin red.
 * Las funciones son puras salvo load y save, que usan el módulo store recibido
 * (así las pruebas pueden inyectar uno falso). El token vive solo en este archivo
 * (o en la variable CENTINELA_TELEGRAM_TOKEN) y nunca sale en publicView.
 */
var FILE = 'alerts.json';
var VERSION = 2;
var AT = require('./alert-types');

var TOKEN_RE = /^[1-9]\d{0,17}:[A-Za-z0-9_-]{30,}$/; // mismo criterio que el canal: solo letras, dígitos, _ y -
var CHAT_USER_RE = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
var CHAT_NUM_RE = /^-?[1-9]\d{0,19}$/;
var CHAT_MIN = -4000000000000;
var CHAT_MAX = 1099511627775;
var ORG_ID_RE = /^[a-z0-9]{1,32}$/;
var TARGET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var MAX_ALERTED = 5000;
var MAX_ALERTED_PER_TARGET = 64;
var MAX_SUB_ENCODED = 200;
var ALERTED_LEVELS = ['on', 'warn', 'crit'];
// Subclaves válidas por tipo: latency y resources solo admiten sus códigos.
var SUB_CODES = { latency: ['latency', 'loss', 'jitter', 'ttfb'], resources: ['cpu', 'mem', 'io'] };

// Esperas permitidas (s) para agrupar avisos antes de enviarlos; 0 envía en cuanto se detecta el cambio.
var GROUP_WINDOWS = [0, 10, 30, 60];

var DEFAULTS = {
  version: VERSION,
  enabled: false,
  token: '',
  chatId: '',
  orgChats: {},
  detail: 'minimal',
  failsBeforeAlert: 2,
  groupWindowSec: 30,
  notify: AT.DEFAULT_NOTIFY,
  alerted: {}
};

function copyDefaults() { return JSON.parse(JSON.stringify(DEFAULTS)); }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/* ---- validadores puros ---- */

// Formato laxo (la validación real la hace getMe): <id>:<secreto>, total <= 80.
function validateToken(str) {
  return typeof str === 'string' && str.length <= 80 && TOKEN_RE.test(str);
}

// Entero con signo dentro del rango de la Bot API, o @usuario_canal público.
function validateChatId(str) {
  if (typeof str !== 'string') return false;
  if (CHAT_USER_RE.test(str)) return true;
  if (!CHAT_NUM_RE.test(str)) return false;
  var n = Number(str);
  return isFinite(n) && n >= CHAT_MIN && n <= CHAT_MAX;
}

function blockedByEnv(env) {
  var v = env && env.CENTINELA_ALERTS_DISABLED;
  return /^(1|true)$/i.test(String(v == null ? '' : v).trim());
}

/* ---- token ---- */

function hintOf(token) { return token ? '…' + token.slice(-4) : ''; }

// La variable de entorno manda; si su formato no es válido se trata como no definida.
function tokenInfo(cfg, env) {
  var raw = env && env.CENTINELA_TELEGRAM_TOKEN;
  var envTok = raw == null ? '' : String(raw).trim();
  var envInvalid = false;
  if (envTok) {
    if (validateToken(envTok)) return { token: envTok, source: 'env', hint: hintOf(envTok), envInvalid: false };
    envInvalid = true;
  }
  var panel = cfg && validateToken(cfg.token) ? cfg.token : '';
  if (panel) return { token: panel, source: 'panel', hint: hintOf(panel), envInvalid: envInvalid };
  return { token: '', source: 'none', hint: '', envInvalid: envInvalid };
}

/* ---- destino ---- */

// Único punto de resolución del chat de destino (RA-11).
function chatFor(cfg, orgId) {
  if (!cfg) return '';
  if (orgId != null && isObj(cfg.orgChats) && has(cfg.orgChats, orgId) && cfg.orgChats[orgId]) return String(cfg.orgChats[orgId]);
  return cfg.chatId ? String(cfg.chatId) : '';
}

function effectiveOn(cfg, env) {
  return !!(cfg && cfg.enabled === true && !blockedByEnv(env) && tokenInfo(cfg, env).source !== 'none' && chatFor(cfg, null));
}

/* ---- saneado tolerante (al cargar) ---- */

// notify: si falta o no es objeto se migra desde notifyRecovery/notifyDegraded de 2.4.0 (RT-22).
function sanitizeNotify(src) {
  var out = {};
  if (isObj(src.notify)) {
    AT.NOTIFY_KEYS.forEach(function (k) { out[k] = typeof src.notify[k] === 'boolean' ? src.notify[k] : AT.DEFAULT_NOTIFY[k]; });
    return out;
  }
  AT.NOTIFY_KEYS.forEach(function (k) { out[k] = AT.DEFAULT_NOTIFY[k]; });
  if (typeof src.notifyRecovery === 'boolean') out.recovery = src.notifyRecovery;
  AT.DEGRADE_TYPES.forEach(function (k) { out[k] = src.notifyDegraded === true; });
  return out;
}

// Una clave de alerted ya validada -> [clave, nivel] o null. Acepta el formato antiguo {id: 'down'|'degraded'} (RT-23).
function alertedEntry(k, v) {
  if (k === '__proto__') return null;
  if (TARGET_ID_RE.test(k)) {
    if (v === 'down') return [k + '|down', 'm']; // 'm' = migrado de 2.4.0 (solo válido en el tipo down)
    if (v === 'degraded') return [k + '|legacy', 'on'];
    return null;
  }
  var p = AT.parseKey(k);
  if (!p || p.id === '__proto__' || !TARGET_ID_RE.test(p.id)) return null;
  if (p.type !== 'legacy' && AT.TYPES.indexOf(p.type) < 0) return null;
  // Clave canónica: la subclave debe ser exactamente la que generaría encodeKey (sin variantes de codificación).
  if (AT.encodeKey(p.id, p.type, p.sub) !== k) return null;
  var codes = SUB_CODES[p.type];
  if (codes ? codes.indexOf(p.sub) < 0 : (p.type !== 'disk' && p.type !== 'other' && p.sub !== '')) return null;
  if (ALERTED_LEVELS.indexOf(v) < 0 && !(v === 'm' && p.type === 'down')) return null;
  return [k, v];
}

// alerted: { 'id|tipo[|sub]': 'on'|'warn'|'crit' }, con límites global y por objetivo (RT-10, RT-11).
function sanitizeAlerted(input) {
  var out = {};
  if (!isObj(input)) return out;
  var total = 0, perTarget = Object.create(null);
  Object.keys(input).forEach(function (k) {
    var e = alertedEntry(k, input[k]);
    if (!e || total >= MAX_ALERTED || has(out, e[0])) return;
    var id = e[0].split('|')[0];
    if ((perTarget[id] || 0) >= MAX_ALERTED_PER_TARGET) return;
    out[e[0]] = e[1]; total++; perTarget[id] = (perTarget[id] || 0) + 1;
  });
  return out;
}

function sanitize(input, orgIds) {
  var d = copyDefaults();
  var src = isObj(input) ? input : {};
  d.enabled = src.enabled === true;
  d.token = validateToken(src.token) ? src.token : '';
  d.chatId = validateChatId(src.chatId) ? src.chatId : '';
  d.detail = src.detail === 'full' ? 'full' : 'minimal';
  var f = src.failsBeforeAlert;
  d.failsBeforeAlert = (typeof f === 'number' && isFinite(f)) ? Math.min(10, Math.max(1, Math.round(f))) : DEFAULTS.failsBeforeAlert;
  d.groupWindowSec = GROUP_WINDOWS.indexOf(src.groupWindowSec) >= 0 ? src.groupWindowSec : DEFAULTS.groupWindowSec;
  d.notify = sanitizeNotify(src);

  // orgChats: solo organizaciones existentes y chats válidos.
  if (isObj(src.orgChats)) {
    var known = Array.isArray(orgIds) ? orgIds : null;
    Object.keys(src.orgChats).forEach(function (k) {
      if (!ORG_ID_RE.test(k) || !validateChatId(src.orgChats[k])) return;
      if (known && known.indexOf(k) < 0) return;
      d.orgChats[k] = src.orgChats[k];
    });
  }
  d.alerted = sanitizeAlerted(src.alerted);
  return d;
}

function load(storeMod, orgIds) {
  var r;
  try { r = storeMod.read(FILE); } catch (e) { return copyDefaults(); } // ilegible: valores por defecto
  if (!r || !r.exists) return copyDefaults();
  var cfg = sanitize(r.value, orgIds);
  // Si el saneado cambió algo respecto al archivo (sin depender del orden de claves), se reescribe.
  // Si el disco falla se sigue con el valor saneado en memoria.
  if (canon(cfg) !== canon(r.value)) {
    try { storeMod.write(FILE, cfg); }
    catch (e) { console.warn('[alertas] No se pudo reescribir alerts.json saneado; se usa la configuración en memoria'); }
  }
  return cfg;
}

// JSON con las claves ordenadas, para comparar objetos sin importar el orden.
function canon(v) {
  return JSON.stringify(v, function (k, val) {
    if (!isObj(val)) return val;
    var o = {};
    Object.keys(val).sort().forEach(function (x) { o[x] = val[x]; });
    return o;
  });
}

function save(storeMod, cfg) { storeMod.write(FILE, cfg); }

/* ---- validación estricta (al recibir de la API) ---- */

// «notify» parcial y campos antiguos (RT-42). Si el cuerpo trae «notify», los antiguos se ignoran (aunque se validan).
function applyNotify(body, next, errors) {
  var old = {};
  ['notifyRecovery', 'notifyDegraded'].forEach(function (k) {
    if (!has(body, k)) return;
    if (typeof body[k] !== 'boolean') errors.push('«' + k + '» debe ser verdadero o falso.');
    else old[k] = body[k];
  });
  if (has(body, 'notify')) {
    if (!isObj(body.notify)) { errors.push('«notify» debe ser un objeto con los tipos de aviso.'); return; }
    var upd = {}, bad = false;
    Object.keys(body.notify).forEach(function (k) {
      if (AT.NOTIFY_KEYS.indexOf(k) < 0) {
        bad = true;
        errors.push('«notify» no admite la clave «' + String(k).slice(0, 40) + '». Claves válidas: ' + AT.NOTIFY_KEYS.join(', ') + '.');
      } else if (typeof body.notify[k] !== 'boolean') {
        bad = true;
        errors.push('«notify.' + k + '» debe ser verdadero o falso.');
      } else upd[k] = body.notify[k];
    });
    if (!bad) Object.keys(upd).forEach(function (k) { next.notify[k] = upd[k]; });
    return;
  }
  if (has(old, 'notifyRecovery')) next.notify.recovery = old.notifyRecovery;
  if (has(old, 'notifyDegraded')) AT.DEGRADE_TYPES.forEach(function (k) { next.notify[k] = old.notifyDegraded; });
}

// -> { errors: [..] } | { value: nextCfg }. Todo o nada. Nunca toca token ni alerted.
function validateUpdate(body, cfg, env) {
  var errors = [];
  if (!isObj(body)) return { errors: ['El cuerpo de la petición debe ser un objeto JSON.'] };
  var next = JSON.parse(JSON.stringify(cfg || copyDefaults()));
  next.notify = sanitizeNotify(next);
  delete next.notifyRecovery; delete next.notifyDegraded;

  if (has(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') errors.push('«enabled» debe ser verdadero o falso.');
    else next.enabled = body.enabled;
  }
  if (has(body, 'chatId')) {
    if (typeof body.chatId !== 'string') errors.push('El chat debe ser texto: un número como -1001234567890 o un @canal público.');
    else {
      var c = body.chatId.trim();
      if (c !== '' && !validateChatId(c)) errors.push('El chat no es válido: usa un número como 123456789 o -1001234567890, o un @canal público de 5 a 32 caracteres.');
      else next.chatId = c;
    }
  }
  if (has(body, 'orgChats')) {
    if (!isObj(body.orgChats)) errors.push('«orgChats» debe ser un objeto.');
    else if (Object.keys(body.orgChats).length > 0) errors.push('Los chats por organización aún no están disponibles');
  }
  if (has(body, 'detail')) {
    if (body.detail !== 'minimal' && body.detail !== 'full') errors.push('El detalle debe ser «minimal» o «full».');
    else next.detail = body.detail;
  }
  if (has(body, 'failsBeforeAlert')) {
    var f = body.failsBeforeAlert;
    if (typeof f !== 'number' || Math.floor(f) !== f || f < 1 || f > 10) errors.push('Los fallos consecutivos antes de avisar deben ser un entero entre 1 y 10.');
    else next.failsBeforeAlert = f;
  }
  if (has(body, 'groupWindowSec')) {
    if (GROUP_WINDOWS.indexOf(body.groupWindowSec) < 0) errors.push('La espera antes de enviar debe ser 0, 10, 30 o 60 segundos.');
    else next.groupWindowSec = body.groupWindowSec;
  }
  applyNotify(body, next, errors);

  // Activar exige token y chat; también si se vacía el chat con las alertas ya activas.
  if (!errors.length && next.enabled === true && (body.enabled === true || has(body, 'chatId'))) {
    if (tokenInfo(next, env).source === 'none') errors.push('Para activar las alertas falta el token del bot: guárdalo antes en el panel o define CENTINELA_TELEGRAM_TOKEN.');
    if (!next.chatId) errors.push('Para activar las alertas falta el chat de destino: indica un chat o usa «Buscar mis chats».');
  }
  return errors.length ? { errors: errors } : { value: next };
}

/* ---- vista pública (GET /api/alerts): sin token ni alerted ---- */

function publicView(cfg, env) {
  var t = tokenInfo(cfg, env);
  var orgChats = {};
  var notify = sanitizeNotify(cfg || {});
  if (cfg && isObj(cfg.orgChats)) Object.keys(cfg.orgChats).forEach(function (k) { orgChats[k] = cfg.orgChats[k]; });
  return {
    enabled: !!(cfg && cfg.enabled),
    blockedByEnv: blockedByEnv(env),
    tokenConfigured: t.source !== 'none',
    tokenHint: t.hint,
    tokenSource: t.source,
    chatId: (cfg && cfg.chatId) || '',
    orgChats: orgChats,
    detail: cfg && cfg.detail === 'full' ? 'full' : 'minimal',
    failsBeforeAlert: cfg ? cfg.failsBeforeAlert : DEFAULTS.failsBeforeAlert,
    groupWindowSec: cfg && GROUP_WINDOWS.indexOf(cfg.groupWindowSec) >= 0 ? cfg.groupWindowSec : DEFAULTS.groupWindowSec,
    notify: notify,
    notifyRecovery: notify.recovery,
    notifyDegraded: AT.DEGRADE_TYPES.every(function (k) { return notify[k] === true; }),
    version: VERSION
  };
}

module.exports = {
  DEFAULTS: DEFAULTS, NOTIFY_KEYS: AT.NOTIFY_KEYS, MAX_ALERTED: MAX_ALERTED, MAX_ALERTED_PER_TARGET: MAX_ALERTED_PER_TARGET, GROUP_WINDOWS: GROUP_WINDOWS, FILE: FILE, load: load, save: save, validateUpdate: validateUpdate,
  validateToken: validateToken, validateChatId: validateChatId, tokenInfo: tokenInfo,
  blockedByEnv: blockedByEnv, publicView: publicView, chatFor: chatFor, effectiveOn: effectiveOn
};
