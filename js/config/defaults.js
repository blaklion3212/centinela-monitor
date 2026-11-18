/*
 * Configuración por defecto (compartida entre servidor y navegador).
 * Los valores reales se guardan en data/settings.json; esto solo es el punto de partida.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.NOC = root.NOC || {}; root.NOC.Defaults = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SETTINGS = {
    intervalSec: 10,          // intervalo por defecto entre verificaciones
    historyPoints: 360,       // puntos de historial que se conservan por objetivo
    theme: 'dark',
    thresholds: {
      latencyWarnMs: 150,  latencyCritMs: 400,
      lossWarnPct: 2,      lossCritPct: 20,
      jitterWarnMs: 30,    jitterCritMs: 80,
      ttfbWarnMs: 800,     ttfbCritMs: 2500,
      sslWarnDays: 30,     sslCritDays: 7,
      diskWarnPct: 85,     diskCritPct: 90,
      cpuWarnPct: 85,      cpuCritPct: 95,
      memWarnPct: 85,      memCritPct: 95,
      ioWaitWarnPct: 20,   ioWaitCritPct: 40
    }
  };

  /*
   * Distribución inicial del dashboard (rejilla de 12 columnas).
   * type = identificador del widget registrado en js/widgets/*.js
   * config.targetId vacío = el widget elige automáticamente un objetivo compatible.
   */
  var LAYOUT = {
    version: 1,
    locked: false,
    widgets: [
      { id: 'w-overview',  type: 'overview',     x: 0, y: 0,  w: 12, h: 5,  config: {} },
      { id: 'w-board',     type: 'status-board', x: 0, y: 5,  w: 8,  h: 10, config: {} },
      { id: 'w-events',    type: 'events',       x: 8, y: 5,  w: 4,  h: 10, config: {} },
      { id: 'w-ping',      type: 'ping-plotter', x: 0, y: 15, w: 8,  h: 11, config: {} },
      { id: 'w-trace',     type: 'traceroute',   x: 8, y: 15, w: 4,  h: 11, config: {} },
      { id: 'w-nettable',  type: 'net-table',    x: 0, y: 26, w: 12, h: 8,  config: {} },
      { id: 'w-http',      type: 'http-monitor', x: 0, y: 34, w: 7,  h: 8,  config: {} },
      { id: 'w-ssl',       type: 'ssl-expiry',   x: 7, y: 34, w: 5,  h: 8,  config: {} },
      { id: 'w-ports',     type: 'ports',        x: 0, y: 42, w: 6,  h: 8,  config: {} },
      { id: 'w-jitter',    type: 'jitter',       x: 6, y: 42, w: 6,  h: 8,  config: {} },
      { id: 'w-cpu',       type: 'cpu-ram',      x: 0, y: 50, w: 6,  h: 9,  config: {} },
      { id: 'w-disk',      type: 'disk',         x: 6, y: 50, w: 6,  h: 9,  config: {} },
      { id: 'w-bw',        type: 'bandwidth',    x: 0, y: 59, w: 6,  h: 8,  config: {} },
      { id: 'w-svc',       type: 'services',     x: 6, y: 59, w: 6,  h: 8,  config: {} }
    ]
  };

  return { SETTINGS: SETTINGS, LAYOUT: LAYOUT, GRID_COLS: 12 };
});
