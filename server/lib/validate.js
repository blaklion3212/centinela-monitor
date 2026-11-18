'use strict';
/*
 * Validación y normalización de todo lo que llega por la API.
 * Los hosts se validan de forma estricta porque terminan como argumento de ping/traceroute
 * (siempre con execFile, sin shell, y nunca pueden empezar con "-").
 */
var net = require('net');
var crypto = require('crypto');
var Defaults = require('../../js/config/defaults.js');
var Thresholds = require('../../js/shared/thresholds.js'); // reglas de umbrales compartidas con el navegador

var HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
// El primer carácter debe ser alfanumérico: así un nombre nunca se interpreta como opción (-H...) del comando.
var SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,63}$/;
var STATUS_SPEC_RE = /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/;

function isValidHost(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 253 && h[0] !== '-' &&
         (net.isIP(h) !== 0 || HOST_RE.test(h));
}

function newId() { return 't_' + crypto.randomBytes(5).toString('hex'); }

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function bool(v, d) { return typeof v === 'boolean' ? v : d; }
function int(v, min, max, d) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}
function list(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/[,;\n]/);
  return [];
}

// Dirección normalizada para comparar destinos (minúsculas, sin espacios, punto o barra finales).
function normAddress(a) { return String(a == null ? '' : a).trim().toLowerCase().replace(/[.\/]+$/, ''); }

function hostFromAddress(kind, address) {
  if (kind === 'url') { try { return new URL(address).hostname.replace(/^\[|\]$/g, ''); } catch (e) { return null; } }
  return address;
}

/* Devuelve { value, errors[] }. "existing" permite conservar el token del agente si no se reenvía. */
function sanitizeTarget(input, existing, settings) {
  var errors = [];
  input = input && typeof input === 'object' ? input : {};
  var intervalDefault = (settings && settings.intervalSec) || Defaults.SETTINGS.intervalSec;

  var name = str(input.name, 80);
  if (!name) errors.push('El nombre es obligatorio.');

  var kind = input.kind === 'url' ? 'url' : 'host';
  var address = str(input.address, 2048);
  if (!address) errors.push('La dirección es obligatoria.');
  else if (kind === 'url') {
    try {
      var u = new URL(address);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push('La URL debe empezar con http:// o https://');
      else if (!isValidHost(u.hostname.replace(/^\[|\]$/g, ''))) errors.push('El host de la URL no es válido.');
    } catch (e) { errors.push('La URL no es válida (ejemplo: https://sitio.com/ruta).'); }
  } else if (!isValidHost(address)) {
    errors.push('Escribe una IP o un nombre de host válido (sin http:// ni espacios).');
  }

  var tags = [];
  list(input.tags).forEach(function (t) {
    t = str(t, 24);
    if (t && tags.indexOf(t) < 0 && tags.length < 10) tags.push(t);
  });

  var ports = [];
  list(input.checks && input.checks.ports).forEach(function (p) {
    var n = parseInt(p, 10);
    if (n >= 1 && n <= 65535 && ports.indexOf(n) < 0 && ports.length < 20) ports.push(n);
  });

  var c = (input.checks && typeof input.checks === 'object') ? input.checks : {};
  var httpCfg = null;
  if (kind === 'url') {
    var h = c.http && typeof c.http === 'object' ? c.http : {};
    var spec = str(h.expectedStatus, 40) || '200-399';
    if (!STATUS_SPEC_RE.test(spec)) { errors.push('Códigos HTTP esperados no válidos (ejemplo: 200-399,401).'); spec = '200-399'; }
    httpCfg = {
      expectedStatus: spec.replace(/\s+/g, ''),
      timeoutMs: int(h.timeoutMs, 1000, 30000, 8000),
      method: h.method === 'HEAD' ? 'HEAD' : 'GET',
      keyword: str(h.keyword, 100),
      browser: bool(h.browser, false)
    };
  }

  var ag = c.agent && typeof c.agent === 'object' ? c.agent : {};
  var prevAgent = existing && existing.checks && existing.checks.agent;
  var services = [];
  list(ag.services).forEach(function (s) {
    s = str(s, 64);
    if (!s) return;
    if (!SERVICE_RE.test(s)) errors.push('Nombre de servicio no válido: ' + s.slice(0, 20));
    else if (services.indexOf(s) < 0 && services.length < 20) services.push(s);
  });
  var token = typeof ag.token === 'string' ? ag.token.slice(0, 200) : '';
  var tls = bool(ag.tls, false);
  // Huella SHA-256 del certificado del agente: 64 hex con o sin ':'; se guarda como 'AA:BB:...'. Vacío = sin fijar.
  var fingerprint = '';
  var fpRaw = typeof ag.fingerprint === 'string' ? ag.fingerprint.trim() : '';
  if (fpRaw) {
    var fpHex = fpRaw.replace(/:/g, '');
    if (/^[0-9a-fA-F]{64}$/.test(fpHex) && (fpRaw.indexOf(':') < 0 || /^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/.test(fpRaw))) {
      fingerprint = fpHex.toUpperCase().replace(/(..)(?!$)/g, '$1:');
    } else errors.push('Huella TLS no válida (64 caracteres hexadecimales)');
  }
  // Sin TLS la huella no tiene sentido: se vacía. Con TLS es obligatoria (el token solo viaja a un certificado fijado).
  if (!tls) fingerprint = '';
  else if (!fpRaw) errors.push('Con TLS activado, la huella SHA-256 del certificado del agente es obligatoria');
  if (!token && !ag.clearToken && prevAgent) {
    // El token queda atado al destino: si cambió la dirección o el puerto del agente, no se hereda
    // (evita que un cambio de address envíe el secreto anterior a otro servidor).
    var sameDest = normAddress(existing.address) === normAddress(address) &&
                   int(prevAgent.port, 1, 65535, 9100) === int(ag.port, 1, 65535, 9100);
    // Tampoco se hereda si se desactiva TLS (true -> false): el token pasaría a viajar en claro.
    var tlsDowngrade = prevAgent.tls === true && !tls;
    // Ni si cambia la huella fijada (distinta o quitada): el secreto no debe ir a otro certificado.
    var prevFp = String(prevAgent.fingerprint || '').replace(/:/g, '').toUpperCase();
    var sameFp = prevFp === fingerprint.replace(/:/g, '').toUpperCase();
    if (sameDest && !tlsDowngrade && sameFp) token = prevAgent.token || '';
  }

  var isHttps = kind === 'url' && /^https:/i.test(address);
  var value = {
    id: (existing && existing.id) || (/^[A-Za-z0-9_-]{1,64}$/.test(String(input.id || '')) ? String(input.id) : newId()),
    name: name,
    kind: kind,
    address: address,
    group: str(input.group, 40),
    tags: tags,
    intervalSec: int(input.intervalSec, 2, 3600, intervalDefault),
    enabled: bool(input.enabled, true),
    checks: {
      ping: bool(c.ping, true),
      ports: ports,
      http: httpCfg,
      ssl: kind === 'url' ? (isHttps && bool(c.ssl, true)) : bool(c.ssl, false),
      agent: {
        enabled: bool(ag.enabled, false),
        port: int(ag.port, 1, 65535, 9100),
        token: token,
        tls: tls,
        fingerprint: fingerprint,
        services: services
      }
    }
  };
  return { value: value, errors: errors };
}

// Lo que se envía al navegador: nunca el token del agente.
function publicTarget(t) {
  var copy = JSON.parse(JSON.stringify(t));
  if (copy.checks && copy.checks.agent) {
    copy.checks.agent.hasToken = !!copy.checks.agent.token;
    copy.checks.agent.token = '';
    copy.checks.agent.tls = copy.checks.agent.tls === true;
    copy.checks.agent.fingerprint = typeof copy.checks.agent.fingerprint === 'string' ? copy.checks.agent.fingerprint : '';
  }
  return copy;
}

// Número válido de un valor de formulario; vacío, null, booleano o texto no numérico => null (se conserva el previo).
function numOrNull(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { var n = Number(v); return isFinite(n) ? n : null; }
  return null;
}

var isPositiveWarn = Thresholds.isPositiveWarn;

// Sustituye por el valor por defecto todo aviso Ms/Pct guardado como 0, negativo o no numérico.
function fixZeroWarns(th, d) {
  Object.keys(d.thresholds).forEach(function (k) {
    if (isPositiveWarn(k) && !(typeof th[k] === 'number' && isFinite(th[k]) && th[k] > 0)) th[k] = d.thresholds[k];
  });
}

function sanitizeSettings(input, current) {
  var d = Defaults.SETTINGS, out = JSON.parse(JSON.stringify(current || d));
  input = input && typeof input === 'object' ? input : {};
  var iv = numOrNull(input.intervalSec), hp = numOrNull(input.historyPoints);
  if (iv != null) out.intervalSec = int(iv, 2, 3600, out.intervalSec);
  if (hp != null) out.historyPoints = int(hp, 30, 2000, out.historyPoints);
  if (input.theme === 'light' || input.theme === 'dark') out.theme = input.theme;
  if (input.thresholds && typeof input.thresholds === 'object') {
    if (!out.thresholds || typeof out.thresholds !== 'object') out.thresholds = JSON.parse(JSON.stringify(d.thresholds));
    var next = {};
    Object.keys(d.thresholds).forEach(function (k) {
      var n = numOrNull(input.thresholds[k]);
      next[k] = (n != null && n >= 0 && n <= 1e6) ? n : null;
      if (next[k] === 0 && isPositiveWarn(k)) next[k] = d.thresholds[k]; // aviso en 0: se usa el valor por defecto
    });
    Object.keys(d.thresholds).forEach(function (k) {
      if (next[k] != null) out.thresholds[k] = next[k]; // se asigna y luego se revisa el orden por métrica
    });
    fixZeroWarns(out.thresholds, d); // repara también valores guardados con ceros
    // Orden por métrica: aviso < crítico (en SSL, por días restantes, aviso > crítico). Si no cumple, se conservan los previos.
    Thresholds.PAIRS.forEach(function (p) {
      if (Thresholds.isOrdered(p, out.thresholds[p.warn], out.thresholds[p.crit])) return;
      var base = current && current.thresholds ? current.thresholds : d.thresholds;
      out.thresholds[p.warn] = base[p.warn];
      out.thresholds[p.crit] = base[p.crit];
    });
    fixZeroWarns(out.thresholds, d); // por si los previos usados como respaldo tenían ceros
  }
  return out;
}

// Etiquetas en español (las mismas que ve el usuario en Ajustes) para los mensajes de error.
var SETTING_LABELS = { intervalSec: 'Intervalo por defecto (s)', historyPoints: 'Puntos de historial' };
var thresholdLabel = Thresholds.thresholdLabel;

// Problemas del cuerpo recibido en ajustes (mensajes en español); vacío si todo está bien.
// sanitizeSettings sigue siendo tolerante: esto sirve para que la API responda 400 con detalle.
function settingsErrors(body, prev) {
  var d = Defaults.SETTINGS, errors = [];
  body = body && typeof body === 'object' ? body : {};
  function given(v) { return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === ''); }
  ['intervalSec', 'historyPoints'].forEach(function (k) {
    if (given(body[k]) && numOrNull(body[k]) == null) errors.push('El valor de "' + (SETTING_LABELS[k] || k) + '" no es numérico.');
  });
  var bt = body.thresholds && typeof body.thresholds === 'object' ? body.thresholds : null;
  if (!bt) return errors;
  var base = prev && prev.thresholds ? prev.thresholds : d.thresholds, eff = {};
  Object.keys(d.thresholds).forEach(function (k) {
    var v = bt[k], n = numOrNull(v);
    eff[k] = typeof base[k] === 'number' ? base[k] : d.thresholds[k];
    if (!given(v)) return;
    if (n == null) { errors.push('El umbral "' + thresholdLabel(k) + '" no es numérico.'); return; }
    if (n < 0 || n > 1e6) { errors.push('El umbral "' + thresholdLabel(k) + '" está fuera de rango (0 a 1000000).'); return; }
    if (n === 0 && isPositiveWarn(k)) { errors.push('El umbral "' + thresholdLabel(k) + '" debe ser mayor que 0.'); return; }
    eff[k] = n;
  });
  Thresholds.PAIRS.forEach(function (p) {
    var w = eff[p.warn], c = eff[p.crit];
    if (!Thresholds.isOrdered(p, w, c)) errors.push(Thresholds.orderMessage(p, w, c));
  });
  return errors;
}

module.exports = { isValidHost: isValidHost, hostFromAddress: hostFromAddress, sanitizeTarget: sanitizeTarget,
                   publicTarget: publicTarget, sanitizeSettings: sanitizeSettings, settingsErrors: settingsErrors, newId: newId };
