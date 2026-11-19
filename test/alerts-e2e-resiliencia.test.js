'use strict';
/*
 * Alertas por Telegram, de extremo a extremo (resiliencia): servidor real con planificador real, servicio vigilado local y
 * servidor de Telegram simulado. Sin Internet. Requisitos: RA-35, RA-45, RA-48 y RA-98 escenario 4
 * (caída de Telegram con silencio y con 5xx: las verificaciones siguen a la cadencia normal).
 * El plazo de 10 s por petición (RA-36) se prueba en alerts-canal.test.js con un plazo corto: aquí no se esperan 10 s reales.
 */
var test = require('node:test');
var assert = require('node:assert');
var A = require('./helpers/alerts-server');
var R = A.R;

test.after(async function () { await A.limpiar(); });

// Telegram "caído" (modo: silencio | 5xx) mientras un objetivo sigue cayendo: mide la cadencia del planificador.
async function escenario(modo) {
  var sim = await A.nuevoSim();
  sim.setDefault('sendMessage', modo === 'silencio' ? R.silence() : R.error(503, 'Service Unavailable'));
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas() });
  var c = await A.nuevoCtl(500);
  await A.nuevoObjetivo(h, 'Caido', c);
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'primer intento de envío (' + modo + ')');
  // RA-35: con un envío pendiente, una verificación manual de otro objetivo responde enseguida.
  var c2 = await A.nuevoCtl(200);
  var id2 = await A.nuevoObjetivo(h, 'Otro', c2);
  var t0 = Date.now();
  var v = await A.verificar(h, id2);
  var dt = Date.now() - t0;
  assert.strictEqual(v.status, 200, v.text);
  assert.ok(dt < 1500, modo + ': la verificación manual esperó al envío (' + dt + ' ms)');
  // Cadencia: el servicio vigilado sigue verificándose cada ~2 s mientras Telegram no responde.
  await A.esperar(function () { return c.hits >= 4; }, 12000, 'cuatro verificaciones del servicio caído (' + modo + ')');
  for (var i = 1; i < c.times.length; i++) {
    var gap = c.times[i] - c.times[i - 1];
    assert.ok(gap >= 1200 && gap <= 3500, modo + ': hueco entre verificaciones ' + gap + ' ms (intervalo de 2000 ms)');
  }
  return { sim: sim, h: h, c: c };
}

test('RA-98.4 / RA-35 Telegram en silencio y Telegram con 5xx: el planificador mantiene su cadencia y las verificaciones manuales no esperan al envío', async function () {
  var r = await Promise.all([escenario('silencio'), escenario('5xx')]);
  // Con 5xx el motor reintenta con retroceso (≥ 2 s entre intentos) y deja el estado en error sin datos sensibles.
  var s5 = r[1];
  await A.esperar(function () { return s5.sim.sent().length >= 2; }, 8000, 'reintento tras el 503');
  assert.ok(s5.sim.sent()[1].t - s5.sim.sent()[0].t >= 1900, 'retroceso de 2 s: ' + (s5.sim.sent()[1].t - s5.sim.sent()[0].t));
  var st = (await s5.h.api('GET', '/api/alerts/status')).json;
  assert.strictEqual(st.state, 'error');
  assert.ok(st.lastError && st.lastError.code, JSON.stringify(st));
  assert.ok(JSON.stringify(st).indexOf(A.TOKEN) < 0 && JSON.stringify(st).indexOf('/bot') < 0);
  assert.strictEqual(st.sentTotal, 0);
  // Con silencio, la petición sigue en curso: no hay ni envíos ni descartes todavía y la función sigue activa.
  var ss = (await r[0].h.api('GET', '/api/alerts/status')).json;
  assert.strictEqual(ss.sentTotal, 0);
  assert.strictEqual((await r[0].h.api('GET', '/api/alerts')).json.enabled, true);
});

test('RA-48 parada limpia: con un envío colgado a Telegram, SIGTERM termina el proceso sin esperar a Telegram', async function () {
  var sim = await A.nuevoSim();
  sim.setDefault('sendMessage', R.silence());
  var h = await A.arrancar({ sim: sim, alerts: A.alertasActivas({ failsBeforeAlert: 1 }) });
  var c = await A.nuevoCtl(500);
  await A.nuevoObjetivo(h, 'Colgado', c);
  await A.esperar(function () { return sim.sent().length >= 1; }, 8000, 'envío en vuelo');
  var t0 = Date.now();
  var salida = await new Promise(function (resolve) {
    if (h.child.exitCode !== null) return resolve({ code: h.child.exitCode });
    var t = setTimeout(function () { resolve({ timeout: true }); }, 5000);
    h.child.once('exit', function (code, sig) { clearTimeout(t); resolve({ code: code, sig: sig }); });
    h.child.kill('SIGTERM');
  });
  assert.ok(!salida.timeout, 'el proceso no terminó en 5 s');
  assert.ok(Date.now() - t0 < 4000, 'tardó ' + (Date.now() - t0) + ' ms');
  assert.ok(salida.code === 0 || salida.sig === 'SIGTERM', JSON.stringify(salida));
});
