'use strict';
/*
 * Alertas por Telegram, de extremo a extremo, grupo «ciclo de aviso: caída tras N fallos, recuperación y servicio intermitente»: servidor real (proceso hijo, 127.0.0.1, datos temporales) con planificador real,
 * un "servicio vigilado" local (códigos 200/500 programables) y el servidor de Telegram simulado. Sin Internet.
 * Requisitos: RA-01, RA-06, RA-31 a RA-34, RA-40, RA-41, RA-46, RA-91 y RA-98 escenarios 1, 2, 3, 5 y 8.
 * Los objetivos usan el intervalo mínimo (2 s) y la ventana de agrupación se acorta con CENTINELA_ALERTS_GROUP_WINDOW_MS.
 */
var test = require('node:test');
var assert = require('node:assert');
var A = require('./helpers/alerts-server');
var R = A.R;

test.after(async function () { await A.limpiar(); });

var CAIDO = /🔴 .*: CAÍDO/;

test('RA-98.2 / RA-40 / RA-41 activada y válida: un solo aviso CAÍDO tras N=2 fallos (token en la ruta, chat correcto) y RECUPERADO al volver', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas() });
  var c = await A.nuevoCtl(500);
  await A.nuevoObjetivo(h, 'Portal intranet', c);
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'aviso de caída');
  var q = sim.sent()[0];
  assert.strictEqual(q.body.text, '🔴 Portal intranet: CAÍDO');
  assert.strictEqual(q.token, A.TOKEN); assert.strictEqual(q.body.chat_id, A.CHAT);
  assert.ok(c.hits >= 2, 'no se avisó antes de N=2 verificaciones');
  // Tercera y cuarta verificación down: el aviso no se repite.
  var hits0 = c.hits;
  await A.esperar(function () { return c.hits >= hits0 + 1; }, 5000, 'otra verificación down');
  await A.pausa(400);
  assert.strictEqual(sim.sent().length, 1, 'no se repite el aviso mientras siga caído');
  // Recuperación.
  c.status = 200;
  await A.esperar(function () { return sim.sent().length >= 2; }, 6000, 'aviso de recuperación');
  assert.strictEqual(sim.sent()[1].body.text, '🟢 Portal intranet: RECUPERADO');
  var st = (await h.api('GET', '/api/alerts/status')).json;
  assert.strictEqual(st.sentTotal, 2); assert.strictEqual(st.state, 'ok');
  await A.esperar(function () { return Object.keys(A.leerAlerts(h.dir).alerted).length === 0; }, 3000, 'alerted se vacía tras la recuperación (guardado diferido)');
});

test('RA-98.3 un servicio que alterna caído/activo no avisa; en cuanto cae N veces seguidas avisa una sola vez', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas() });
  var c = await A.nuevoCtl(function (n) { return n % 2 ? 500 : 200; }); // down, up, down...
  var id = await A.nuevoObjetivo(h, 'Intermitente', c);
  await A.verificar(h, id); // hit 1 down (manual), hit 2 up (programada ~0,3 s), hit 3 down (2 s después)
  await A.esperar(function () { return c.hits >= 3; }, 6000, 'tres verificaciones alternas');
  await A.pausa(400);
  assert.strictEqual(sim.requests.length, 0, 'down, up, down con N=2: ningún aviso');
  c.status = 500; // a partir de ahora siempre cae: el siguiente down ya es el 2.º seguido
  await A.esperar(function () { return sim.sent().length >= 1; }, 6000, 'aviso por caída sostenida');
  await A.pausa(300);
  assert.strictEqual(sim.sent().length, 1);
  assert.match(sim.sent()[0].body.text, CAIDO);
});
