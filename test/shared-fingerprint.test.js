'use strict';
/*
 * js/shared/fingerprint.js (NOC.Fingerprint: isValid, normalize, same) y su coherencia con server/lib/validate.js
 * (sanitizeTarget usa el mismo módulo). Carga dual: require y vm.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var F = require('../js/shared/fingerprint.js');
var validate = require('../server/lib/validate.js');

var HEX = '0123456789abcdefABCDEF';
function par(c) { return c + c; }
var PLANA = new Array(33).join('ab');                  // 64 hex
var CON = new Array(33).join('ab:').slice(0, -1);      // 'ab:ab:...:ab'
var CANON = new Array(33).join('AB:').slice(0, -1);

test('FP-01 válidas: 64 hex sin separadores o con ":" entre pares, en cualquier combinación de mayúsculas', function () {
  assert.strictEqual(PLANA.length, 64);
  assert.strictEqual(CON.length, 95);
  [PLANA, PLANA.toUpperCase(), CON, CANON, 'aB'.repeat(32)].forEach(function (s) { assert.strictEqual(F.isValid(s), true, s); });
});

test('FP-02 normalize: forma canónica AA:BB:...:FF en mayúsculas desde cualquier formato válido', function () {
  assert.strictEqual(F.normalize(PLANA), CANON);
  assert.strictEqual(F.normalize(CON), CANON);
  assert.strictEqual(F.normalize(CANON), CANON);
  assert.strictEqual(F.normalize('  ' + PLANA + '\n'), CANON, 'recorta espacios');
});

test('FP-03 trim: los espacios extremos se toleran; los internos no', function () {
  assert.strictEqual(F.isValid('  ' + CON + '  '), true);
  assert.strictEqual(F.isValid('\t' + PLANA + '\r\n'), true);
  assert.strictEqual(F.isValid(PLANA.slice(0, 10) + ' ' + PLANA.slice(10, 63)), false);
  assert.strictEqual(F.isValid(CON.replace(/:/, ': ')), false);
});

test('FP-04 ":" desalineados, mixtos o con otros separadores se rechazan', function () {
  assert.strictEqual(F.isValid('a' + CON.slice(0, 94)), false, 'dos puntos corridos un carácter');
  assert.strictEqual(F.isValid(CON.replace(/:/, '')), false, 'falta un ":" entre pares');
  assert.strictEqual(F.isValid(PLANA.slice(0, 2) + ':' + PLANA.slice(2)), false, 'mezcla plana y con ":"');
  assert.strictEqual(F.isValid(CON.replace(/:/g, '-')), false);
  assert.strictEqual(F.isValid(CON + ':'), false, ':' + ' final');
  assert.strictEqual(F.isValid(':' + CON), false);
  assert.strictEqual(F.isValid(CON.replace(/:/, '::')), false);
  assert.strictEqual(F.normalize(CON.replace(/:/, '')), '');
});

test('FP-05 longitud errónea o no hexadecimal: inválida', function () {
  assert.strictEqual(F.isValid(PLANA.slice(1)), false, '63');
  assert.strictEqual(F.isValid(PLANA + 'a'), false, '65');
  assert.strictEqual(F.isValid(PLANA.slice(0, 63) + 'g'), false);
  assert.strictEqual(F.isValid('zz' + CON.slice(2)), false);
  assert.strictEqual(F.isValid(CON.split(':').slice(1).join(':')), false, '31 pares');
});

test('FP-06 vacíos y no string: inválidos; normalize devuelve cadena vacía', function () {
  ['', '   ', '\n', null, undefined, 0, 64, {}, [], [PLANA], true, NaN].forEach(function (v) {
    assert.strictEqual(F.isValid(v), false, String(v));
    assert.strictEqual(F.normalize(v), '', String(v));
  });
});

test('FP-07 same: ignora ":", mayúsculas y espacios extremos', function () {
  assert.strictEqual(F.same(PLANA, CANON), true);
  assert.strictEqual(F.same(CON, ' ' + CANON + ' '), true);
  assert.strictEqual(F.same(PLANA, PLANA.replace(/a/g, 'c')), false);
});

test('FP-08 same: dos vacías (o no string) son iguales; vacía vs. huella no', function () {
  assert.strictEqual(F.same('', ''), true);
  assert.strictEqual(F.same(null, undefined), true);
  assert.strictEqual(F.same('', PLANA), false);
  assert.strictEqual(F.same(undefined, CANON), false);
});

test('FP-09 same sirve con texto a medio escribir (comparación tolerante, sin validar)', function () {
  assert.strictEqual(F.same('AB:C', 'abc'), true);
  assert.strictEqual(F.same('ab:cd', 'abce'), false);
});

test('FP-10 carga como navegador (vm sin module): window.NOC.Fingerprint conserva NOC previo', function () {
  var ctx = { console: console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('var NOC = { previo: 1 };', ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'shared', 'fingerprint.js'), 'utf8'), ctx, { filename: 'fingerprint.js' });
  assert.strictEqual(ctx.NOC.previo, 1);
  assert.strictEqual(ctx.NOC.Fingerprint.isValid(CON), true);
  assert.strictEqual(ctx.NOC.Fingerprint.normalize(PLANA), CANON);
  assert.strictEqual(ctx.NOC.Fingerprint.same(PLANA, CON), true);
});

// Generador determinista para que cualquier fallo sea reproducible.
function lcg(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function hex(rnd, n) { var o = ''; for (var i = 0; i < n; i++) o += HEX.charAt(Math.floor(rnd() * HEX.length)); return o; }

// Pasa la huella por sanitizeTarget (agente con TLS) y devuelve { fp: huella guardada, invalida: ¿error de huella no válida? }.
function veredictoServidor(fp) {
  var r = validate.sanitizeTarget({ name: 'srv', address: '10.0.0.1', checks: { agent: { enabled: true, port: 9100, token: 'x'.repeat(20), tls: true, fingerprint: fp } } }, null, null);
  return { fp: r.value.checks.agent.fingerprint, invalida: r.errors.some(function (e) { return /Huella TLS no válida/.test(e); }) };
}

test('FP-11 coherencia con validate.js: sanitizeTarget guarda la forma canónica de una huella válida y rechaza la inválida', function () {
  assert.deepStrictEqual(veredictoServidor(PLANA), { fp: CANON, invalida: false });
  assert.deepStrictEqual(veredictoServidor(CON.toUpperCase()), { fp: CANON, invalida: false });
  assert.deepStrictEqual(veredictoServidor('  ' + CON + ' '), { fp: CANON, invalida: false });
  assert.deepStrictEqual(veredictoServidor(CON.replace(/:/, '')), { fp: '', invalida: true });
  // Vacía: no es "no válida" sino "obligatoria con TLS"; no se guarda nada.
  assert.deepStrictEqual(veredictoServidor(''), { fp: '', invalida: false });
});

test('FP-12 coherencia cliente/servidor en 2000 entradas aleatorias (válidas, corruptas y basura): mismo veredicto', function () {
  var rnd = lcg(2024), vistosValidos = 0, vistosInvalidos = 0;
  for (var i = 0; i < 2000; i++) {
    var base = hex(rnd, 64), s;
    switch (i % 8) {
      case 0: s = base; break;
      case 1: s = base.replace(/(..)(?!$)/g, '$1:'); break;
      case 2: s = base.replace(/(..)(?!$)/g, '$1:').slice(0, 94 - Math.floor(rnd() * 3)); break;      // truncada
      case 3: s = base.replace(/(..)(?!$)/g, '$1:').replace(':', ''); break;                            // falta un ':'
      case 4: s = ' ' + base.toUpperCase() + ' '; break;
      case 5: s = hex(rnd, Math.floor(rnd() * 70)); break;                                              // longitud aleatoria
      case 6: s = base.slice(0, Math.floor(rnd() * 60)) + ':' + base.slice(Math.floor(rnd() * 60)); break; // ':' suelto
      default: s = base.slice(0, 63) + 'xyzg-:'.charAt(Math.floor(rnd() * 6)); break;
    }
    var valida = F.isValid(s), v = veredictoServidor(s), vacia = s.trim() === '';
    assert.strictEqual(v.fp, valida ? F.normalize(s) : '', 'entrada ' + i + ': ' + JSON.stringify(s));
    assert.strictEqual(v.invalida, !valida && !vacia, 'entrada ' + i + ': ' + JSON.stringify(s));
    if (valida) vistosValidos++; else vistosInvalidos++;
  }
  assert.ok(vistosValidos > 300 && vistosInvalidos > 300, 'la muestra debe cubrir ambos veredictos: ' + vistosValidos + '/' + vistosInvalidos);
});
