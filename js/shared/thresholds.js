/*
 * Reglas de umbrales de alerta compartidas entre el servidor (require) y el navegador (<script>, NOC.Thresholds).
 * Módulo UMD sin dependencias. Aquí vive lo que antes se duplicaba entre server/lib/validate.js y js/views/settings.js:
 * la lista de pares aviso/crítico, su orden (aviso < crítico; en SSL, por días restantes, al revés) y las etiquetas en español.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.NOC = root.NOC || {}; root.NOC.Thresholds = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pares aviso/crítico en el orden en que se validan y se muestran. `inverted`: menos días restantes es peor.
  var PAIRS = [
    { id: 'latency', label: 'Latencia',            warn: 'latencyWarnMs', crit: 'latencyCritMs', inverted: false },
    { id: 'loss',    label: 'Pérdida de paquetes', warn: 'lossWarnPct',   crit: 'lossCritPct',   inverted: false },
    { id: 'jitter',  label: 'Jitter',              warn: 'jitterWarnMs',  crit: 'jitterCritMs',  inverted: false },
    { id: 'ttfb',    label: 'TTFB HTTP',           warn: 'ttfbWarnMs',    crit: 'ttfbCritMs',    inverted: false },
    { id: 'ssl',     label: 'SSL: días restantes', warn: 'sslWarnDays',   crit: 'sslCritDays',   inverted: true },
    { id: 'disk',    label: 'Disco usado',         warn: 'diskWarnPct',   crit: 'diskCritPct',   inverted: false },
    { id: 'cpu',     label: 'CPU',                 warn: 'cpuWarnPct',    crit: 'cpuCritPct',    inverted: false },
    { id: 'mem',     label: 'Memoria RAM',         warn: 'memWarnPct',    crit: 'memCritPct',    inverted: false },
    { id: 'ioWait',  label: 'I/O wait',            warn: 'ioWaitWarnPct', crit: 'ioWaitCritPct', inverted: false }
  ];
  // Sin prototipo: claves como "constructor" o "toString" no deben resolverse a funciones heredadas.
  var BY_ID = Object.create(null);
  PAIRS.forEach(function (p) { BY_ID[p.id] = p; });

  // Los avisos de métricas en Ms y Pct deben ser > 0 (un aviso en 0 dispara alertas permanentes).
  function isPositiveWarn(k) { return /Warn(Ms|Pct)$/.test(k); }

  // ¿El par respeta el orden? Aviso menor que crítico; en SSL (inverted), mayor.
  function isOrdered(pair, warn, crit) { return pair.inverted ? warn > crit : warn < crit; }

  // 'lossWarnPct' -> 'Pérdida de paquetes (aviso)'; 'sslCritDays' -> 'SSL: días restantes (crítico)'.
  function thresholdLabel(k) {
    var m = /^(.*)(Warn|Crit)(Ms|Pct|Days)$/.exec(k);
    if (!m || !BY_ID[m[1]]) return k;
    return BY_ID[m[1]].label + ' (' + (m[2] === 'Warn' ? 'aviso' : 'crítico') + ')';
  }

  // Mensaje en español (el que devuelve la API) cuando un par no respeta el orden.
  function orderMessage(pair, warn, crit) {
    return pair.inverted
      ? 'En "' + pair.label + '" el aviso (' + warn + ') debe ser mayor que el crítico (' + crit + '): se avisa con más días de margen.'
      : 'En "' + pair.label + '" el aviso (' + warn + ') debe ser menor que el crítico (' + crit + ').';
  }

  return { PAIRS: PAIRS, byId: function (id) { return BY_ID[id] || null; }, isPositiveWarn: isPositiveWarn,
           isOrdered: isOrdered, thresholdLabel: thresholdLabel, orderMessage: orderMessage };
});
