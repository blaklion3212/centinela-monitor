'use strict';
/*
 * Alertas por Telegram: servidor real (proceso hijo, 127.0.0.1, CENTINELA_DATA temporal y simulador de Telegram), correcciones de la
 * revisión: QA-A5 (la prueba devuelve chatId/migratedTo tras migrar), SEC-A3 (migrate_to_chat_id no válido), SEC-A5 (log de base
 * alternativa sin token), SEC-A6 (tokens con caracteres no permitidos: 400) y SEC-A7 (directorio de datos a 0700). Sin Internet.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var A = require('./helpers/alerts-server');
var R = A.R;

test.after(async function () { await A.limpiar(); });

async function conCanal(extra) {
  var sim = await A.nuevoSim();
  var h = await A.arrancar(Object.assign({ sim: sim, alerts: A.alertasActivas({ enabled: false }) }, extra || {}));
  h.sim = sim;
  return h;
}

/* ---------------- QA-A5 ---------------- */

test('QA-A5 POST /api/alerts/test tras una migración devuelve chatId y migratedTo con el chat nuevo, y GET lo refleja', async function () {
  var h = await conCanal();
  h.sim.on('sendMessage', [R.migrate(-1009990001112), R.ok()]);
  var r = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.chatId, '-1009990001112');
  assert.strictEqual(r.json.migratedTo, '-1009990001112');
  assert.strictEqual((await h.api('GET', '/api/alerts')).json.chatId, '-1009990001112');
  assert.strictEqual(A.leerAlerts(h.dir).chatId, '-1009990001112');
});

test('QA-A5 una prueba sin migración no devuelve chatId ni migratedTo', async function () {
  var h = await conCanal();
  var r = await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(r.json.ok, true, r.text);
  assert.ok(!('chatId' in r.json) && !('migratedTo' in r.json), r.text);
});

test('QA-A5 una prueba con un chat distinto al guardado que migra no cambia el chat guardado ni devuelve chatId', async function () {
  var h = await conCanal();
  h.sim.on('sendMessage', R.migrate(-1009990001112));
  var r = await h.api('POST', '/api/alerts/test', { chatId: '-100555444333' });
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(A.leerAlerts(h.dir).chatId, A.CHAT, 'el chat guardado no se toca');
  assert.ok(!('chatId' in r.json));
  assert.strictEqual(h.sim.sent().length, 1, 'sin reintento al chat nuevo');
});

/* ---------------- SEC-A3 ---------------- */

test('SEC-A3 un migrate_to_chat_id no válido (texto con espacios y 0x, o fuera de rango) no migra, no se guarda y no aparece en el log ni en la respuesta', async function () {
  var valores = [' 0x10 ', -5000000000000, '1e3'];
  for (var i = 0; i < valores.length; i++) {
    var h = await conCanal();
    h.sim.on('sendMessage', R.error(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: valores[i] }));
    var r = await h.api('POST', '/api/alerts/test', {});
    var et = JSON.stringify(valores[i]);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.ok, false, et);
    assert.ok(!('migrateTo' in r.json) && !('chatId' in r.json), 'sin migración (' + et + '): ' + r.text);
    assert.strictEqual(A.leerAlerts(h.dir).chatId, A.CHAT, 'alerts.json intacto (' + et + ')');
    assert.strictEqual(h.sim.sent().length, 1, 'sin reintento (' + et + ')');
    var txt = String(valores[i]).trim();
    assert.ok(r.text.indexOf(txt) < 0, 'la respuesta no repite el valor (' + et + ')');
    assert.ok(h.log().indexOf(txt) < 0, 'el log no contiene el valor (' + et + ')');
    assert.ok(!/supergrupo/.test(h.log()), 'no se anuncia ninguna migración');
  }
});

test('SEC-A3 un migrate_to_chat_id válido sí migra (control) y se registra en el log', async function () {
  var h = await conCanal();
  h.sim.on('sendMessage', [R.migrate(-1009990001112), R.ok()]);
  await h.api('POST', '/api/alerts/test', {});
  assert.strictEqual(A.leerAlerts(h.dir).chatId, '-1009990001112');
  assert.match(h.log(), /supergrupo/);
});

/* ---------------- SEC-A5 ---------------- */

test('SEC-A5 con CENTINELA_TELEGRAM_API_BASE al simulador, el log de arranque dice «Usando base alternativa de la API» y no contiene el token', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ enabled: false }), env: { CENTINELA_TELEGRAM_TOKEN: A.TOKEN_ENV } });
  var log = h.log();
  assert.match(log, /Usando base alternativa de la API/);
  assert.ok(log.indexOf(sim.base) >= 0, 'muestra solo el origen de la base: ' + log);
  [A.TOKEN, A.TOKEN_ENV, A.TOKEN.split(':')[1], A.TOKEN_ENV.split(':')[1], A.TOKEN.split(':')[0], A.TOKEN_ENV.split(':')[0]].forEach(function (s) {
    assert.ok(log.indexOf(s) < 0, 'el log no debe contener ' + s.slice(0, 6) + '…');
  });
  await h.api('POST', '/api/alerts/test', {});
  assert.ok(h.log().indexOf(A.TOKEN_ENV.split(':')[1]) < 0 && h.log().indexOf(A.TOKEN.split(':')[1]) < 0, 'ni tras usar la base alternativa');
});

test('SEC-A5 sin CENTINELA_TELEGRAM_API_BASE el arranque no anuncia base alternativa', async function () {
  // Servidor sin base alternativa: no se usa A.arrancar (que siempre fija el simulador) para comprobar el caso por omisión.
  var srv = require('./helpers/server');
  var tmp = require('./helpers/tmp');
  var dir = tmp.mkTmp('centinela-sec5-');
  fs.writeFileSync(dir + '/targets.json', '[]');
  var h = await srv.startServer({ dir: dir, env: { CENTINELA_ADMIN_USER: A.ADMIN, CENTINELA_ADMIN_PASSWORD: A.ADMIN_PASS, CENTINELA_TELEGRAM_API_BASE: '', CENTINELA_TELEGRAM_TOKEN: '', CENTINELA_ALERTS_DISABLED: '' } });
  try { assert.doesNotMatch(h.log(), /base alternativa/); } finally { await h.stop(); tmp.rmTmp(dir); }
});

/* ---------------- SEC-A6 ---------------- */

test('SEC-A6 PUT /api/alerts/token rechaza con 400 tokens con caracteres fuera de [A-Za-z0-9_-] y no los guarda ni los repite', async function () {
  var h = await conCanal();
  var base = '123456789:AAH_abcdefghijklmnopqrstuvwxyz0123';
  var malos = [base + '.45', base + '/45', base + '?x=1', base + '%2F', base + ' 45', base + 'é', base + '\n45', base + '#f', base + '@host', base + '\\45'];
  for (var i = 0; i < malos.length; i++) {
    var r = await h.api('PUT', '/api/alerts/token', { token: malos[i] });
    assert.strictEqual(r.status, 400, JSON.stringify(malos[i]) + ' -> ' + r.status);
    assert.ok(r.text.indexOf('AAH_abc') < 0, 'la respuesta no repite el token');
  }
  assert.strictEqual(A.leerAlerts(h.dir).token, A.TOKEN, 'el token guardado no cambió');
  assert.ok(h.log().indexOf('AAH_abcdefghijklmnopqrstuvwxyz0123.') < 0);
  var ok = await h.api('PUT', '/api/alerts/token', { token: A.TOKEN_ENV });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(A.leerAlerts(h.dir).token, A.TOKEN_ENV);
});

/* ---------------- SEC-A7 ---------------- */

test('SEC-A7 un CENTINELA_DATA temporal con modo 755 queda en 700 al arrancar', async function (t) {
  if (process.platform === 'win32') return t.skip('Windows no tiene modos POSIX de directorio');
  var sim = await A.nuevoSim();
  var dir = A.nuevoDir();
  fs.chmodSync(dir, 0o755);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o755, 'control: parte de 755');
  await A.arrancar({ sim: sim, dir: dir });
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
});

test('SEC-A7 un directorio ya en 700 se queda en 700 y el servidor arranca igual', async function (t) {
  if (process.platform === 'win32') return t.skip('Windows no tiene modos POSIX de directorio');
  var sim = await A.nuevoSim();
  var dir = A.nuevoDir();
  fs.chmodSync(dir, 0o700);
  var h = await A.arrancar({ sim: sim, dir: dir });
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual((await h.api('GET', '/api/alerts')).status, 200);
});

test('SEC-A7 alerts.json escrito por el servidor conserva modo 0600', async function (t) {
  if (process.platform === 'win32') return t.skip('Windows no tiene modos POSIX');
  var h = await conCanal();
  await h.api('PUT', '/api/alerts', { detail: 'full' });
  assert.strictEqual(fs.statSync(h.dir + '/alerts.json').mode & 0o777, 0o600);
});
