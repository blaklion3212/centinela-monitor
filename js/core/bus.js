/* Bus de eventos mínimo: data, targets, settings, focus, mode, conn, view. */
(function (NOC) {
  'use strict';
  var handlers = {};
  NOC.bus = {
    on: function (name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
      return function () { NOC.bus.off(name, fn); };
    },
    off: function (name, fn) {
      handlers[name] = (handlers[name] || []).filter(function (f) { return f !== fn; });
    },
    emit: function (name, payload) {
      (handlers[name] || []).slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error('[bus:' + name + ']', e); }
      });
    }
  };
})(window.NOC = window.NOC || {});
