'use strict';

function withTimeout(promise, ms, label) {
  var timer;
  var guard = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(Object.assign(new Error(label || 'timeout'), { code: 'ETIMEOUT' })); }, ms);
  });
  return Promise.race([promise, guard]).finally(function () { clearTimeout(timer); });
}

// Traduce errores de red de Node a mensajes legibles para el panel.
function friendlyError(e) {
  if (!e) return 'error desconocido';
  var c = e.code || '';
  var map = {
    ECONNREFUSED: 'conexión rechazada',
    ETIMEDOUT: 'tiempo agotado',
    ETIMEOUT: 'tiempo agotado',
    ECONNRESET: 'conexión reiniciada',
    ENOTFOUND: 'nombre no encontrado',
    EAI_AGAIN: 'DNS no responde',
    ENODATA: 'sin registros DNS',
    ESERVFAIL: 'fallo del servidor DNS',
    EHOSTUNREACH: 'host inalcanzable',
    ENETUNREACH: 'red inalcanzable',
    EPIPE: 'conexión cerrada',
    CERT_HAS_EXPIRED: 'certificado vencido'
  };
  if (map[c]) return map[c];
  if (/timeout|timed out/i.test(e.message || '')) return 'tiempo agotado';
  return String(e.message || c || 'error').slice(0, 120);
}

function round(v, d) {
  var m = Math.pow(10, d == null ? 1 : d);
  return Math.round(v * m) / m;
}

function stats(samples) {
  var ok = samples.filter(function (v) { return typeof v === 'number'; });
  var sent = samples.length, received = ok.length;
  var out = { sent: sent, received: received, lossPct: sent ? round((sent - received) / sent * 100, 1) : 0,
              min: null, avg: null, max: null, jitter: null };
  if (!received) return out;
  var sum = 0, min = Infinity, max = -Infinity;
  ok.forEach(function (v) { sum += v; if (v < min) min = v; if (v > max) max = v; });
  out.min = round(min, 2); out.max = round(max, 2); out.avg = round(sum / received, 2);
  if (received > 1) {
    var d = 0;
    for (var i = 1; i < ok.length; i++) d += Math.abs(ok[i] - ok[i - 1]);
    out.jitter = round(d / (ok.length - 1), 2);
  } else out.jitter = 0;
  return out;
}

module.exports = { withTimeout: withTimeout, friendlyError: friendlyError, round: round, stats: stats };
