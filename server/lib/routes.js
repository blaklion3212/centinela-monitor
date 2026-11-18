'use strict';
/*
 * Enrutador declarativo de la API. No conoce el estado del servidor: solo compila patrones, busca la primera ruta
 * que coincide y extrae sus parámetros. La tabla de rutas y sus manejadores viven en server/server.js.
 *
 * Una ruta es { method, pattern, access, handler, ... }:
 *   - method: 'GET', 'POST', ... o '*' (cualquier método; se usa como respaldo al final de cada grupo de rutas).
 *   - pattern: ruta exacta con parámetros ':nombre' (p. ej. '/api/orgs/:id').
 *   - params: expresión (texto) permitida para cada parámetro; por defecto '[^/]+'.
 * Gana la PRIMERA ruta de la tabla que coincide en método y patrón, así que el orden de la tabla importa.
 */

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Compila 'ruta/:id' en { re, names }. Los tramos literales se escapan; cada parámetro es un grupo de captura.
function compile(pattern, params) {
  var names = [];
  var src = pattern.split(/(:[A-Za-z_][A-Za-z0-9_]*)/).map(function (part) {
    if (part.charAt(0) !== ':') return escapeRe(part);
    var name = part.slice(1);
    names.push(name);
    return '(' + ((params && params[name]) || '[^/]+') + ')';
  }).join('');
  return { re: new RegExp('^' + src + '$'), names: names };
}

// Devuelve una función match(method, pathname) -> { route, params } | null para la tabla dada.
function createRouter(table) {
  var compiled = table.map(function (route) {
    var c = compile(route.pattern, route.params);
    return { route: route, re: c.re, names: c.names };
  });
  return {
    match: function (method, pathname) {
      for (var i = 0; i < compiled.length; i++) {
        var c = compiled[i];
        if (c.route.method !== '*' && c.route.method !== method) continue;
        var m = c.re.exec(pathname);
        if (!m) continue;
        var params = {};
        c.names.forEach(function (n, j) { params[n] = m[j + 1]; });
        return { route: c.route, params: params };
      }
      return null;
    }
  };
}

module.exports = { createRouter: createRouter, compile: compile };
