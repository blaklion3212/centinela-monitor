'use strict';
/*
 * Tipos de alerta seleccionables (2.5.0). Módulo puro: sin E/S, sin reloj, sin dependencias.
 * Clasifica los motivos del evaluador en tipos y decide, para UN resultado de UN objetivo,
 * qué avisos y recuperaciones corresponden según el estado avisado y los contadores.
 * Requisitos: docs/requisitos/alertas-tipos.md (RT-01 a RT-24). Arquitectura: arquitectura-alertas-tipos.md.
 */

var TYPES = ['down', 'certExpired', 'certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other'];
var NOTIFY_KEYS = ['down', 'recovery', 'certExpired', 'certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other'];
var DEFAULT_NOTIFY = {
  down: true, recovery: true, certExpired: true, certExpiring: false, certTrust: false,
  latency: false, resources: false, disk: false, other: false
};
var DEGRADE_TYPES = ['certExpiring', 'certTrust', 'latency', 'resources', 'disk', 'other'];
var DISK_HYST_PCT = 2;

var MAX_SUB_CHARS = 100;      // recorte del punto de montaje / código antes de codificarlo (RT-11)
var MAX_SUB_ENCODED = 200;    // longitud máxima de la subclave ya codificada (RT-10)
var DEFAULT_DISK_WARN = 85;
var LATENCY_CODES = ['latency', 'loss', 'jitter', 'ttfb'];
var RESOURCE_CODES = ['cpu', 'mem', 'io'];
var LEVEL_TYPES = ['certExpiring', 'disk']; // tipos con nivel warn/crit y escalado (RT-14)

function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/* ---- subclaves y claves ---- */

// Quita caracteres de control, sustituye sustitutos sueltos (rompen encodeURIComponent) y recorta.
function cleanSub(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g, '');
  if (s.length > MAX_SUB_CHARS) s = s.slice(0, MAX_SUB_CHARS);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      var d = s.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { out += s.charAt(i) + s.charAt(i + 1); i++; } else out += '?';
    } else if (c >= 0xDC00 && c <= 0xDFFF) out += '?';
    else out += s.charAt(i);
  }
  return out;
}

// Subclave codificada; si excede el límite se acorta (un carácter puede ocupar hasta 9 caracteres codificados).
function encodeSub(sub) {
  var s = cleanSub(sub), e;
  for (;;) {
    try { e = encodeURIComponent(s); } catch (err) { s = s.slice(0, -1); continue; }
    if (e.length <= MAX_SUB_ENCODED || !s.length) return e.length <= MAX_SUB_ENCODED ? e : '';
    s = s.slice(0, -1);
  }
}

// Subclave canónica: la que sobrevive a codificar y decodificar (recorte a 100 caracteres y a 200 codificados).
function canonSub(sub) {
  var e = encodeSub(sub);
  try { return decodeURIComponent(e); } catch (err) { return ''; }
}

// Clave del mapa persistido: 'id|tipo' o 'id|tipo|subclave codificada'.
function encodeKey(id, type, sub) {
  var e = (sub == null || sub === '') ? '' : encodeSub(sub);
  return String(id) + '|' + type + (e ? '|' + e : '');
}

// -> { id, type, sub } | null. La subclave sale decodificada ('' si no hay).
function parseKey(key) {
  if (typeof key !== 'string') return null;
  var parts = key.split('|');
  if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) return null;
  var sub = '';
  if (parts.length === 3) {
    try { sub = decodeURIComponent(parts[2]); } catch (e) { return null; }
  }
  return { id: parts[0], type: parts[1], sub: sub };
}

// Clave local al objetivo (sin id): 'tipo' o 'tipo|sub codificada'.
function localKey(type, sub) {
  var e = (sub == null || sub === '') ? '' : encodeSub(sub);
  return type + (e ? '|' + e : '');
}
function splitLocal(k) {
  var i = k.indexOf('|');
  if (i < 0) return { type: k, sub: '' };
  var sub = '';
  try { sub = decodeURIComponent(k.slice(i + 1)); } catch (e) { sub = k.slice(i + 1); }
  return { type: k.slice(0, i), sub: sub };
}

/* ---- clasificación (RT-01, RT-02) ---- */

function hit(type, sub, level, family) { return { type: type, sub: sub, level: level, family: family }; }

// -> { type, sub, level:'on'|'warn'|'crit', family } | null. Estática: no depende de las casillas activas.
function classify(reason) {
  if (!isObj(reason)) return null;
  var level = reason.level, code = String(reason.code == null ? '' : reason.code);
  if (level !== 'warn' && level !== 'crit') return null; // 'info' (icmp) y desconocidos no avisan (S6)

  if (code === 'ssl') {
    var s = reason.sub || (reason.down ? 'expired' : 'expiring');
    if (s === 'expired') return hit('certExpired', '', 'on', 'ssl-expired');
    if (s === 'expiring') return hit('certExpiring', '', level, 'ssl');
    return hit('other', 'ssl', 'on', 'ssl-unreadable'); // 'unreadable' u otro: no se pudo leer
  }
  if (reason.down) return hit('down', '', 'on', 'down');
  if (code === 'ssl-trust') return hit('certTrust', '', 'on', 'ssl-trust');
  if (code === 'disk') {
    var m = canonSub(reason.sub);
    return hit('disk', m, level, 'disk|' + m);
  }
  var c = canonSub(code);
  if (LATENCY_CODES.indexOf(code) >= 0) return hit(level === 'crit' ? 'latency' : 'other', c, 'on', c);
  if (RESOURCE_CODES.indexOf(code) >= 0) return hit(level === 'crit' ? 'resources' : 'other', c, 'on', c);
  return hit('other', c, 'on', c);
}

// Familia de una clave persistida (RT-04): permite relacionar la clave con los motivos actuales.
function familyOf(type, sub) {
  if (type === 'down') return 'down';
  if (type === 'certExpired') return 'ssl-expired';
  if (type === 'certExpiring') return 'ssl';
  if (type === 'certTrust') return 'ssl-trust';
  if (type === 'disk') return 'disk|' + sub;
  if (type === 'other' && sub === 'ssl') return 'ssl-unreadable';
  return sub; // latency, resources, other: el code
}

/* ---- medibilidad y fuentes (RT-13, RT-15) ---- */

function sourceOf(family) {
  family = String(family);
  if (family === 'latency' || family === 'loss' || family === 'jitter') return 'ping';
  if (family === 'ttfb') return 'http';
  if (family === 'ssl' || family === 'ssl-expired' || family === 'ssl-unreadable' || family === 'ssl-trust') return 'ssl';
  if (family === 'cpu' || family === 'mem' || family === 'io' || family === 'agent' || family.indexOf('disk|') === 0) return 'agent';
  return 'status';
}

// Con `checksOn` ({ping,http,ssl,agent} según la configuración del objetivo) la fuente «existe» si está
// habilitada, aunque el resultado no la traiga (fallo de DNS, plazo agotado). Sin él, se decide por presencia.
function sourcePresent(src, r, checksOn) {
  r = r || {};
  if (isObj(checksOn) && has(checksOn, src)) return !!checksOn[src];
  if (src === 'ping') return !!r.ping && !r.ping.unavailable;
  if (src === 'http') return !!r.http;
  if (src === 'ssl') return !!r.ssl;
  if (src === 'agent') return !!r.agent;
  return true;
}

function hasReasonCode(r, code) {
  return (r.reasons || []).some(function (x) { return x && x.code === code; });
}

// ¿Se midió la fuente de la familia en este resultado? Si no, no recupera ni cuenta como limpio.
// Resultado en el que ninguna fuente se midió de verdad: fallo de DNS, plazo agotado o sin ping/http/ssl/agente.
function unmeasurableResult(r) {
  if (r.dns && r.dns.error) return true;
  return hasReasonCode(r, 'timeout');
}

// Sin ninguna fuente medida (ni ping, ni http, ni ssl, ni agente): afecta a las familias ligadas a una fuente.
function noSources(r) { return !r.ping && !r.http && !r.ssl && !r.agent; }

function measurable(family, r) {
  r = r || {};
  var src = sourceOf(family);
  if (family !== 'down' && (unmeasurableResult(r) || (src !== 'status' && noSources(r)))) return false;
  if (src === 'ping') return !!r.ping && !r.ping.unavailable && r.ping.received > 0;
  if (src === 'http') return !!r.http && !r.http.error && typeof r.http.ttfbMs === 'number' && !hasReasonCode(r, 'http');
  if (src === 'ssl') return !!r.ssl && !r.ssl.error;
  if (src === 'agent') return !!r.agent && !r.agent.error;
  return r.status !== 'unknown';
}

/* ---- decisión por resultado ---- */

var RANK = { on: 1, warn: 1, crit: 2 };

// Condiciones presentes en el resultado: clave local -> { type, sub, level, family, code, reasons }.
function buildConds(r) {
  var conds = Object.create(null); // sin prototipo: los códigos vienen de fuera
  (r.reasons || []).forEach(function (x) {
    var k = classify(x);
    if (!k) return;
    var key = localKey(k.type, k.sub);
    var c = conds[key];
    if (!c) c = conds[key] = { type: k.type, sub: k.sub, level: k.level, family: k.family, code: String(x.code || ''), reasons: [] };
    else if ((RANK[k.level] || 0) > (RANK[c.level] || 0)) c.level = k.level;
    if (x.text != null) c.reasons.push(String(x.text));
  });
  return conds;
}

function copyMap(m) {
  var o = {};
  Object.keys(m || {}).forEach(function (k) { if (k !== '__proto__') o[k] = m[k]; });
  return o;
}
function copyCounters(m) {
  var o = {};
  Object.keys(m || {}).forEach(function (k) {
    if (k === '__proto__' || !isObj(m[k])) return;
    var c = m[k];
    o[k] = { level: c.level || 'on', count: c.count || 0, crit: c.crit || 0, missing: c.missing || 0 };
  });
  return o;
}

// Disco del agente cuyo montaje (limpio) coincide con la subclave.
// Se compara la clave local canónica (misma función que genera la clave), válido con montajes largos o no ASCII.
function findDisk(r, lkey) {
  var list = (r.agent && r.agent.disks) || [];
  for (var i = 0; i < list.length; i++) if (list[i] && localKey('disk', canonSub(list[i].mount)) === lkey) return list[i];
  return null;
}

function decideTarget(inp) {
  inp = inp || {};
  var r = inp.r || {};
  var n = Math.max(1, Math.min(10, Math.round(inp.n) || 2));
  var th = inp.thresholds || {};
  var checksOn = isObj(inp.checksOn) ? inp.checksOn : null; // fuentes habilitadas del objetivo (RT-13)
  var notify = {};
  NOTIFY_KEYS.forEach(function (k) { notify[k] = isObj(inp.notify) && typeof inp.notify[k] === 'boolean' ? inp.notify[k] : DEFAULT_NOTIFY[k]; });
  var alerted = copyMap(inp.alerted);
  var counters = copyCounters(inp.counters);
  var events = [];
  var ts = r.ts;
  if (r.status === 'unknown') return { alerted: alerted, counters: counters, events: events };

  var conds = buildConds(r);
  // Salvaguarda: estado 'down' sin ningún motivo down:true (ni el de certificado vencido) -> condición 'down' genérica.
  if (r.status === 'down' && !(r.reasons || []).some(function (x) { return x && x.down; })) {
    conds.down = { type: 'down', sub: '', level: 'on', family: 'down', code: 'down', reasons: ['Sin respuesta'] };
  }
  var famPresent = Object.create(null);
  Object.keys(conds).forEach(function (k) { famPresent[conds[k].family] = true; });
  // Mientras el certificado sigue vencido, la clave 'certExpiring' no se recupera: la releva certExpired (RT-04).
  if (conds.certExpired) famPresent.ssl = true;

  // 0. Tipos desactivados: sus claves y contadores se eliminan en silencio (RT-13, RT-17).
  [alerted, counters].forEach(function (m) {
    Object.keys(m).forEach(function (k) {
      var t = splitLocal(k).type;
      if (TYPES.indexOf(t) >= 0 && !notify[t]) delete m[k];
    });
  });

  // 1. Clave 'legacy' heredada de 2.4.0 (RT-23).
  if (has(alerted, 'legacy')) {
    delete alerted.legacy;
    if (r.status === 'up') {
      if (notify.recovery) events.push({ kind: 'recovery', type: 'legacy', sub: '', level: 'on', code: '', reasons: [], ts: ts });
    } else if (r.status === 'degraded') {
      Object.keys(conds).forEach(function (k) { // adopción silenciosa de lo que hay ahora
        var c = conds[k];
        if (notify[c.type] && !has(alerted, k)) alerted[k] = c.level;
      });
    }
  }

  // 2. Clave 'down' migrada de 2.4.0 (nivel 'm'), en su primer resultado no 'unknown' (RT-23).
  if (alerted.down === 'm') {
    var realDown = !!conds.down;
    if (!realDown && conds.certExpired && notify.certExpired && !has(alerted, 'certExpired')) {
      alerted.certExpired = 'on'; // el vencimiento era lo que causaba la caída: transferencia silenciosa
      delete alerted.down; delete counters.down;
    } else alerted.down = 'on'; // sigue caído (sin aviso) o ya no lo está (recuperación normal más abajo)
  }

  function alertEvent(k, c, level) {
    alerted[k] = level;
    events.push({ kind: 'alert', type: c.type, sub: c.sub, level: level, code: c.code, reasons: c.reasons.slice(), ts: ts });
    if (c.type === 'certExpired') { delete alerted.certExpiring; delete counters.certExpiring; } // RT-04
    if (c.type === 'latency' || c.type === 'resources') { // el tipo específico releva a 'other' de la familia
      var ok = localKey('other', c.sub);
      delete alerted[ok]; delete counters[ok];
    }
  }

  // 3. Condiciones presentes: contadores, activación y escalado (RT-14).
  Object.keys(conds).forEach(function (k) {
    var c = conds[k];
    if (!notify[c.type]) return;
    if (c.type === 'other' && (has(alerted, localKey('latency', c.sub)) || has(alerted, localKey('resources', c.sub)))) return; // RT-04
    var ct = counters[k] || (counters[k] = { level: c.level, count: 0, crit: 0, missing: 0 });
    ct.count = Math.min(ct.count + 1, 1000000);
    ct.crit = c.level === 'crit' ? Math.min(ct.crit + 1, 1000000) : 0;
    ct.level = c.level; ct.missing = 0;
    var cur = has(alerted, k) ? alerted[k] : null;
    if (LEVEL_TYPES.indexOf(c.type) < 0) {
      if (!cur && ct.count >= n) alertEvent(k, c, 'on');
    } else if (!cur) {
      if (ct.count >= n) alertEvent(k, c, c.level); // se avisa con el nivel actual, sin aviso warn intermedio (RT-14)
    } else if (cur !== 'crit' && c.level === 'crit' && ct.crit >= n) {
      alertEvent(k, c, 'crit');                      // escalado desde un warn ya avisado
    } else if (cur === 'crit' && c.level === 'warn') {
      alerted[k] = 'warn'; // el nivel bajó: sin aviso (RT-14, RT-18)
    }
  });

  // 4. Claves avisadas sin condición propia: recuperación, conservación o eliminación silenciosa.
  Object.keys(alerted).forEach(function (k) {
    if (has(conds, k)) return;
    var p = splitLocal(k), fam = familyOf(p.type, p.sub);
    if (!sourcePresent(sourceOf(fam), r, checksOn)) { delete alerted[k]; delete counters[k]; return; } // fuente deshabilitada (RT-13)
    if (famPresent[fam]) return;                // la familia sigue presente en otro nivel (RT-04)
    if (!measurable(fam, r)) return;            // no se midió: ni recupera ni cuenta (RT-15, RT-16)
    if (p.type === 'down' && r.status === 'down' && !notify.certExpired) return; // sigue caído (p. ej. solo el certificado con certExpired apagado): no se recupera
    if (p.type === 'disk') {
      var d = findDisk(r, k), ct = counters[k] || (counters[k] = { level: 'on', count: 0, crit: 0, missing: 0 });
      if (!d) { // la partición ya no figura: se olvida en silencio tras N resultados (RT-13)
        ct.missing++;
        if (ct.missing >= n) { delete alerted[k]; delete counters[k]; }
        return;
      }
      ct.missing = 0;
      var warn = typeof th.diskWarnPct === 'number' ? th.diskWarnPct : DEFAULT_DISK_WARN;
      if (typeof d.usedPct === 'number' && d.usedPct >= warn - DISK_HYST_PCT) return; // histéresis (RT-19)
    }
    delete alerted[k]; delete counters[k];
    if (notify.recovery) events.push({ kind: 'recovery', type: p.type, sub: p.sub, level: 'on', code: recoveryCode(p.type, p.sub), reasons: [], ts: ts });
  });

  // 5. Contadores de condiciones que ya no están y cuya fuente sí se midió (o desapareció).
  Object.keys(counters).forEach(function (k) {
    if (has(conds, k) || has(alerted, k)) return;
    var p = splitLocal(k), fam = familyOf(p.type, p.sub);
    if (!sourcePresent(sourceOf(fam), r, checksOn) || measurable(fam, r)) delete counters[k];
  });

  // 6. Relevos silenciosos que quedan (clave 'certExpiring' con 'certExpired', 'other' con su tipo específico).
  if (has(alerted, 'certExpired')) { delete alerted.certExpiring; delete counters.certExpiring; }
  Object.keys(alerted).forEach(function (k) {
    var p = splitLocal(k);
    if (p.type === 'latency' || p.type === 'resources') { var ok = localKey('other', p.sub); delete alerted[ok]; delete counters[ok]; }
  });

  return { alerted: alerted, counters: counters, events: events };
}

function recoveryCode(type, sub) {
  if (type === 'down') return 'down';
  if (type === 'disk') return 'disk';
  if (type === 'certExpired' || type === 'certExpiring') return 'ssl';
  if (type === 'certTrust') return 'ssl-trust';
  return sub || '';
}

module.exports = {
  TYPES: TYPES, NOTIFY_KEYS: NOTIFY_KEYS, DEFAULT_NOTIFY: DEFAULT_NOTIFY, DEGRADE_TYPES: DEGRADE_TYPES,
  DISK_HYST_PCT: DISK_HYST_PCT,
  classify: classify, encodeKey: encodeKey, parseKey: parseKey,
  measurable: measurable, sourceOf: sourceOf, sourcePresent: sourcePresent,
  decideTarget: decideTarget
};
