/*
 * Registro de widgets. Cada archivo de js/widgets/*.js llama a NOC.widgets.register({...}).
 *   type, title, icon, desc  → identidad y texto de la galería "Agregar ventana"
 *   target: 'none' | 'optional' | 'required'  → si la ventana trabaja sobre un objetivo
 *   accepts(t)   → qué objetivos son compatibles (p. ej. solo URLs)
 *   w, h, minW, minH → tamaño inicial / mínimo en celdas
 *   init(ctx)    → una vez (eventos); render(ctx) → cada actualización; destroy(ctx)
 */
(function (NOC) {
  'use strict';
  var defs = {}, order = [];
  NOC.widgets = {
    register: function (d) { defs[d.type] = Object.assign({ target: 'none', w: 4, h: 8, minW: 2, minH: 3 }, d); order.push(d.type); },
    get: function (t) { return defs[t] || null; },
    list: function () { return order.map(function (t) { return defs[t]; }); }
  };
})(window.NOC = window.NOC || {});
