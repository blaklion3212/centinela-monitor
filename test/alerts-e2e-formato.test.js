'use strict';
/*
 * Alertas por Telegram, de extremo a extremo, grupo «formato, agrupación y organizaciones»: servidor real (proceso hijo, 127.0.0.1, datos temporales) con planificador real,
 * un "servicio vigilado" local (códigos 200/500 programables) y el servidor de Telegram simulado. Sin Internet.
 * Requisitos: RA-01, RA-06, RA-31 a RA-34, RA-40, RA-41, RA-46, RA-91 y RA-98 escenarios 1, 2, 3, 5 y 8.
 * Los objetivos usan el intervalo mínimo (2 s) y la ventana de agrupación se acorta con CENTINELA_ALERTS_GROUP_WINDOW_MS.
 */
var test = require('node:test');
var assert = require('node:assert');
var A = require('./helpers/alerts-server');
var R = A.R;

test.after(async function () { await A.limpiar(); });

test('RA-98.8 / RA-34 / RA-32 varias caídas a la vez en un chat: un solo mensaje «3 avisos», etiqueta solo en organizaciones distintas de la principal, texto literal y sin datos del objetivo (modo mínimo)', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, windowMs: 700, alerts: A.alertasActivas({ failsBeforeAlert: 1 }) });
  var org = await h.api('POST', '/api/orgs', { name: 'Cliente ACME' });
  assert.strictEqual(org.status, 201, org.text);
  var c = await A.nuevoCtl(500);
  var raro = '<b>Raro</b> & *negrita* _x_ [y]';
  var ids = [await A.nuevoObjetivo(h, 'Principal uno', c), await A.nuevoObjetivo(h, 'Del cliente', c, org.json.org.id), await A.nuevoObjetivo(h, raro, c)];
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'mensaje agrupado');
  await A.pausa(500);
  assert.strictEqual(sim.sent().length, 1, 'un único mensaje para el chat: ' + JSON.stringify(sim.texts()));
  var q = sim.sent()[0], lineas = q.body.text.split('\n');
  assert.strictEqual(lineas[0], '3 avisos');
  assert.ok(lineas.indexOf('🔴 Principal uno: CAÍDO') >= 0, 'sin etiqueta para la organización principal: ' + q.body.text);
  assert.ok(lineas.indexOf('🔴 [Cliente ACME] Del cliente: CAÍDO') >= 0, q.body.text);
  assert.ok(lineas.indexOf('🔴 ' + raro + ': CAÍDO') >= 0, 'los caracteres especiales llegan literales: ' + q.body.text);
  assert.ok(!('parse_mode' in q.body), 'sin parse_mode');
  assert.ok(q.body.text.indexOf('127.0.0.1') < 0 && !/HTTP 500|Motivo|Dirección|Hora/.test(q.body.text), 'modo mínimo sin dirección, motivo ni hora');
  assert.strictEqual(ids.length, 3);
});

test('RA-33 / RA-91 modo completo: añade dirección, motivo y hora; la recuperación dice «Servicio recuperado»', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ failsBeforeAlert: 1, detail: 'full' }) });
  var c = await A.nuevoCtl(500);
  await A.nuevoObjetivo(h, 'Completo', c);
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'aviso completo');
  var t = sim.sent()[0].body.text;
  assert.ok(t.indexOf('🔴 Completo: CAÍDO') === 0, t);
  assert.ok(t.indexOf(c.url) > 0, 'dirección: ' + t);
  assert.match(t, /HTTP 500/);
  assert.match(t, /\d{2}:\d{2}:\d{2}/);
  assert.ok(t.split('\n').every(function (l) { return l.trim() !== ''; }), 'sin líneas en blanco');
  c.status = 200;
  await A.esperar(function () { return sim.sent().length >= 2; }, 6000, 'recuperación completa');
  assert.match(sim.sent()[1].body.text, /Servicio recuperado/);
});

test('RA-33 / RA-92 el cambio de detalle en caliente se aplica a los avisos siguientes', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ failsBeforeAlert: 1 }) });
  var c = await A.nuevoCtl(500);
  await A.nuevoObjetivo(h, 'Cambiante', c);
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'primer aviso');
  assert.strictEqual(sim.sent()[0].body.text, '🔴 Cambiante: CAÍDO');
  assert.strictEqual((await h.api('PUT', '/api/alerts', { detail: 'full' })).status, 200);
  c.status = 200;
  await A.esperar(function () { return sim.sent().length >= 2; }, 6000, 'recuperación en modo completo');
  assert.match(sim.sent()[1].body.text, /Dirección: /);
});
