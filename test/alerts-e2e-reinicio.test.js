'use strict';
/*
 * Alertas por Telegram, de extremo a extremo (reinicio): se detiene el proceso (SIGKILL, como una caída) y se arranca de nuevo
 * sobre el mismo directorio de datos temporal. Requisitos: RA-44 y RA-98 escenario 9.
 */
var test = require('node:test');
var assert = require('node:assert');
var A = require('./helpers/alerts-server');

test.after(async function () { await A.limpiar(); });

test('RA-98.9/RT-21 reinicio: una caída ya avisada no se repite y su recuperación pendiente sí se avisa', async function () {
  var sim = await A.nuevoSim();
  var h1 = await A.arrancar({ sim: sim, alerts: A.alertasActivasV2() });
  var c = await A.nuevoCtl(500);
  var id = await A.nuevoObjetivo(h1, 'Portal', c);
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'aviso de caída antes del reinicio');
  assert.strictEqual(sim.sent()[0].body.text, '🔴 Portal: CAÍDO');
  await A.esperar(function () { return A.leerAlerts(h1.dir).alerted[id + '|down'] === 'on'; }, 3000, 'alerted guardado en disco');
  var dir = h1.dir;
  await A.parar(h1);
  var hits0 = c.hits;
  var h2 = await A.arrancar({ sim: sim, dir: dir });
  await A.esperar(function () { return c.hits >= hits0 + 2; }, 8000, 'dos verificaciones tras el reinicio');
  await A.pausa(500);
  assert.strictEqual(sim.sent().length, 1, 'el aviso de la caída no se repite tras el reinicio');
  c.status = 200;
  await A.esperar(function () { return sim.sent().length >= 2; }, 6000, 'aviso de recuperación pendiente');
  assert.strictEqual(sim.sent()[1].body.text, '🟢 Portal: RECUPERADO');
  await A.esperar(function () { return Object.keys(A.leerAlerts(dir).alerted).length === 0; }, 3000, 'alerted vacío (guardado diferido)');
  assert.strictEqual((await h2.api('GET', '/api/alerts/status')).json.sentTotal, 1);
});

test('RA-98.9/RT-21 reinicio: una caída que nunca se avisó se avisa tras N fallos seguidos contados desde cero', async function () {
  var sim = await A.nuevoSim();
  var h1 = await A.arrancar({ sim: sim, alerts: A.alertasActivasV2({ enabled: false }) });
  var c = await A.nuevoCtl(500);
  var id = await A.nuevoObjetivo(h1, 'Silencioso', c);
  await A.esperar(function () { return c.hits >= 1; }, 4000, 'primera verificación');
  var dir = h1.dir;
  await A.parar(h1);
  assert.strictEqual(sim.requests.length, 0);
  require('fs').writeFileSync(require('path').join(dir, 'alerts.json'), JSON.stringify(A.alertasActivasV2({ alerted: {} })), { mode: 0o600 });
  var hits0 = c.hits;
  await A.arrancar({ sim: sim, dir: dir });
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'aviso de la caída no avisada');
  assert.ok(c.hits >= hits0 + 2, 'hacen falta N=2 verificaciones tras el reinicio');
  assert.strictEqual(sim.sent()[0].body.text, '🔴 Silencioso: CAÍDO');
  await A.esperar(function () { return A.leerAlerts(dir).alerted[id + '|down'] === 'on'; }, 3000, 'alerted guardado (guardado diferido)');
});
