'use strict';
/*
 * Enrutador declarativo (server/lib/routes.js). Se prueba solo la interfaz pública: createRouter(tabla).match(método, ruta)
 * -> { route, params } | null, y compile(patrón, params) -> { re, names }. Sin servidor ni red.
 */
var test = require('node:test');
var assert = require('node:assert');
var routes = require('../server/lib/routes');

function h() {}
function router(tabla) { return routes.createRouter(tabla); }

test('RT-01 ruta exacta sin parámetros coincide con su método y devuelve la ruta y params vacío', function () {
  var r = { method: 'GET', pattern: '/api/health', handler: h };
  var m = router([r]).match('GET', '/api/health');
  assert.strictEqual(m.route, r);
  assert.deepStrictEqual(m.params, {});
});

test('RT-02 método distinto o ruta desconocida devuelve null', function () {
  var rt = router([{ method: 'GET', pattern: '/api/health' }]);
  assert.strictEqual(rt.match('POST', '/api/health'), null);
  assert.strictEqual(rt.match('GET', '/api/otra'), null);
  assert.strictEqual(rt.match('GET', ''), null);
});

test('RT-03 tabla vacía no coincide con nada', function () {
  assert.strictEqual(router([]).match('GET', '/'), null);
});

test('RT-04 parámetro :id se extrae con la expresión por defecto [^/]+', function () {
  var rt = router([{ method: 'GET', pattern: '/api/orgs/:id' }]);
  assert.deepStrictEqual(rt.match('GET', '/api/orgs/abc').params, { id: 'abc' });
  assert.strictEqual(rt.match('GET', '/api/orgs/'), null, 'el parámetro no puede ser vacío');
  assert.strictEqual(rt.match('GET', '/api/orgs/a/b'), null, 'el parámetro no cruza barras');
});

test('RT-05 varios parámetros se extraen por nombre y en orden', function () {
  var rt = router([{ method: 'GET', pattern: '/api/:org/targets/:id' }]);
  assert.deepStrictEqual(rt.match('GET', '/api/acme/targets/t_1').params, { org: 'acme', id: 't_1' });
});

test('RT-06 expresión por parámetro (params) restringe lo que se acepta', function () {
  var rt = router([{ method: 'GET', pattern: '/api/orgs/:id', params: { id: '[a-z0-9]{1,4}' } }]);
  assert.deepStrictEqual(rt.match('GET', '/api/orgs/ab12').params, { id: 'ab12' });
  assert.strictEqual(rt.match('GET', '/api/orgs/ABC'), null, 'mayúsculas fuera del conjunto');
  assert.strictEqual(rt.match('GET', '/api/orgs/abcde'), null, 'excede la longitud máxima');
});

test('RT-07 la expresión de un parámetro no afecta a los demás', function () {
  var rt = router([{ method: 'GET', pattern: '/x/:a/:b', params: { a: '[0-9]+' } }]);
  assert.deepStrictEqual(rt.match('GET', '/x/12/hola').params, { a: '12', b: 'hola' });
  assert.strictEqual(rt.match('GET', '/x/ab/hola'), null);
});

test('RT-08 gana la primera ruta de la tabla que coincide (importa el orden)', function () {
  var a = { method: 'GET', pattern: '/api/:x', id: 'a' };
  var b = { method: 'GET', pattern: '/api/health', id: 'b' };
  assert.strictEqual(router([a, b]).match('GET', '/api/health').route, a);
  assert.strictEqual(router([b, a]).match('GET', '/api/health').route, b);
});

test('RT-09 un método \'*\' se rechaza al crear el enrutador, con el patrón en el mensaje', function () {
  assert.throws(function () { router([{ method: '*', pattern: '/api/users/:id' }]); }, /\/api\/users\/:id.*"\*"/);
  assert.throws(function () { router([{ method: 'DELETE', pattern: '/a' }, { method: '*', pattern: '/b' }]); }, /"\*"/);
});

test('RT-10 mismo patrón con distinto access lanza error; con el mismo access se acepta', function () {
  assert.throws(function () {
    router([{ method: 'GET', pattern: '/api/z', access: 'standard' }, { method: 'PUT', pattern: '/api/z', access: 'admin' }]);
  }, /\/api\/z.*access/);
  assert.doesNotThrow(function () {
    router([{ method: 'GET', pattern: '/api/z', access: 'admin' }, { method: 'PUT', pattern: '/api/z', access: 'admin' }]);
  });
  // Patrones distintos pueden tener access distinto.
  assert.doesNotThrow(function () {
    router([{ method: 'GET', pattern: '/api/a', access: 'public' }, { method: 'GET', pattern: '/api/b', access: 'admin' }]);
  });
});

test('RT-11 el método se compara con distinción de mayúsculas', function () {
  var rt = router([{ method: 'GET', pattern: '/a' }]);
  assert.strictEqual(rt.match('get', '/a'), null);
});

test('RT-12 HEAD se trata como GET; OPTIONS solo coincide si está declarado', function () {
  var get = { method: 'GET', pattern: '/a' };
  var sin = router([get]);
  assert.strictEqual(sin.match('HEAD', '/a').route, get, 'HEAD devuelve la ruta GET');
  assert.strictEqual(sin.match('OPTIONS', '/a'), null);
  assert.strictEqual(router([{ method: 'POST', pattern: '/a' }]).match('HEAD', '/a'), null, 'sin GET no hay HEAD');
  var con = router([{ method: 'OPTIONS', pattern: '/a' }]);
  assert.strictEqual(con.match('OPTIONS', '/a').route.method, 'OPTIONS');
});

test('RT-12b noHead excluye a HEAD; una ruta HEAD explícita tiene prioridad sobre el GET', function () {
  var sse = { method: 'GET', pattern: '/s', noHead: true };
  assert.strictEqual(router([sse]).match('HEAD', '/s'), null);
  assert.strictEqual(router([sse]).match('GET', '/s').route, sse);
  var get = { method: 'GET', pattern: '/a' }, head = { method: 'HEAD', pattern: '/a' };
  assert.strictEqual(router([head, get]).match('HEAD', '/a').route, head);
  assert.strictEqual(router([head]).match('GET', '/a'), null, 'HEAD declarado no sirve a GET');
});

// Requisito QA4: una ruta HEAD declarada explícitamente tiene prioridad sobre el GET, sin importar el orden de la tabla.
// Hoy gana la primera de la tabla (server/lib/routes.js:56-57, `serves`): con [GET, HEAD] se devuelve GET.
test('RT-12c HEAD explícita gana al GET aunque se declare después', function () {
  var get = { method: 'GET', pattern: '/a' }, head = { method: 'HEAD', pattern: '/a' };
  assert.strictEqual(router([get, head]).match('HEAD', '/a').route, head);
});

test('RT-13 no hay coincidencias parciales: ni prefijos ni sufijos', function () {
  var rt = router([{ method: 'GET', pattern: '/api/health' }]);
  assert.strictEqual(rt.match('GET', '/api/health/extra'), null, 'prefijo de una ruta más larga');
  assert.strictEqual(rt.match('GET', '/api'), null);
  assert.strictEqual(rt.match('GET', '/api/healthz'), null);
  assert.strictEqual(rt.match('GET', 'x/api/health'), null);
  assert.strictEqual(rt.match('GET', '/x/api/health'), null);
});

test('RT-14 con parámetro tampoco hay coincidencia parcial (ni sufijo ni tramo extra)', function () {
  var rt = router([{ method: 'POST', pattern: '/api/targets/:id/check', params: { id: '[A-Za-z0-9_-]{1,64}' } }]);
  assert.ok(rt.match('POST', '/api/targets/t1/check'));
  assert.strictEqual(rt.match('POST', '/api/targets/t1/check/mas'), null);
  assert.strictEqual(rt.match('POST', '/api/targets/t1'), null);
  assert.strictEqual(rt.match('POST', '/api/targets/t1/checkx'), null);
});

test('RT-15 la barra final es significativa: no se normaliza', function () {
  var rt = router([{ method: 'GET', pattern: '/api/health' }, { method: 'GET', pattern: '/api/lista/' }]);
  assert.strictEqual(rt.match('GET', '/api/health/'), null);
  assert.strictEqual(rt.match('GET', '/api/lista'), null);
  assert.ok(rt.match('GET', '/api/lista/'));
});

test('RT-16 los caracteres especiales del patrón literal se escapan (punto, paréntesis, +, ?)', function () {
  var rt = router([{ method: 'GET', pattern: '/a.b' }, { method: 'GET', pattern: '/c(d)+?' }]);
  assert.ok(rt.match('GET', '/a.b'));
  assert.strictEqual(rt.match('GET', '/aXb'), null, 'el punto no es comodín');
  assert.ok(rt.match('GET', '/c(d)+?'));
  assert.strictEqual(rt.match('GET', '/cd'), null);
});

test('RT-17 un patrón sin ":" no captura nada aunque tenga \'*\' literal', function () {
  var rt = router([{ method: 'GET', pattern: '/api/*' }]);
  assert.ok(rt.match('GET', '/api/*'));
  assert.strictEqual(rt.match('GET', '/api/cualquiera'), null);
});

test('RT-18 parámetros con caracteres codificados se devuelven tal cual (el enrutador no decodifica)', function () {
  var rt = router([{ method: 'GET', pattern: '/api/orgs/:id' }]);
  assert.strictEqual(rt.match('GET', '/api/orgs/a%20b').params.id, 'a%20b');
  assert.strictEqual(rt.match('GET', '/api/orgs/a%2Fb').params.id, 'a%2Fb', '%2F no se trata como barra');
  assert.strictEqual(rt.match('GET', '/api/orgs/ñandú').params.id, 'ñandú');
  assert.strictEqual(rt.match('GET', '/api/orgs/a.b-c_d').params.id, 'a.b-c_d');
});

test('RT-19 el recorrido de directorios (..) no coincide con un parámetro restringido', function () {
  var rt = router([{ method: 'GET', pattern: '/api/orgs/:id', params: { id: '[a-z0-9]{1,32}' } }]);
  assert.strictEqual(rt.match('GET', '/api/orgs/..'), null);
  assert.strictEqual(rt.match('GET', '/api/orgs/a/../b'), null);
});

test('RT-20 un salto de línea final no se cuela en un parámetro restringido', function () {
  var rt = router([{ method: 'GET', pattern: '/api/orgs/:id', params: { id: '[a-z0-9]+' } }]);
  assert.strictEqual(rt.match('GET', '/api/orgs/abc\n'), null);
});

test('RT-21 la ruta devuelta conserva sus campos extra (access, pre, handler)', function () {
  var r = { method: 'GET', pattern: '/a', access: 'admin', mustChange: true, pre: h, handler: h };
  var m = router([r]).match('GET', '/a');
  assert.strictEqual(m.route.access, 'admin');
  assert.strictEqual(m.route.pre, h);
  assert.strictEqual(m.route.handler, h);
});

test('RT-22 cada llamada devuelve un objeto params nuevo (sin estado compartido)', function () {
  var rt = router([{ method: 'GET', pattern: '/o/:id' }]);
  var a = rt.match('GET', '/o/uno'), b = rt.match('GET', '/o/dos');
  assert.notStrictEqual(a.params, b.params);
  assert.strictEqual(a.params.id, 'uno');
  assert.strictEqual(b.params.id, 'dos');
});

test('RT-23 compile devuelve nombres de parámetros en orden y una expresión anclada', function () {
  var c = routes.compile('/a/:x/b/:y_2', { y_2: '[0-9]+' });
  assert.deepStrictEqual(c.names, ['x', 'y_2']);
  assert.ok(c.re.test('/a/q/b/7'));
  assert.ok(!c.re.test('/a/q/b/z'));
  assert.ok(!c.re.test('zz/a/q/b/7'));
});

test('RT-24 un ":" que no inicia un nombre válido se trata como literal', function () {
  var rt = router([{ method: 'GET', pattern: '/hora/12:30' }]);
  assert.ok(rt.match('GET', '/hora/12:30'));
  assert.deepStrictEqual(rt.match('GET', '/hora/12:30').params, {});
});

test('RT-25 patrón de producción: ID_TARGET con rutas específicas y sin comodín', function () {
  var ID = '[A-Za-z0-9_-]{1,64}';
  var rt = router([
    { method: 'PUT', pattern: '/api/targets/:id', params: { id: ID }, k: 'put' },
    { method: 'DELETE', pattern: '/api/targets/:id', params: { id: ID }, k: 'del' }
  ]);
  assert.strictEqual(rt.match('PUT', '/api/targets/t-1').route.k, 'put');
  assert.strictEqual(rt.match('GET', '/api/targets/t-1'), null);
  assert.deepStrictEqual(rt.allowed('/api/targets/t-1').methods, ['PUT', 'DELETE']);
  assert.strictEqual(rt.allowed('/api/targets/' + new Array(66).join('a')), null, 'id de 65 caracteres');
  assert.strictEqual(rt.allowed('/api/targets/a b'), null);
});

test('RT-26 allowed: HEAD justo después de GET, sin duplicados, y noHead lo excluye', function () {
  var rt = router([
    { method: 'GET', pattern: '/x' }, { method: 'PUT', pattern: '/x' },
    { method: 'GET', pattern: '/s', noHead: true }, { method: 'POST', pattern: '/s' },
    { method: 'GET', pattern: '/d' }, { method: 'HEAD', pattern: '/d' },
    { method: 'POST', pattern: '/p' }
  ]);
  assert.deepStrictEqual(rt.allowed('/x').methods, ['GET', 'HEAD', 'PUT']);
  assert.deepStrictEqual(rt.allowed('/s').methods, ['GET', 'POST']);
  assert.deepStrictEqual(rt.allowed('/d').methods.slice().sort(), ['GET', 'HEAD'], 'HEAD declarado y derivado no se duplican');
  assert.strictEqual(rt.allowed('/d').methods.length, 2);
  assert.deepStrictEqual(rt.allowed('/p').methods, ['POST'], 'sin GET no hay HEAD');
});
