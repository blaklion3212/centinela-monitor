'use strict';
/*
 * Tipos de alerta seleccionables (2.5.0): motor de avisos (server/lib/notify.js) con reloj y canal falsos
 * (test/helpers/alerts-harness.js). Requisitos: RT-11 (límites), RT-12 (escritura), RT-13 (limpieza), RT-17 (cambios en
 * caliente), RT-21 (reinicio por tipo), RT-30 (formato por evento), RT-31 (agrupación y orden), RT-41 (activeByType),
 * RT-60 (privacidad) y RT-61 (entradas hostiles). Ninguna prueba espera tiempo real, toca la red ni escribe fuera de memoria.
 * Los resultados se construyen con el evaluador real (js/core/evaluate.js).
 */
var test = require('node:test');
var assert = require('node:assert');
var notify = require('../server/lib/notify');
var AT = require('../server/lib/alert-types');
var E = require('../js/core/evaluate.js');
var Defaults = require('../js/config/defaults.js');
var H = require('./helpers/alerts-harness');

var TH = Defaults.SETTINGS.thresholds;
var VENTANA = 31000; // un poco más que el GROUP_WINDOW_MS por omisión (30 s) para vaciar la ventana y el envío

var PING_OK = { sent: 4, received: 4, lossPct: 0, avg: 10, jitter: 1 };
function ping(o) { return Object.assign({}, PING_OK, o || {}); }
function agent(o) { return Object.assign({ cpu: { usagePct: 10, ioWaitPct: 1 }, mem: { usedPct: 10 }, disks: [], services: [] }, o || {}); }
function discos(lista) { return { agent: agent({ disks: lista.map(function (d) { return { mount: d[0], usedPct: d[1] }; }) }) }; }
function todos(v) { var n = {}; AT.NOTIFY_KEYS.forEach(function (k) { n[k] = v; }); return n; }
function notifyDe(over) { return Object.assign(todos(true), over || {}); }

// Motor con un objetivo («Portal») y N=1 salvo que se indique; todos los tipos activados.
function motor(o) {
  o = o || {};
  return H.harness({
    cfg: Object.assign({ failsBeforeAlert: 1, notify: notifyDe() }, o.cfg || {}),
    targets: o.targets, consts: o.consts, noStart: o.noStart, env: o.env
  });
}

// Emite un resultado construido con el evaluador (status y motivos reales).
function emitir(h, id, raw, ts) {
  var e = E.evaluate({ checks: { ping: true } }, raw, TH);
  var extra = Object.assign({ reasons: e.reasons }, raw);
  if (ts !== undefined) extra.ts = ts;
  h.emit(id, e.status, extra);
}
async function enviar(h) { await h.clock.advance(VENTANA); }
// Emite y deja que el aviso salga; devuelve los textos nuevos.
async function ciclo(h, raw, id) {
  var antes = h.chan.calls.length;
  emitir(h, id || 't1', raw);
  await enviar(h);
  return h.chan.texts().slice(antes);
}
function sinRastro(h) { return h.chan.texts().length; }

/* =============================================================================================
 * RT-30. Formato por evento, modo mínimo y completo
 * ========================================================================================== */

var MALO_DOWN = { ports: [{ port: 22, open: false }] };
var SANO = { ping: ping() };
// [descripción, resultado con el problema, resultado sano (null si no hay recuperación que probar), icono+etiqueta de alerta,
//  etiqueta de recuperación, fragmento del motivo en modo completo, motivo de recuperación]
var FORMATOS = [
  ['down', MALO_DOWN, SANO, '🔴 Portal: CAÍDO', '🟢 Portal: RECUPERADO', 'Puerto 22 cerrado', 'Servicio recuperado'],
  ['certExpired', { ssl: { daysLeft: -3 } }, { ssl: { daysLeft: 300 } }, '🔴 Portal: CERTIFICADO VENCIDO', '🟢 Portal: CERTIFICADO RENOVADO', 'Certificado vencido hace 3 días', 'Certificado renovado'],
  ['certExpiring warn', { ssl: { daysLeft: 20 } }, { ssl: { daysLeft: 300 } }, '🟠 Portal: CERTIFICADO POR VENCER', '🟢 Portal: CERTIFICADO RENOVADO', 'Certificado vence en 20 días', 'Certificado renovado'],
  ['certExpiring crit', { ssl: { daysLeft: 5 } }, { ssl: { daysLeft: 300 } }, '🔴 Portal: CERTIFICADO POR VENCER (URGENTE)', '🟢 Portal: CERTIFICADO RENOVADO', 'Certificado vence en 5 días', 'Certificado renovado'],
  ['certTrust', { ssl: { daysLeft: 300, authorized: false, authError: 'self signed' } }, { ssl: { daysLeft: 300, authorized: true } }, '🟠 Portal: CERTIFICADO NO CONFIABLE', '🟢 Portal: CERTIFICADO CONFIABLE', 'Certificado no confiable', 'Certificado confiable'],
  ['latency (latencia)', { ping: ping({ avg: 500 }) }, SANO, '🟠 Portal: LATENCIA ALTA', '🟢 Portal: LATENCIA NORMAL', 'Latencia 500 ms', 'Latencia normal'],
  ['latency (pérdida)', { ping: ping({ received: 2, lossPct: 50 }) }, SANO, '🟠 Portal: PÉRDIDA DE PAQUETES', '🟢 Portal: PÉRDIDA DE PAQUETES NORMAL', 'Pérdida de paquetes', 'Pérdida de paquetes normal'],
  ['latency (jitter)', { ping: ping({ jitter: 100 }) }, SANO, '🟠 Portal: JITTER ALTO', '🟢 Portal: JITTER NORMAL', 'Jitter 100 ms', 'Jitter normal'],
  ['latency (ttfb)', { http: { status: 200, ttfbMs: 3000 } }, { http: { status: 200, ttfbMs: 50 } }, '🟠 Portal: RESPUESTA LENTA', '🟢 Portal: RESPUESTA NORMAL', 'TTFB 3000 ms', 'Respuesta normal'],
  ['resources (cpu)', { agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 } }) }, { agent: agent() }, '🟠 Portal: CPU ALTA', '🟢 Portal: CPU NORMAL', 'CPU al 99 %', 'CPU normal'],
  ['resources (mem)', { agent: agent({ mem: { usedPct: 99 } }) }, { agent: agent() }, '🟠 Portal: MEMORIA ALTA', '🟢 Portal: MEMORIA NORMAL', 'Memoria al 99 %', 'Memoria normal'],
  ['resources (io)', { agent: agent({ cpu: { usagePct: 10, ioWaitPct: 50 } }) }, { agent: agent() }, '🟠 Portal: I/O LENTO', '🟢 Portal: I/O NORMAL', 'I/O wait 50 %', 'I/O normal'],
  ['disk warn', discos([['/var', 88]]), discos([['/var', 40]]), '🟠 Portal: ESPACIO EN DISCO BAJO', '🟢 Portal: ESPACIO EN DISCO NORMAL', 'Disco /var al 88 %', 'Disco /var: espacio normal'],
  ['disk crit', discos([['/var', 95]]), discos([['/var', 40]]), '🔴 Portal: ESPACIO EN DISCO CRÍTICO', '🟢 Portal: ESPACIO EN DISCO NORMAL', 'Disco /var al 95 %', 'Disco /var: espacio normal'],
  ['other (agente sin respuesta)', { agent: { error: 'caído' } }, { agent: agent() }, '🟠 Portal: DEGRADADO', '🟢 Portal: RECUPERADO', 'Agente sin respuesta (caído)', 'Servicio recuperado'],
  ['other (latencia en advertencia)', { ping: ping({ avg: 200 }) }, SANO, '🟠 Portal: DEGRADADO', '🟢 Portal: RECUPERADO', 'Latencia 200 ms', 'Servicio recuperado']
];

FORMATOS.forEach(function (f) {
  test('RT-30 ' + f[0] + ' en modo mínimo: una sola línea con icono y etiqueta, sin dirección, motivo, hora ni montaje (RT-60)', async function () {
    var h = motor();
    var t = await ciclo(h, f[1]);
    assert.deepStrictEqual(t, [f[3]]);
    assert.ok(!/Motivo|Dirección|Hora|10\.0\.0\.1|\/var/.test(t[0]), 'sin datos de más: ' + t[0]);
    var r = await ciclo(h, f[2]);
    assert.deepStrictEqual(r, [f[4]], 'recuperación');
  });

  test('RT-30 ' + f[0] + ' en modo completo: añade Dirección, Motivo del tipo y Hora (alerta y recuperación)', async function () {
    var h = motor({ cfg: { detail: 'full' } });
    var t = await ciclo(h, f[1]);
    assert.strictEqual(t.length, 1);
    var ls = t[0].split('\n');
    assert.strictEqual(ls[0], f[3]);
    assert.strictEqual(ls[1], 'Dirección: 10.0.0.1');
    assert.ok(ls[2].indexOf('Motivo: ') === 0 && ls[2].indexOf(f[5]) >= 0, 'motivo: ' + ls[2]);
    assert.ok(/^Hora: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ls[3]), ls[3]);
    assert.strictEqual(ls.length, 4);
    var r = await ciclo(h, f[2]);
    var lr = r[0].split('\n');
    assert.strictEqual(lr[0], f[4]);
    assert.strictEqual(lr[2], 'Motivo: ' + f[6], 'texto fijo de recuperación');
  });
});

test('RT-30 recuperación de una clave «legacy» heredada de 2.4.0: 🟢 RECUPERADO', async function () {
  var h = motor({ cfg: { alerted: { 't1|legacy': 'on' } } });
  assert.deepStrictEqual(await ciclo(h, SANO), ['🟢 Portal: RECUPERADO']);
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('RT-30 el motivo de «down» une los motivos down sin el del certificado vencido; el de «other» lleva solo el de su code', async function () {
  var h = motor({ cfg: { detail: 'full' } });
  var t = await ciclo(h, { ports: [{ port: 443, open: false }, { port: 22, open: false }], ssl: { daysLeft: -2 } });
  assert.strictEqual(t.length, 1);
  var motivos = t[0].split('\n').filter(function (l) { return /^ {3}Motivo: /.test(l); });
  var down = motivos.filter(function (l) { return /Puerto/.test(l); })[0];
  assert.ok(down.indexOf('Puerto 443') >= 0 && down.indexOf('Puerto 22') >= 0, down);
  assert.ok(down.indexOf('Certificado') < 0, 'el motivo de caída no incluye el certificado');
  var h2 = motor({ cfg: { detail: 'full' } });
  var t2 = await ciclo(h2, { ping: ping({ avg: 200, jitter: 40 }) });
  var l2 = t2[0].split('\n').filter(function (l) { return /Motivo/.test(l); });
  assert.strictEqual(l2.length, 2, 'dos avisos other, uno por code');
  assert.ok(l2.some(function (l) { return /Latencia 200/.test(l) && !/Jitter/.test(l); }));
  assert.ok(l2.some(function (l) { return /Jitter 40/.test(l) && !/Latencia/.test(l); }));
});

test('RT-30 / RT-61 nombre y montaje con caracteres de control o especiales no rompen líneas ni falsean avisos', async function () {
  var h = motor({ cfg: { detail: 'full' }, targets: [['t1', 'Por\ntal\u0000\u2028 <b>x</b> | %00', '10.0.0.1\nHack']] });
  var t = await ciclo(h, discos([['/a\nb\u0000|c<d>%00', 95]]));
  assert.strictEqual(t.length, 1);
  var ls = t[0].split('\n');
  assert.strictEqual(ls.length, 4, 'solo las 4 líneas esperadas: ' + JSON.stringify(ls));
  assert.ok(ls[0].indexOf('Por tal') >= 0 && !/[\u0000\u2028]/.test(t[0]));
  assert.ok(/^Motivo: Disco \/a b\s*c<d>%00 al 95 %$/.test(ls[2]) || ls[2].indexOf('Motivo: Disco /a') === 0, ls[2]);
  // El estado persistido tampoco se rompe: una clave con la subclave codificada.
  var claves = Object.keys(h.disk.cfg.alerted);
  assert.strictEqual(claves.length, 1);
  assert.ok(claves[0].split('|').length === 3, 'la clave conserva 3 segmentos: ' + claves[0]);
  // Y la recuperación sigue pudiendo encontrar la clave.
  var r = await ciclo(h, discos([['/a\nb\u0000|c<d>%00', 10]]));
  assert.strictEqual(r.length, 1);
  assert.ok(/ESPACIO EN DISCO NORMAL/.test(r[0]));
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('RT-30 / RT-61 un nombre de 10 000 caracteres se recorta (MAX_NAME) y el mensaje no excede el tope de Telegram', async function () {
  var h = motor({ cfg: { detail: 'full' }, targets: [['t1', new Array(10001).join('N'), 'http://' + new Array(5000).join('h') + '.test/']] });
  var t = await ciclo(h, MALO_DOWN);
  assert.ok(t[0].length <= 4096, 'longitud ' + t[0].length);
  assert.ok(t[0].length < 1500);
});

test('RT-30 la etiqueta de organización se conserva en los avisos por tipo', async function () {
  var h = motor({ targets: [['t1', 'Portal', '10.0.0.1', 'acme']] });
  assert.deepStrictEqual(await ciclo(h, discos([['/var', 95]])), ['🔴 [Cliente ACME] Portal: ESPACIO EN DISCO CRÍTICO']);
});

test('RT-60 el modo mínimo no incluye nunca el montaje, el servicio ni el texto del motivo', async function () {
  var h = motor();
  var t = await ciclo(h, Object.assign({ ports: [{ port: 22, open: false }] }, { agent: agent({ disks: [{ mount: '/secreto/montaje', usedPct: 95 }], services: [{ name: 'servicio-secreto', active: false }] }) }));
  assert.strictEqual(t.length, 1);
  assert.ok(!/secreto|montaje|servicio-|Motivo|Puerto|Disco \//.test(t[0]), t[0]);
});

/* =============================================================================================
 * RT-31. Agrupación y orden por prioridad
 * ========================================================================================== */

test('RT-31 un objetivo con puerto cerrado y disco crítico produce un mensaje de 2 líneas bajo «2 avisos»', async function () {
  var h = motor();
  var t = await ciclo(h, Object.assign({ ports: [{ port: 22, open: false }] }, discos([['/', 95]])));
  assert.deepStrictEqual(t, ['2 avisos\n🔴 Portal: CAÍDO\n🔴 Portal: ESPACIO EN DISCO CRÍTICO']);
  assert.strictEqual(h.chan.calls.length, 1, 'un solo mensaje');
});

test('RT-31 «N avisos» cuenta avisos, no objetivos (un solo objetivo con cuatro tipos)', async function () {
  var h = motor();
  var t = await ciclo(h, Object.assign({ ssl: { daysLeft: -1, authorized: false } }, discos([['/', 95]]), { ports: [{ port: 22, open: false }] }));
  assert.ok(/^4 avisos\n/.test(t[0]), t[0]);
  assert.strictEqual(t[0].split('\n').length, 5);
});

test('RT-31 un solo aviso se envía sin encabezado', async function () {
  var h = motor();
  var t = await ciclo(h, MALO_DOWN);
  assert.deepStrictEqual(t, ['🔴 Portal: CAÍDO']);
});

test('RT-31 orden por prioridad a igualdad de ts: down, certExpired, disk, resources, latency, certTrust, other', async function () {
  var h = motor();
  var raw = Object.assign({
    ports: [{ port: 22, open: false }], ssl: { daysLeft: -1, authorized: false }, ping: ping({ avg: 500 }), http: { status: 200, ttfbMs: 1000 }
  }, { agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 }, disks: [{ mount: '/', usedPct: 95 }] }) });
  var t = await ciclo(h, raw);
  var etiquetas = t[0].split('\n').slice(1).map(function (l) { return l.replace(/^.*Portal: /, ''); });
  assert.deepStrictEqual(etiquetas, ['CAÍDO', 'CERTIFICADO VENCIDO', 'ESPACIO EN DISCO CRÍTICO', 'CPU ALTA', 'LATENCIA ALTA', 'CERTIFICADO NO CONFIABLE', 'DEGRADADO']);
  assert.ok(/^7 avisos/.test(t[0]));
});

test('RT-31 certExpiring va entre down y disk en la prioridad', async function () {
  var h = motor();
  var t = await ciclo(h, Object.assign({ ports: [{ port: 22, open: false }], ssl: { daysLeft: 3 } }, discos([['/', 95]]), { ping: ping({ avg: 500 }) }));
  var etiquetas = t[0].split('\n').slice(1).map(function (l) { return l.replace(/^.*Portal: /, ''); });
  assert.deepStrictEqual(etiquetas, ['CAÍDO', 'CERTIFICADO POR VENCER (URGENTE)', 'ESPACIO EN DISCO CRÍTICO', 'LATENCIA ALTA']);
});

test('RT-31 las recuperaciones van al final de un grupo, tras los avisos del mismo instante', async function () {
  var h = motor({ cfg: { alerted: { 't1|latency|latency': 'on', 't1|down': 'on' } } });
  var t = await ciclo(h, Object.assign({ ping: ping() }, { agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 } }) }));
  var etiquetas = t[0].split('\n').slice(1).map(function (l) { return l.replace(/^.*Portal: /, ''); });
  assert.strictEqual(etiquetas[0], 'CPU ALTA');
  assert.deepStrictEqual(etiquetas.slice(1).sort(), ['LATENCIA NORMAL', 'RECUPERADO']);
});

test('RT-31 se ordena primero por ts: un aviso anterior va antes aunque tenga menos prioridad', async function () {
  var h = motor({ targets: [['a', 'Alfa'], ['b', 'Beta']] });
  var t0 = h.clock.now();
  emitir(h, 'b', MALO_DOWN, t0 + 2000);
  emitir(h, 'a', { ping: ping({ avg: 200 }) }, t0 + 1000);
  await enviar(h);
  assert.deepStrictEqual(h.chan.texts(), ['2 avisos\n🟠 Alfa: DEGRADADO\n🔴 Beta: CAÍDO']);
});

test('RT-31 agrupación entre objetivos y tipos: un mensaje por chat con todos los avisos de la ventana', async function () {
  var h = motor({ targets: [['a', 'Alfa'], ['b', 'Beta'], ['c', 'Gama']] });
  emitir(h, 'a', MALO_DOWN); emitir(h, 'b', discos([['/', 95]])); emitir(h, 'c', { ssl: { daysLeft: -1 } });
  await enviar(h);
  assert.strictEqual(h.chan.calls.length, 1);
  assert.ok(/^3 avisos\n/.test(h.chan.texts()[0]));
});

test('RT-31 se respeta MAX_GROUP_LINES (20) y el tope de TG_MAX_TEXT con muchos avisos de un objetivo', async function () {
  var lista = []; for (var i = 0; i < 40; i++) lista.push(['/mnt/disco-con-nombre-largo-' + i, 95]);
  var h = motor({ cfg: { detail: 'full' } });
  var t = await ciclo(h, discos(lista));
  assert.strictEqual(t.length, 1);
  assert.ok(/^40 avisos\n/.test(t[0]));
  assert.ok(/… y 20 más$/.test(t[0]), t[0].slice(-60));
  assert.ok(t[0].length <= 4096);
});

/* =============================================================================================
 * RT-21. «Chat coherente» tras reiniciar, por tipo
 * ========================================================================================== */

// [descripción, problema, sano, etiqueta de alerta]
var REINICIO = [
  ['down', MALO_DOWN, SANO, '🔴 Portal: CAÍDO'],
  ['certExpiring warn', { ssl: { daysLeft: 20 } }, { ssl: { daysLeft: 300 } }, '🟠 Portal: CERTIFICADO POR VENCER'],
  ['certExpiring crit', { ssl: { daysLeft: 5 } }, { ssl: { daysLeft: 300 } }, '🔴 Portal: CERTIFICADO POR VENCER (URGENTE)'],
  ['disk en dos particiones', discos([['/', 88], ['/var', 95]]), discos([['/', 10], ['/var', 10]]), '2 avisos'],
  ['latency', { ping: ping({ avg: 500 }) }, SANO, '🟠 Portal: LATENCIA ALTA'],
  ['certExpired', { ssl: { daysLeft: -2 } }, { ssl: { daysLeft: 300 } }, '🔴 Portal: CERTIFICADO VENCIDO'],
  ['resources', { agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 } }) }, { agent: agent() }, '🟠 Portal: CPU ALTA']
];

REINICIO.forEach(function (f) {
  test('RT-21 ' + f[0] + ': tras reiniciar con la condición activa no se repite el aviso y su recuperación pendiente sí se avisa', async function () {
    var h = motor({ cfg: { failsBeforeAlert: 2 } });
    emitir(h, 't1', f[1]); emitir(h, 't1', f[1]);
    await enviar(h);
    assert.strictEqual(h.chan.texts().length, 1);
    assert.ok(h.chan.texts()[0].indexOf(f[3]) >= 0, h.chan.texts()[0]);
    assert.ok(Object.keys(h.disk.cfg.alerted).length >= 1, 'estado guardado en disco');
    h.restart();
    for (var i = 0; i < 4; i++) emitir(h, 't1', f[1]);
    await enviar(h);
    assert.strictEqual(h.chan.texts().length, 1, 'sin repetir tras el reinicio: ' + h.chan.texts().join(' || '));
    var r = await ciclo(h, f[2]);
    assert.strictEqual(r.length, 1);
    assert.ok(/🟢/.test(r[0]), 'recuperación avisada: ' + r[0]);
    assert.deepStrictEqual(h.disk.cfg.alerted, {}, 'estado vacío tras la recuperación');
  });

  test('RT-21 ' + f[0] + ': si la condición desapareció durante el reinicio, se avisa la recuperación en el primer resultado', async function () {
    var h = motor({ cfg: { failsBeforeAlert: 1 } });
    await ciclo(h, f[1]);
    h.restart();
    var r = await ciclo(h, f[2]);
    assert.strictEqual(r.length, 1);
    assert.ok(/🟢/.test(r[0]), r[0]);
  });

  test('RT-21 ' + f[0] + ': una condición activa sin clave guardada (aviso perdido) se avisa tras N resultados contados desde cero', async function () {
    var h = motor({ cfg: { failsBeforeAlert: 2 } });
    emitir(h, 't1', f[1]); emitir(h, 't1', f[1]);
    await enviar(h);
    h.disk.cfg.alerted = {}; // el aviso se perdió: no hay clave
    h.restart();
    emitir(h, 't1', f[1]);
    await enviar(h);
    assert.strictEqual(h.chan.texts().length, 1, 'con N=2 el primer resultado no avisa');
    emitir(h, 't1', f[1]);
    await enviar(h);
    assert.strictEqual(h.chan.texts().length, 2, 'al segundo avisa');
    assert.ok(h.chan.texts()[1].indexOf(f[3]) >= 0);
  });
});

test('RT-21 las claves de tipos desactivados se eliminan en silencio en el primer resultado tras reiniciar', async function () {
  var h = motor({ cfg: { alerted: { 't1|disk|%2Fvar': 'warn', 't1|latency|latency': 'on' }, notify: notifyDe({ disk: false }) } });
  var antes = h.chan.calls.length;
  emitir(h, 't1', Object.assign({ ping: ping({ avg: 500 }) }, discos([['/var', 88]])));
  await enviar(h);
  assert.strictEqual(h.chan.calls.length, antes, 'sin mensajes');
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted), ['t1|latency|latency']);
});

test('RT-21 las claves de tipos desactivados se eliminan en silencio AL CARGAR (antes de cualquier resultado)', async function () {
  var h = motor({ cfg: { alerted: { 't1|disk|%2Fvar': 'warn', 't1|latency|latency': 'on' }, notify: notifyDe({ disk: false }) } });
  await h.clock.advance(5000);
  assert.strictEqual(h.chan.calls.length, 0);
  assert.strictEqual(h.notifier.status().activeByType.disk, 0, 'activeByType.disk tras cargar con el tipo desactivado');
});

/* =============================================================================================
 * RT-11. Límites del estado avisado
 * ========================================================================================== */

test('RT-11 70 particiones en un objetivo: los 70 avisos se envían, solo 64 claves se persisten y se cuenta en alertedLimitHits', async function () {
  var lista = []; for (var i = 0; i < 70; i++) lista.push(['/m' + i, 95]);
  var h = motor();
  var t = await ciclo(h, discos(lista));
  assert.strictEqual(t.length, 1);
  assert.ok(/^70 avisos\n/.test(t[0]), 'se envían los 70 avisos');
  var claves = Object.keys(h.disk.cfg.alerted);
  assert.strictEqual(claves.length, 64, 'solo 64 persistidas');
  assert.strictEqual(h.notifier.status().alertedLimitHits, 6);
});

test('RT-11 al alcanzar el límite se escribe una sola línea de log por episodio y sin nombres de partición ni de objetivo (RT-60)', async function () {
  var lista = []; for (var i = 0; i < 70; i++) lista.push(['/secreta' + i, 95]);
  var h = motor({ targets: [['t1', 'NombreSecreto', '10.0.0.1']] });
  await ciclo(h, discos(lista));
  await ciclo(h, discos(lista));
  await ciclo(h, discos(lista));
  var lineas = h.logs.filter(function (l) { return /Límite de avisos recordados alcanzado/.test(l); });
  assert.strictEqual(lineas.length, 1, 'una sola línea: ' + h.logs.join(' | '));
  assert.ok(!h.logs.some(function (l) { return /secreta|NombreSecreto/.test(l); }), 'el log no contiene particiones ni nombres');
});

test('RT-11 las claves que superaron el límite no hacen repetir su aviso en los resultados siguientes', async function () {
  var lista = []; for (var i = 0; i < 70; i++) lista.push(['/m' + i, 95]);
  var h = motor();
  await ciclo(h, discos(lista));
  var enviados = h.chan.texts().length;
  for (var k = 0; k < 3; k++) emitir(h, 't1', discos(lista));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, enviados, 'sin repeticiones');
});

test('RT-11 con 5000 claves ya guardadas (tope global) un aviso nuevo se envía pero su clave no se persiste', async function () {
  var alerted = {};
  for (var i = 0; i < 5000; i++) alerted['x' + Math.floor(i / 50) + '_' + (i % 50) + '|down'] = 'on'; // objetivos ajenos, 1 clave cada uno
  var h = motor({ cfg: { alerted: alerted } });
  var t = await ciclo(h, MALO_DOWN);
  assert.deepStrictEqual(t, ['🔴 Portal: CAÍDO'], 'el aviso se envía igualmente');
  assert.strictEqual(Object.keys(h.disk.cfg.alerted).filter(function (k) { return /^t1\|/.test(k); }).length, 0, 'la clave no se persistió');
  assert.strictEqual(Object.keys(h.disk.cfg.alerted).length, 5000);
  assert.strictEqual(h.notifier.status().alertedLimitHits, 1);
  assert.strictEqual(h.logs.filter(function (l) { return /Límite de avisos/.test(l); }).length, 1);
});

test('RT-11 tras liberar claves, un nuevo episodio de límite vuelve a registrar su línea de log', async function () {
  var lista = []; for (var i = 0; i < 70; i++) lista.push(['/m' + i, 95]);
  var sanas = lista.map(function (d) { return [d[0], 10]; });
  var h = motor();
  await ciclo(h, discos(lista));
  await ciclo(h, discos(sanas));
  assert.deepStrictEqual(h.disk.cfg.alerted, {}, 'todas las claves se recuperaron');
  await ciclo(h, discos(lista));
  assert.strictEqual(h.logs.filter(function (l) { return /Límite de avisos/.test(l); }).length, 2, 'una línea por episodio');
});

/* =============================================================================================
 * RT-41 / RT-60. activeByType
 * ========================================================================================== */

test('RT-41 status().activeByType cuenta las claves persistidas por tipo e incluye los 8 tipos con cero', async function () {
  var h = motor();
  var st0 = h.notifier.status();
  assert.deepStrictEqual(st0.activeByType, { down: 0, certExpired: 0, certExpiring: 0, certTrust: 0, latency: 0, resources: 0, disk: 0, other: 0 });
  await ciclo(h, Object.assign({ ports: [{ port: 22, open: false }], ping: ping({ avg: 200 }) }, discos([['/', 88], ['/var', 95]])));
  assert.deepStrictEqual(h.notifier.status().activeByType, { down: 1, certExpired: 0, certExpiring: 0, certTrust: 0, latency: 0, resources: 0, disk: 2, other: 1 });
});

test('RT-41 activeByType cuenta como «down» las claves migradas (nivel m)', function () {
  var h = motor({ cfg: { alerted: { 't1|down': 'm' } } });
  assert.strictEqual(h.notifier.status().activeByType.down, 1);
});

test('RT-60 el estado público no contiene ids de objetivo, nombres ni particiones', async function () {
  var h = motor({ targets: [['objetivo-secreto-1', 'NombreSecreto', '10.0.0.1']] });
  await ciclo(h, discos([['/particion-secreta', 95]]), 'objetivo-secreto-1');
  var txt = JSON.stringify(h.notifier.status());
  assert.ok(!/objetivo-secreto|NombreSecreto|particion-secreta|%2F/.test(txt), txt);
  assert.ok(!('alerted' in h.notifier.status()));
});

/* =============================================================================================
 * RT-12 y RT-13. Escritura y limpieza en el motor
 * ========================================================================================== */

test('RT-12 el estado se guarda de forma diferida y coalescida, y solo cuando cambia', async function () {
  var h = motor({ targets: [['a', 'Alfa'], ['b', 'Beta'], ['c', 'Gama']] });
  var s0 = h.disk.saves;
  emitir(h, 'a', MALO_DOWN); emitir(h, 'b', MALO_DOWN); emitir(h, 'c', MALO_DOWN);
  assert.strictEqual(h.disk.saves, s0, 'nada se guarda de inmediato');
  await enviar(h);
  assert.strictEqual(h.disk.saves, s0 + 1, 'una sola escritura para los tres cambios');
  emitir(h, 'a', MALO_DOWN); emitir(h, 'b', MALO_DOWN);
  await enviar(h);
  assert.strictEqual(h.disk.saves, s0 + 1, 'sin cambios no se escribe');
});

test('RT-12 al desactivar la función se vacía `alerted` de inmediato', async function () {
  var h = motor();
  await ciclo(h, MALO_DOWN);
  assert.ok(Object.keys(h.disk.cfg.alerted).length);
  h.disk.cfg.enabled = false; h.notifier.reload();
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('RT-13 prune: borrar un objetivo elimina todas sus claves y contadores sin avisar recuperación', async function () {
  var h = motor({ targets: [['a', 'Alfa'], ['b', 'Beta']] });
  emitir(h, 'a', Object.assign({ ports: [{ port: 22, open: false }], ping: ping({ avg: 500 }) }, discos([['/', 95], ['/var', 88]])));
  emitir(h, 'b', MALO_DOWN);
  await enviar(h);
  var antes = h.chan.texts().length;
  assert.ok(Object.keys(h.disk.cfg.alerted).filter(function (k) { return /^a\|/.test(k); }).length >= 4);
  h.store.remove('a');
  h.notifier.prune();
  await enviar(h);
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted), ['b|down']);
  assert.strictEqual(h.chan.texts().length, antes, 'sin mensajes de recuperación');
});

test('RT-13 prune: un objetivo con id que es prefijo de otro no se lleva las claves del otro', async function () {
  var h = motor({ targets: [['a', 'Alfa'], ['ab', 'AlfaBeta']] });
  emitir(h, 'a', MALO_DOWN); emitir(h, 'ab', MALO_DOWN);
  await enviar(h);
  h.store.remove('a'); h.notifier.prune();
  await enviar(h);
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted), ['ab|down']);
});

test('RT-13 un objetivo deshabilitado conserva sus claves y pierde sus contadores', async function () {
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  emitir(h, 't1', discos([['/', 95]]));
  h.store.findTarget('t1').enabled = false;
  h.notifier.prune();
  h.store.findTarget('t1').enabled = true;
  emitir(h, 't1', discos([['/', 95]]));
  await enviar(h);
  assert.strictEqual(h.chan.calls.length, 0, 'el contador se perdió: este es el primer resultado');
  emitir(h, 't1', discos([['/', 95]]));
  await enviar(h);
  assert.strictEqual(h.chan.calls.length, 1);
  // Con claves: se conservan aunque esté deshabilitado.
  h.store.findTarget('t1').enabled = false; h.notifier.prune();
  assert.ok(Object.keys(h.disk.cfg.alerted).some(function (k) { return /^t1\|disk/.test(k); }));
});

test('RT-13 / RT-17 desactivar un tipo en caliente elimina sus claves en silencio y no avisa recuperaciones', async function () {
  var h = motor();
  await ciclo(h, Object.assign({ ping: ping({ avg: 500 }) }, discos([['/', 95]])));
  var antes = h.chan.texts().length;
  h.disk.cfg.notify = notifyDe({ disk: false });
  h.notifier.reload();
  await enviar(h);
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted), ['t1|latency|latency']);
  assert.strictEqual(h.notifier.status().activeByType.disk, 0);
  var r = await ciclo(h, Object.assign({ ping: ping({ avg: 500 }) }, discos([['/', 95]])));
  assert.deepStrictEqual(r, [], 'el tipo desactivado no avisa ni recupera');
  assert.strictEqual(h.chan.texts().length, antes);
});

test('RT-17 reactivar un tipo parte de contadores a cero: un problema ya existente se avisa tras N resultados', async function () {
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  emitir(h, 't1', discos([['/', 95]])); emitir(h, 't1', discos([['/', 95]]));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, 1);
  h.disk.cfg.notify = notifyDe({ disk: false }); h.notifier.reload();
  emitir(h, 't1', discos([['/', 95]]));
  await enviar(h);
  h.disk.cfg.notify = notifyDe(); h.notifier.reload();
  emitir(h, 't1', discos([['/', 95]]));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, 1, 'el primer resultado tras reactivar no avisa');
  emitir(h, 't1', discos([['/', 95]]));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, 2, 'al llegar a N avisa de nuevo, aunque se avisara antes');
});

test('RT-17 los avisos ya en ventana de agrupación se envían igualmente aunque se desactive el tipo', async function () {
  var h = motor();
  emitir(h, 't1', discos([['/', 95]]));
  h.disk.cfg.notify = notifyDe({ disk: false }); h.notifier.reload();
  await enviar(h);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: ESPACIO EN DISCO CRÍTICO']);
});

test('RT-17 el cambio de «recovery» en caliente se aplica a los resultados siguientes (clave eliminada en silencio)', async function () {
  var h = motor();
  await ciclo(h, MALO_DOWN);
  h.disk.cfg.notify = notifyDe({ recovery: false }); h.notifier.reload();
  assert.deepStrictEqual(await ciclo(h, SANO), []);
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('RT-19 (motor) sin resultados nuevos no hay mensajes; la histéresis de 2 puntos retiene la partición hasta bajar de 83 %', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, notify: notifyDe() } });
  emitir(h, 't1', discos([['/', 88]]));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, 1);
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.texts().length, 1, 'sin resultados nuevos no hay mensajes');
  emitir(h, 't1', discos([['/', 84]]));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, 1, '84 %: dentro de la histéresis de 2 puntos, sin recuperación');
  emitir(h, 't1', discos([['/', 80]]));
  await enviar(h);
  assert.strictEqual(h.chan.texts().length, 2);
});

test('Cambio de chat general: se olvidan todas las claves (sección 5)', async function () {
  var h = motor();
  await ciclo(h, Object.assign({ ports: [{ port: 22, open: false }] }, discos([['/', 95]])));
  assert.ok(Object.keys(h.disk.cfg.alerted).length >= 2);
  h.disk.cfg.chatId = '-100999'; h.notifier.reload();
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('RT-03 / RT-14 un resultado «unknown» no tiene efecto en el motor (ni avisos, ni claves, ni recuperaciones)', async function () {
  var h = motor({ cfg: { alerted: { 't1|down': 'on' } } });
  h.emit('t1', 'unknown', { reasons: [] });
  await enviar(h);
  assert.strictEqual(h.chan.calls.length, 0);
  assert.deepStrictEqual(h.disk.cfg.alerted, { 't1|down': 'on' });
});

test('RT-02 solo certificado vencido: un único mensaje «CERTIFICADO VENCIDO» y nunca «CAÍDO» (motor)', async function () {
  var h = motor({ cfg: { failsBeforeAlert: 2 } });
  emitir(h, 't1', { ssl: { daysLeft: -2 } }); emitir(h, 't1', { ssl: { daysLeft: -2 } }); emitir(h, 't1', { ssl: { daysLeft: -2 } });
  await enviar(h);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: CERTIFICADO VENCIDO']);
});

test('RT-02 certificado vencido con certExpired desactivado y down activado: no se envía nada (motor)', async function () {
  var h = motor({ cfg: { notify: notifyDe({ certExpired: false }) } });
  assert.deepStrictEqual(await ciclo(h, { ssl: { daysLeft: -2 } }), []);
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('sin red ni esperas reales: el motor del arnés no deja temporizadores pendientes tras vaciar', async function () {
  var h = motor();
  await ciclo(h, MALO_DOWN);
  await h.clock.advance(60000);
  assert.strictEqual(h.clock.pending(), 0);
  assert.strictEqual(typeof notify.create, 'function');
  assert.strictEqual(sinRastro(h), 1);
});

/* =============================================================================================
 * RT-18. Los umbrales de Ajustes llegan al motor como función (opts.thresholds)
 * ========================================================================================== */

test('RT-18 los umbrales de Ajustes se leen en cada resultado: subir diskWarnPct recupera sin mensajes propios del cambio', async function () {
  var EventEmitter = require('events').EventEmitter;
  var cfgMod = require('../server/lib/alerts-config');
  var clock = H.fakeClock(), chan = H.fakeChannel(clock), sched = new EventEmitter(), store = H.fakeTargets();
  store.add('t1', 'Portal', '10.0.0.1');
  var disco = { cfg: H.baseCfg({ failsBeforeAlert: 1, notify: notifyDe() }) };
  var umbrales = Object.assign({}, TH);
  var alertsStore = {
    load: function () { return JSON.parse(JSON.stringify(disco.cfg)); },
    save: function (c) { disco.cfg = JSON.parse(JSON.stringify(c)); },
    cfgApi: cfgMod
  };
  var n = notify.create({ store: store, alertsStore: alertsStore, channel: chan, env: {}, log: function () {}, clock: clock,
    thresholds: function () { return umbrales; } });
  n.start(sched);
  function res(raw, th) {
    var e = E.evaluate({ checks: { ping: true } }, raw, th);
    sched.emit('result', Object.assign({ id: 't1', ts: clock.now(), status: e.status, reasons: e.reasons }, raw));
  }
  res(discos([['/', 88]]), umbrales);
  await clock.advance(VENTANA);
  assert.strictEqual(chan.texts().length, 1);
  umbrales = Object.assign({}, TH, { diskWarnPct: 95, diskCritPct: 98 }); // el administrador sube los umbrales
  await clock.advance(120000);
  assert.strictEqual(chan.texts().length, 1, 'el cambio de umbrales no genera mensajes por sí mismo');
  res(discos([['/', 88]]), umbrales);
  await clock.advance(VENTANA);
  assert.deepStrictEqual(chan.texts().slice(1), ['🟢 Portal: ESPACIO EN DISCO NORMAL'], '88 % < 95 - 2: recupera con los umbrales nuevos');
  n.stop();
});
