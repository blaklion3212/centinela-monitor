/*
 * Huella SHA-256 del certificado TLS del agente, compartida entre el servidor (require) y el navegador (<script>, NOC.Fingerprint).
 * Módulo UMD sin dependencias, funciones puras. Antes duplicado en server/lib/validate.js y js/views/targets.js.
 * Formato válido: 64 hexadecimales, sin separadores o con ':' entre cada par (AA:BB:...:FF). Forma canónica: 'AA:BB:...'.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.NOC = root.NOC || {}; root.NOC.Fingerprint = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PLAIN_RE = /^[0-9a-fA-F]{64}$/;
  var COLON_RE = /^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/;

  function str(s) { return typeof s === 'string' ? s.trim() : ''; }

  // ¿Es una huella bien formada? (64 hex, con ':' solo entre pares completos). La cadena vacía no es válida.
  function isValid(s) {
    var t = str(s);
    return PLAIN_RE.test(t) || COLON_RE.test(t);
  }

  // Forma canónica 'AA:BB:...:FF'; '' si está vacía o no es válida.
  function normalize(s) {
    var t = str(s);
    if (!isValid(t)) return '';
    return t.replace(/:/g, '').toUpperCase().replace(/(..)(?!$)/g, '$1:');
  }

  // Clave de comparación tolerante (sin ':' ni espacios extremos, en mayúsculas); sirve también con texto a medio escribir.
  function key(s) { return str(s).replace(/:/g, '').toUpperCase(); }

  // ¿Misma huella? Compara sin ':' y sin distinguir mayúsculas; dos vacías son iguales.
  function same(a, b) { return key(a) === key(b); }

  return { isValid: isValid, normalize: normalize, same: same };
});
