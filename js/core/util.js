/* Utilidades generales: escape de HTML, formato de números/tiempos, helpers. */
(function (NOC) {
  'use strict';
  var U = NOC.util = {};

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // Todo texto que venga del usuario (nombres, URLs, etiquetas) pasa por esc() antes de ir a innerHTML.
  U.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); };

  U.clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  U.clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  U.uid = function (p) { return (p || 'id') + '-' + Math.random().toString(36).slice(2, 8); };
  U.isNum = function (v) { return typeof v === 'number' && isFinite(v); };

  U.debounce = function (fn, ms) {
    var t;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  };

  U.isIp = function (s) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || (s.indexOf(':') >= 0 && /^[0-9a-f:]+$/i.test(s));
  };

  U.hostOf = function (t) {
    if (t.kind === 'url') { try { return new URL(t.address).hostname; } catch (e) { return t.address; } }
    return t.address;
  };

  var F = U.fmt = {};
  F.ms = function (v) {
    if (!U.isNum(v)) return '—';
    if (v >= 1000) return (v / 1000).toFixed(2) + ' s';
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ms';
  };
  F.pct = function (v, d) { return U.isNum(v) ? v.toFixed(d == null ? 0 : d) + ' %' : '—'; };
  F.num = function (v, d) { return U.isNum(v) ? v.toFixed(d == null ? 0 : d) : '—'; };
  F.bps = function (v) {
    if (!U.isNum(v)) return '—';
    var u = ['bps', 'Kbps', 'Mbps', 'Gbps'], i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  };
  F.bytes = function (v) {
    if (!U.isNum(v)) return '—';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  };
  F.gb = function (v) { return U.isNum(v) ? (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' GB' : '—'; };
  F.mb = function (v) { return U.isNum(v) ? (v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : Math.round(v) + ' MB') : '—'; };
  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  F.clock = function (ts) { var d = new Date(ts); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };
  F.date = function (ts) {
    var d = new Date(ts);
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear();
  };
  F.dateTime = function (ts) { return F.date(ts) + ' ' + F.clock(ts); };
  F.ago = function (ts) {
    if (!ts) return '—';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'ahora';
    if (s < 60) return 'hace ' + s + ' s';
    if (s < 3600) return 'hace ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h';
    return 'hace ' + Math.floor(s / 86400) + ' d';
  };
  F.dur = function (sec) {
    if (!U.isNum(sec)) return '—';
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d) return d + ' d ' + h + ' h';
    if (h) return h + ' h ' + m + ' min';
    return m + ' min';
  };
  F.plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  // Estadísticas de una serie: lógica única en js/shared/stats.js (NOC.Stats), compartida con el servidor.
  U.stats = function (samples) { return NOC.Stats.stats(samples); };
})(window.NOC = window.NOC || {});
