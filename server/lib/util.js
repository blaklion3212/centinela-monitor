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

// Estadísticas y redondeo: lógica única en js/shared/stats.js, compartida con el navegador (NOC.Stats).
var Stats = require('../../js/shared/stats.js');
var round = Stats.round;
var stats = Stats.stats;

module.exports = { withTimeout: withTimeout, friendlyError: friendlyError, round: round, stats: stats };
