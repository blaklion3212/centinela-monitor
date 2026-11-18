'use strict';
/*
 * Enrutador declarativo de la API. No conoce el estado del servidor: solo compila patrones, busca la primera ruta
 * que coincide y extrae sus parámetros. La tabla de rutas y sus manejadores viven en server/server.js.
 *
 * Una ruta es { method, pattern, access, handler, ... }:
 *   - method: 'GET', 'POST', ... Cada combinación método + patrón se declara explícitamente; el comodín '*' se rechaza.
 *   - noHead: true en una ruta GET que no debe atenderse con HEAD (p. ej. un flujo SSE que quedaría abierto sin cuerpo).
 * HEAD se trata como GET: si el patrón declara GET (sin noHead), HEAD coincide con esa ruta y `allowed` lo lista
 * justo después de GET. Node descarta el cuerpo de la respuesta a HEAD, así que los manejadores no cambian.
 * Dos rutas con el mismo patrón deben declarar el mismo `access`; si no, createRouter lanza un error.
 *   - pattern: ruta exacta con parámetros ':nombre' (p. ej. '/api/orgs/:id').
 *   - params: expresión (texto) permitida para cada parámetro; por defecto '[^/]+'.
 * Gana la PRIMERA ruta de la tabla que coincide en método y patrón, así que el orden de la tabla importa; para HEAD,
 * una ruta HEAD declarada gana siempre sobre el GET equivalente.
 * Si el patrón existe pero con otro método, `allowed` informa de los métodos declarados (para responder 405 + Allow).
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
  var accessOf = {};
  table.forEach(function (route) {
    if (route.method === '*') throw new Error('Ruta "' + route.pattern + '": el método "*" no está permitido; declara cada método');
    if (Object.prototype.hasOwnProperty.call(accessOf, route.pattern) && accessOf[route.pattern] !== route.access) {
      throw new Error('Ruta "' + route.pattern + '": declarada con distinto access ("' + accessOf[route.pattern] + '" y "' + route.access + '")');
    }
    accessOf[route.pattern] = route.access;
  });
  var compiled = table.map(function (route) {
    var c = compile(route.pattern, route.params);
    return { route: route, re: c.re, names: c.names };
  });
  // Primera ruta de la tabla que cumple `ok` y cuyo patrón coincide con la ruta pedida: { route, params } | null.
  function find(ok, pathname) {
    for (var i = 0; i < compiled.length; i++) {
      var c = compiled[i];
      if (!ok(c.route)) continue;
      var m = c.re.exec(pathname);
      if (!m) continue;
      var params = {};
      c.names.forEach(function (n, j) { params[n] = m[j + 1]; });
      return { route: c.route, params: params };
    }
    return null;
  }
  return {
    match: function (method, pathname) {
      // Primero, una ruta declarada con el método exacto (una HEAD explícita gana sobre el GET, esté donde esté).
      var hit = find(function (r) { return r.method === method; }, pathname);
      // Si no hay, HEAD se atiende con la ruta GET equivalente (salvo noHead).
      if (!hit && method === 'HEAD') hit = find(function (r) { return r.method === 'GET' && !r.noHead; }, pathname);
      return hit;
    },
    // Métodos declarados para la ruta (sin repetir, en orden de la tabla) y la primera ruta del patrón (para su
    // `access`): { methods: [...], route } o null si ningún patrón coincide con la ruta, sea cual sea el método.
    allowed: function (pathname) {
      var methods = [], first = null;
      for (var i = 0; i < compiled.length; i++) {
        var c = compiled[i];
        if (!c.re.test(pathname)) continue;
        if (!first) first = c.route;
        if (methods.indexOf(c.route.method) < 0) methods.push(c.route.method);
        // HEAD aparece justo después de GET, salvo que la ruta lo excluya o esté declarado aparte.
        if (c.route.method === 'GET' && !c.route.noHead && methods.indexOf('HEAD') < 0) methods.push('HEAD');
      }
      return first ? { methods: methods, route: first } : null;
    }
  };
}

module.exports = { createRouter: createRouter, compile: compile };
