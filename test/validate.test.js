'use strict';
/* R2 y R3: validación de hosts/servicios, tokens del agente y ajustes. */
var test = require('node:test');
var assert = require('node:assert');
var V = require('../server/lib/validate.js');
var Defaults = require('../js/config/defaults.js');
var Sysmetrics = require('../agent/sysmetrics.js');

/* ---------- R2: hosts ---------- */
test('R2: isValidHost acepta IPs y nombres normales', function () {
  ['8.8.8.8', '127.0.0.1', '::1', '2001:db8::1', 'localhost', 'example.com', 'a-b.example.com', 'srv_01.lan'].forEach(function (h) {
    assert.strictEqual(V.isValidHost(h), true, h);
  });
});

test('R2: isValidHost rechaza opciones, espacios, metacaracteres y sustituciones', function () {
  ['-x', '-Hroot@x', '--help', 'a b', ' example.com', 'example.com ', 'a;b', 'a;rm -rf /', '$(id)', 'a$(id).com',
   '`id`', 'a|b', 'a&b', 'a>b', "a'b", 'a"b', 'a\nb', '', 'http://example.com', 'a/b'].forEach(function (h) {
    assert.strictEqual(V.isValidHost(h), false, JSON.stringify(h));
  });
});

test('R2: isValidHost rechaza tipos no cadena y longitudes excesivas', function () {
  [null, undefined, 123, {}, []].forEach(function (h) { assert.strictEqual(V.isValidHost(h), false); });
  assert.strictEqual(V.isValidHost('a'.repeat(254)), false);
  assert.strictEqual(V.isValidHost('a'.repeat(64) + '.com'), false); // etiqueta de más de 63
});

/* ---------- R2: SERVICE_RE (vía sanitizeTarget y sysmetrics) ---------- */
function svcErrors(names) {
  return V.sanitizeTarget({ name: 'x', address: '10.0.0.1', checks: { agent: { enabled: true, services: names } } }, null, null);
}

test('R2: nombres de servicio válidos se aceptan (nginx, a@b.service)', function () {
  var r = svcErrors(['nginx', 'a@b.service', 'systemd-resolved', 'foo.bar_baz:1']);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.value.checks.agent.services, ['nginx', 'a@b.service', 'systemd-resolved', 'foo.bar_baz:1']);
});

test('R2: servicio que empieza por "-" o con caracteres peligrosos se rechaza', function () {
  ['-Hroot@x', '--now', '-', 'a b', 'a;b', '$(id)', 'a/b'].forEach(function (n) {
    var r = svcErrors([n]);
    assert.ok(r.errors.length > 0, 'debía rechazar ' + n);
    assert.deepStrictEqual(r.value.checks.agent.services, []);
  });
});

test('R2: SERVICE_RE de agent/sysmetrics coincide en el criterio', function () {
  var re = Sysmetrics.SERVICE_RE;
  assert.strictEqual(re.test('-Hroot@x'), false);
  assert.strictEqual(re.test('nginx'), true);
  assert.strictEqual(re.test('a@b.service'), true);
});

/* ---------- R2: token del agente ---------- */
function existingWithToken() {
  return { id: 't_1', address: '10.0.0.5', checks: { agent: { enabled: true, port: 9100, token: 'SECRETO', services: [] } } };
}
function input(o) {
  var base = { name: 'srv', address: '10.0.0.5', checks: { agent: { enabled: true, port: 9100, services: [] } } };
  if (o && o.address) base.address = o.address;
  if (o && o.port) base.checks.agent.port = o.port;
  if (o && o.token !== undefined) base.checks.agent.token = o.token;
  if (o && o.clearToken) base.checks.agent.clearToken = true;
  return base;
}

test('R2: sanitizeTarget conserva el token si no cambian dirección ni puerto', function () {
  var r = V.sanitizeTarget(input(), existingWithToken(), null);
  assert.strictEqual(r.value.checks.agent.token, 'SECRETO');
});

test('R2: la comparación de dirección ignora mayúsculas, espacios y punto final', function () {
  var ex = existingWithToken(); ex.address = 'Srv.Example.com';
  var r = V.sanitizeTarget(input({ address: ' srv.example.com. ' }), ex, null);
  assert.strictEqual(r.value.checks.agent.token, 'SECRETO');
});

test('R2: sanitizeTarget pierde el token si cambia la dirección', function () {
  var r = V.sanitizeTarget(input({ address: '10.0.0.99' }), existingWithToken(), null);
  assert.strictEqual(r.value.checks.agent.token, '');
});

test('R2: sanitizeTarget pierde el token si cambia el puerto del agente', function () {
  var r = V.sanitizeTarget(input({ port: 9200 }), existingWithToken(), null);
  assert.strictEqual(r.value.checks.agent.token, '');
});

test('R2: un token nuevo enviado se respeta aunque cambie el destino', function () {
  var r = V.sanitizeTarget(input({ address: '10.0.0.99', token: 'NUEVO' }), existingWithToken(), null);
  assert.strictEqual(r.value.checks.agent.token, 'NUEVO');
  var r2 = V.sanitizeTarget(input({ token: 'OTRO' }), existingWithToken(), null);
  assert.strictEqual(r2.value.checks.agent.token, 'OTRO');
});

test('R2: clearToken borra el token aunque el destino sea el mismo', function () {
  var r = V.sanitizeTarget(input({ clearToken: true }), existingWithToken(), null);
  assert.strictEqual(r.value.checks.agent.token, '');
});

test('R2: publicTarget nunca expone el token (y no modifica el original)', function () {
  var t = V.sanitizeTarget(input({ token: 'SECRETO' }), null, null).value;
  var p = V.publicTarget(t);
  assert.strictEqual(p.checks.agent.token, '');
  assert.strictEqual(p.checks.agent.hasToken, true);
  assert.ok(JSON.stringify(p).indexOf('SECRETO') < 0);
  assert.strictEqual(t.checks.agent.token, 'SECRETO');
  var sin = V.publicTarget(V.sanitizeTarget(input(), null, null).value);
  assert.strictEqual(sin.checks.agent.hasToken, false);
});

test('R2: sanitizeTarget valida entradas básicas (nombre, host, URL)', function () {
  assert.ok(V.sanitizeTarget({}, null, null).errors.length >= 2);
  assert.ok(V.sanitizeTarget({ name: 'a', address: '-x' }, null, null).errors.length > 0);
  assert.ok(V.sanitizeTarget({ name: 'a', kind: 'url', address: 'ftp://x.com' }, null, null).errors.length > 0);
  assert.ok(V.sanitizeTarget({ name: 'a', kind: 'url', address: 'http://-x/' }, null, null).errors.length > 0);
  var ok = V.sanitizeTarget({ name: 'a', kind: 'url', address: 'https://x.com/p' }, null, null);
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.value.checks.ssl, true);
  assert.ok(V.sanitizeTarget(null, null, null).errors.length > 0);
});

/* ---------- R3: sanitizeSettings ---------- */
function cur() { return JSON.parse(JSON.stringify(Defaults.SETTINGS)); }

test('R3: valor vacío o no numérico conserva el previo (no 0)', function () {
  var c = cur(); c.thresholds.latencyWarnMs = 123; c.intervalSec = 33;
  var out = V.sanitizeSettings({ intervalSec: '', thresholds: { latencyWarnMs: '', latencyCritMs: 'abc', jitterWarnMs: null, jitterCritMs: true } }, c);
  assert.strictEqual(out.intervalSec, 33);
  assert.strictEqual(out.thresholds.latencyWarnMs, 123);
  assert.strictEqual(out.thresholds.latencyCritMs, c.thresholds.latencyCritMs);
  assert.strictEqual(out.thresholds.jitterWarnMs, c.thresholds.jitterWarnMs);
  assert.strictEqual(out.thresholds.jitterCritMs, c.thresholds.jitterCritMs);
});

test('R3: valores numéricos válidos (número o texto) se aplican', function () {
  var out = V.sanitizeSettings({ intervalSec: '20', thresholds: { latencyWarnMs: '200', latencyCritMs: 500 } }, cur());
  assert.strictEqual(out.intervalSec, 20);
  assert.strictEqual(out.thresholds.latencyWarnMs, 200);
  assert.strictEqual(out.thresholds.latencyCritMs, 500);
});

test('R3: aviso >= crítico se rechaza y conserva ambos valores previos', function () {
  var base = cur();
  var eq = V.sanitizeSettings({ thresholds: { latencyWarnMs: 300, latencyCritMs: 300 } }, base);
  assert.strictEqual(eq.thresholds.latencyWarnMs, base.thresholds.latencyWarnMs);
  assert.strictEqual(eq.thresholds.latencyCritMs, base.thresholds.latencyCritMs);
  var inv = V.sanitizeSettings({ thresholds: { cpuWarnPct: 99, cpuCritPct: 50 } }, base);
  assert.strictEqual(inv.thresholds.cpuWarnPct, base.thresholds.cpuWarnPct);
  assert.strictEqual(inv.thresholds.cpuCritPct, base.thresholds.cpuCritPct);
});

test('R3: un orden inválido en una métrica no afecta a las demás', function () {
  var out = V.sanitizeSettings({ thresholds: { latencyWarnMs: 900, latencyCritMs: 100, lossWarnPct: 5, lossCritPct: 50 } }, cur());
  assert.strictEqual(out.thresholds.latencyWarnMs, Defaults.SETTINGS.thresholds.latencyWarnMs);
  assert.strictEqual(out.thresholds.lossWarnPct, 5);
  assert.strictEqual(out.thresholds.lossCritPct, 50);
});

test('R3: SSL invertido (aviso > crítico) es válido y aviso <= crítico se rechaza', function () {
  var base = cur();
  var ok = V.sanitizeSettings({ thresholds: { sslWarnDays: 45, sslCritDays: 10 } }, base);
  assert.strictEqual(ok.thresholds.sslWarnDays, 45);
  assert.strictEqual(ok.thresholds.sslCritDays, 10);
  var bad = V.sanitizeSettings({ thresholds: { sslWarnDays: 5, sslCritDays: 10 } }, base);
  assert.strictEqual(bad.thresholds.sslWarnDays, base.thresholds.sslWarnDays);
  assert.strictEqual(bad.thresholds.sslCritDays, base.thresholds.sslCritDays);
});

test('R3: valores negativos o desmesurados no se aplican; rangos de intervalo se acotan', function () {
  var base = cur();
  var out = V.sanitizeSettings({ intervalSec: 99999, thresholds: { latencyWarnMs: -5, latencyCritMs: 1e9 } }, base);
  assert.strictEqual(out.intervalSec, 3600);
  assert.strictEqual(out.thresholds.latencyWarnMs, base.thresholds.latencyWarnMs);
  assert.strictEqual(out.thresholds.latencyCritMs, base.thresholds.latencyCritMs);
  assert.strictEqual(V.sanitizeSettings({ intervalSec: 0 }, base).intervalSec, 2);
});

test('R3: no muta el objeto actual y tolera entradas no objeto', function () {
  var base = cur(), copia = JSON.stringify(base);
  V.sanitizeSettings({ intervalSec: 50, theme: 'light' }, base);
  assert.strictEqual(JSON.stringify(base), copia);
  assert.deepStrictEqual(V.sanitizeSettings(null, base), base);
  assert.strictEqual(V.sanitizeSettings({ theme: 'rosa' }, base).theme, base.theme);
});

/* ---------- Ronda 1: reparación de ceros y settingsErrors ---------- */
var AVISOS_POSITIVOS = ['latencyWarnMs', 'lossWarnPct', 'jitterWarnMs', 'ttfbWarnMs', 'diskWarnPct', 'cpuWarnPct', 'memWarnPct', 'ioWaitWarnPct'];

test('R3: sanitizeSettings repara avisos Ms/Pct guardados en 0, negativos o no numéricos con el valor por defecto', function () {
  var d = Defaults.SETTINGS.thresholds;
  var roto = cur();
  AVISOS_POSITIVOS.forEach(function (k, i) { roto.thresholds[k] = [0, -5, 'x', null, 0, -1, NaN, 0][i]; });
  // Cualquier guardado con thresholds repara el estado previo corrupto.
  var out = V.sanitizeSettings({ thresholds: { sslWarnDays: 31 } }, roto);
  AVISOS_POSITIVOS.forEach(function (k) { assert.strictEqual(out.thresholds[k], d[k], k + ' reparado'); });
  assert.strictEqual(out.thresholds.sslWarnDays, 31, 'lo demás se aplica');
});

test('R3: un aviso enviado en 0 se sustituye por el valor por defecto (no se guarda 0)', function () {
  var out = V.sanitizeSettings({ thresholds: { latencyWarnMs: 0, cpuWarnPct: '0' } }, cur());
  assert.strictEqual(out.thresholds.latencyWarnMs, Defaults.SETTINGS.thresholds.latencyWarnMs);
  assert.strictEqual(out.thresholds.cpuWarnPct, Defaults.SETTINGS.thresholds.cpuWarnPct);
});

test('R3: los umbrales críticos y los de días no se tratan como "aviso en 0"', function () {
  var out = V.sanitizeSettings({ thresholds: { sslWarnDays: 10, sslCritDays: 0 } }, cur());
  assert.strictEqual(out.thresholds.sslCritDays, 0, 'sslCritDays=0 es válido (aviso 10 > crítico 0)');
  assert.strictEqual(out.thresholds.sslWarnDays, 10);
});

test('R3: settingsErrors devuelve [] para cuerpos válidos, vacíos o no objeto', function () {
  assert.deepStrictEqual(V.settingsErrors({}, cur()), []);
  assert.deepStrictEqual(V.settingsErrors(null, cur()), []);
  assert.deepStrictEqual(V.settingsErrors({ intervalSec: '30', historyPoints: 100, theme: 'light' }, cur()), []);
  assert.deepStrictEqual(V.settingsErrors({ thresholds: { latencyWarnMs: 100, latencyCritMs: 300 } }, cur()), []);
  assert.deepStrictEqual(V.settingsErrors({ intervalSec: '', thresholds: { latencyWarnMs: '', jitterWarnMs: null } }, cur()), [], 'vacío/null = "no enviado"');
  assert.deepStrictEqual(V.settingsErrors({ thresholds: { sslWarnDays: 45, sslCritDays: 10 } }, cur()), []);
  assert.deepStrictEqual(V.settingsErrors({ thresholds: { latencyWarnMs: 100 } }, undefined), [], 'sin estado previo usa los valores por defecto');
});

test('R3: settingsErrors detecta valores no numéricos (intervalos y umbrales)', function () {
  var e1 = V.settingsErrors({ intervalSec: 'abc' }, cur());
  assert.strictEqual(e1.length, 1);
  assert.match(e1[0], /Intervalo por defecto \(s\)/);
  assert.doesNotMatch(e1[0], /intervalSec/, 'sin claves internas');
  assert.match(V.settingsErrors({ historyPoints: {} }, cur())[0], /Puntos de historial/);
  var e2 = V.settingsErrors({ thresholds: { latencyWarnMs: 'rápido' } }, cur());
  assert.strictEqual(e2.length, 1);
  assert.match(e2[0], /Latencia \(aviso\)/);
  assert.doesNotMatch(e2[0], /latencyWarnMs/, 'sin claves internas');
});

test('R3: settingsErrors detecta umbrales fuera de rango y avisos en 0', function () {
  assert.match(V.settingsErrors({ thresholds: { latencyCritMs: -1 } }, cur()).join(' '), /Latencia \(crítico\).*rango/);
  assert.match(V.settingsErrors({ thresholds: { latencyCritMs: 2e6 } }, cur()).join(' '), /Latencia \(crítico\).*rango/);
  var cero = V.settingsErrors({ thresholds: { cpuWarnPct: 0 } }, cur());
  assert.ok(cero.some(function (m) { return /CPU \(aviso\)/.test(m) && /mayor que 0/.test(m); }), cero.join(' | '));
});

test('R3: settingsErrors detecta aviso >= crítico (y SSL invertido) usando el estado previo', function () {
  var e = V.settingsErrors({ thresholds: { latencyWarnMs: 900, latencyCritMs: 100 } }, cur());
  assert.ok(e.some(function (m) { return m === 'En "Latencia" el aviso (900) debe ser menor que el crítico (100).'; }), e.join(' | '));
  assert.ok(V.settingsErrors({ thresholds: { latencyWarnMs: 400 } }, cur()).length > 0, 'aviso igual al crítico previo (400)');
  var prev = cur(); prev.thresholds.latencyCritMs = 1000;
  assert.deepStrictEqual(V.settingsErrors({ thresholds: { latencyWarnMs: 600 } }, prev), [], 'válido frente al crítico previo (1000)');
  var ssl = V.settingsErrors({ thresholds: { sslWarnDays: 5, sslCritDays: 10 } }, cur());
  assert.ok(ssl.some(function (m) { return /^En "SSL: días restantes" el aviso \(5\) debe ser mayor que el crítico \(10\)/.test(m); }), ssl.join(' | '));
});

test('R3: settingsErrors acumula varios errores y no muta sus argumentos', function () {
  var base = cur(), body = { intervalSec: 'x', thresholds: { cpuWarnPct: 0, latencyWarnMs: 'z' } };
  var antes = JSON.stringify(base), cuerpo = JSON.stringify(body);
  var e = V.settingsErrors(body, base);
  assert.ok(e.length >= 3, e.join(' | '));
  e.forEach(function (m) { assert.strictEqual(typeof m, 'string'); });
  assert.strictEqual(JSON.stringify(base), antes);
  assert.strictEqual(JSON.stringify(body), cuerpo);
});
