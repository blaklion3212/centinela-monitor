/*
 * Estadísticas de series de muestras compartidas entre el servidor (require) y el navegador (<script>, NOC.Stats).
 * Módulo UMD sin dependencias. Antes el algoritmo vivía duplicado en js/core/util.js (U.stats) y server/lib/util.js (stats).
 * Criterio único: una muestra es válida solo si es un número finito (null, undefined, NaN e Infinity cuentan como pérdida).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.NOC = root.NOC || {}; root.NOC.Stats = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ¿Muestra válida? Número finito (excluye NaN e Infinity).
  function isSample(v) { return typeof v === 'number' && isFinite(v); }

  // Redondeo único a `d` decimales (1 por defecto).
  function round(v, d) {
    var m = Math.pow(10, d == null ? 1 : d);
    return Math.round(v * m) / m;
  }

  // { sent, received, lossPct, min, avg, max, jitter } de una serie; el jitter es la media de |diferencias| consecutivas válidas.
  function stats(samples) {
    var ok = samples.filter(isSample), sent = samples.length, received = ok.length;
    var out = { sent: sent, received: received, lossPct: sent ? Math.round((sent - received) * 1000 / sent) / 10 : 0,
                min: null, avg: null, max: null, jitter: null };
    if (!received) return out;
    var sum = 0, min = Infinity, max = -Infinity;
    ok.forEach(function (v) { sum += v; if (v < min) min = v; if (v > max) max = v; });
    out.min = round(min, 2); out.max = round(max, 2); out.avg = round(sum / received, 2);
    if (received > 1) {
      var d = 0;
      for (var i = 1; i < received; i++) d += Math.abs(ok[i] - ok[i - 1]);
      out.jitter = round(d / (received - 1), 2);
    } else out.jitter = 0;
    return out;
  }

  return { isSample: isSample, round: round, stats: stats };
});
