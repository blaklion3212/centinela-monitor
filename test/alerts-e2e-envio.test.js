'use strict';
/*
 * Alertas por Telegram, de extremo a extremo, grupo «desactivada y 429 con retry_after»: servidor real (proceso hijo, 127.0.0.1, datos temporales) con planificador real,
 * un "servicio vigilado" local (códigos 200/500 programables) y el servidor de Telegram simulado. Sin Internet.
 * Requisitos: RA-01, RA-06, RA-31 a RA-34, RA-40, RA-41, RA-46, RA-91 y RA-98 escenarios 1, 2, 3, 5 y 8.
 * Los objetivos usan el intervalo mínimo (2 s) y la ventana de agrupación se acorta con CENTINELA_ALERTS_GROUP_WINDOW_MS.
 */
var test = require('node:test');
var assert = require('node:assert');
var A = require('./helpers/alerts-server');
var R = A.R;

test.after(async function () { await A.limpiar(); });

test('RA-98.1 / RA-01 sin alerts.json: objetivos que cambian de estado no abren ninguna conexión hacia Telegram', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var c = await A.nuevoCtl(function (n) { return n % 2 ? 500 : 200; }); // cae, se recupera, cae...
  var id = await A.nuevoObjetivo(h, 'Alternante', c);
  assert.strictEqual((await A.verificar(h, id)).status, 200);
  await A.esperar(function () { return c.hits >= 3; }, 6000, 'tres verificaciones del servicio vigilado');
  await A.pausa(300);
  assert.strictEqual(sim.requests.length, 0, 'sin configuración no hay tráfico a Telegram');
  assert.strictEqual((await h.api('GET', '/api/alerts/status')).json.state, 'off');
});

test('RA-98.1 / RA-06 función desactivada (con token y chat guardados): ningún envío con cambios de estado y sin temporizadores visibles', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ enabled: false, failsBeforeAlert: 1 }) });
  var ctls = [await A.nuevoCtl(500), await A.nuevoCtl(500), await A.nuevoCtl(function (n) { return n % 2 ? 500 : 200; })];
  var ids = [];
  for (var i = 0; i < ctls.length; i++) ids.push(await A.nuevoObjetivo(h, 'Obj' + i, ctls[i]));
  for (var id of ids) await A.verificar(h, id);
  await A.esperar(function () { return ctls[2].hits >= 3; }, 6000, 'verificaciones programadas');
  await A.pausa(500);
  assert.strictEqual(sim.requests.length, 0);
  var st = (await h.api('GET', '/api/alerts/status')).json;
  assert.strictEqual(st.state, 'off'); assert.strictEqual(st.queued, 0); assert.strictEqual(st.inWindow, 0); assert.strictEqual(st.sentTotal, 0);
});

test('RA-98.5 / RA-46 429 con retry_after: no se vuelve a enviar antes de pasar la espera y el mensaje se entrega tras ella', async function () {
  var sim = await A.nuevoSim();
  sim.on('sendMessage', R.retryAfter(2));
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ failsBeforeAlert: 1 }) });
  var c = await A.nuevoCtl(500);
  await A.nuevoObjetivo(h, 'Con limite', c);
  await A.esperar(function () { return sim.sent().length >= 2; }, 10000, 'reintento tras el 429');
  var a = sim.sent()[0], b = sim.sent()[1];
  assert.strictEqual(a.respuesta.status, 429);
  assert.ok(b.t - a.t >= 1900, 'separación entre intentos: ' + (b.t - a.t) + ' ms (se pidieron 2000)');
  assert.strictEqual(b.body.text, a.body.text, 'el mismo mensaje');
  await A.esperar(async function () { return (await h.api('GET', '/api/alerts/status')).json.sentTotal === 1; }, 4000, 'contador de enviados');
  var st = (await h.api('GET', '/api/alerts/status')).json;
  assert.strictEqual(st.failedTotal, 0); assert.strictEqual(st.droppedTotal, 0, 'el 429 no descarta el mensaje');
});
