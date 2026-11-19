'use strict';
/*
 * Alertas por Telegram, de extremo a extremo (desactivar y borrar): requisitos RA-03 y RA-44.
 */
var test = require('node:test');
var assert = require('node:assert');
var A = require('./helpers/alerts-server');

test.after(async function () { await A.limpiar(); });

test('RA-03 / RA-44 desactivar con un aviso en la ventana de agrupación: no se envía nada, el estado queda vacío y alerted se limpia', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, windowMs: 3000, alerts: A.alertasActivas({ failsBeforeAlert: 1 }) });
  var c = await A.nuevoCtl(500);
  var id = await A.nuevoObjetivo(h, 'Pendiente', c);
  await A.esperar(async function () { return (await h.api('GET', '/api/alerts/status')).json.inWindow === 1; }, 6000, 'aviso en la ventana');
  await A.esperar(function () { return Object.keys(A.leerAlerts(h.dir).alerted).join() === id; }, 3000, 'alerted guardado (guardado diferido)');
  var r = await h.api('PUT', '/api/alerts', { enabled: false });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.enabled, false);
  var st = (await h.api('GET', '/api/alerts/status')).json;
  assert.strictEqual(st.inWindow, 0); assert.strictEqual(st.queued, 0); assert.strictEqual(st.state, 'off');
  assert.deepStrictEqual(A.leerAlerts(h.dir).alerted, {}, 'al desactivar, alerted queda vacío');
  assert.match(h.log(), /desactivadas por administrador/);
  var hits = c.hits;
  await A.esperar(function () { return c.hits >= hits + 1; }, 5000, 'una verificación más con la función apagada');
  await A.pausa(3300); // más que la ventana de agrupación que quedó cancelada
  assert.strictEqual(sim.requests.length, 0, 'ni la ventana pendiente ni los eventos posteriores generan peticiones');
});

test('RA-44 borrar un objetivo avisado lo saca de alerted y no se avisa su recuperación', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ failsBeforeAlert: 1 }) });
  var c = await A.nuevoCtl(500);
  var id = await A.nuevoObjetivo(h, 'Efimero', c);
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'aviso de caída');
  await A.esperar(function () { return A.leerAlerts(h.dir).alerted[id] === 'down'; }, 3000, 'alerted guardado');
  var d = await h.api('DELETE', '/api/targets/' + id, {});
  assert.strictEqual(d.status, 200, d.text);
  await A.esperar(function () { return Object.keys(A.leerAlerts(h.dir).alerted).length === 0; }, 3000, 'alerted sin el objetivo borrado (guardado diferido)');
  c.status = 200;
  await A.pausa(2600);
  assert.strictEqual(sim.sent().length, 1, 'no hay aviso de recuperación del objetivo borrado');
});
