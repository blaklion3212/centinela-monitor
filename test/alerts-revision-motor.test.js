'use strict';
/*
 * Alertas por Telegram: motor de avisos (server/lib/notify.js) y canal (clasificación), correcciones de la revisión de calidad y
 * seguridad: QA-A1, QA-A2, QA-A4/SEC-A8, QA-A6, QA-A7, QA-A8, QA-A9, QA-A12, SEC-A1, SEC-A2 y SEC-A3. Reloj falso y canal falso
 * (helpers/alerts-harness.js): ninguna prueba espera tiempo real, toca disco ni red.
 */
var test = require('node:test');
var assert = require('node:assert');
var notify = require('../server/lib/notify');
var tg = require('../server/lib/channels/telegram');
var H = require('./helpers/alerts-harness');

var OK = { ok: true, result: { message_id: 1 } };
function err(code, extra) { return Object.assign({ ok: false, code: code, message: 'Fallo ' + code, transient: false }, extra || {}); }
function trans(code, extra) { return err(code, Object.assign({ transient: true }, extra || {})); }
function item(status, name, o) { return Object.assign({ status: status, name: name, label: '', address: '', reason: '', ts: 1700000000000 }, o || {}); }
var VENTANA = 30000; // GROUP_WINDOW_MS por omisión

/* =============================================================================================
 * QA-A1: tope de esperas por 429
 * ========================================================================================== */

test('QA-A1 tras MAX_RATE_RETRIES respuestas 429 seguidas el mensaje se descarta (failedTotal) y nunca se envía antes del retry_after', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, consts: { MAX_RATE_RETRIES: 2 } });
  for (var i = 0; i < 6; i++) h.chan.program(trans('rate_limited', { retryAfterS: 5 }));
  h.down();
  await h.clock.advance(VENTANA + 60000);
  var c = h.chan.calls;
  assert.strictEqual(c.length, 3, 'envío inicial + 2 esperas por 429; el tercer 429 descarta: ' + c.length);
  for (var k = 1; k < c.length; k++) assert.ok(c[k].t - c[k - 1].t >= 5000, 'envío ' + k + ' tras ' + (c[k].t - c[k - 1].t) + ' ms (se pidieron 5000)');
  var st = h.notifier.status();
  assert.strictEqual(st.failedTotal, 1); assert.strictEqual(st.droppedTotal, 0); assert.strictEqual(st.sentTotal, 0);
  assert.strictEqual(st.queued, 0, 'la cola queda vacía');
  await h.clock.advance(600000);
  assert.strictEqual(h.chan.calls.length, 3, 'no hay más reintentos del mensaje descartado');
});

test('QA-A1 el descarte por tope de 429 no libera al siguiente mensaje antes de la espera pedida por Telegram', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, consts: { MAX_RATE_RETRIES: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  for (var i = 0; i < 2; i++) h.chan.program(trans('rate_limited', { retryAfterS: 30 }));
  h.chan.program(OK);
  h.down('a');
  await h.clock.advance(VENTANA);
  h.down('b');
  await h.clock.advance(VENTANA + 120000);
  var c = h.chan.calls;
  assert.strictEqual(c.length, 3);
  assert.ok(/Alfa/.test(c[0].text) && /Alfa/.test(c[1].text) && /Beta/.test(c[2].text), 'Alfa dos veces y luego Beta: ' + JSON.stringify(h.chan.texts()));
  assert.ok(c[1].t - c[0].t >= 30000);
  assert.ok(c[2].t - c[1].t >= 30000, 'Beta espera también los 30 s del último 429: ' + (c[2].t - c[1].t));
  assert.strictEqual(h.notifier.status().failedTotal, 1); assert.strictEqual(h.notifier.status().sentTotal, 1);
});

/* =============================================================================================
 * QA-A2: alternar down/degraded no repite avisos (notifyDegraded = true)
 * ========================================================================================== */

test('QA-A2 decide: tras un aviso, alternar down/degraded no genera avisos repetidos', function () {
  var cfg = { failsBeforeAlert: 2, notifyRecovery: true, notifyDegraded: true };
  var p = { fails: 0, downFails: 0, alerted: null }, acciones = [];
  ['down', 'down', 'degraded', 'down', 'degraded', 'down', 'degraded', 'degraded', 'down'].forEach(function (s) {
    var d = notify.decide(p, s, cfg); acciones.push(d.action); p = d.next;
  });
  assert.deepStrictEqual(acciones, [null, 'down', null, null, null, null, null, null, null]);
  assert.strictEqual(p.alerted, 'down');
});

test('QA-A2 decide: degraded avisado -> down exige N down seguidos; down avisado -> degraded no avisa', function () {
  var cfg = { failsBeforeAlert: 3, notifyRecovery: true, notifyDegraded: true };
  function run(list) { var p = { fails: 0, downFails: 0, alerted: null }, out = []; list.forEach(function (s) { var d = notify.decide(p, s, cfg); out.push(d.action); p = d.next; }); return out; }
  assert.deepStrictEqual(run(['degraded', 'degraded', 'degraded', 'down', 'degraded', 'down', 'down', 'down']),
    [null, null, 'degraded', null, null, null, null, 'down'], 'solo el tercer down seguido sube a CAÍDO');
  assert.deepStrictEqual(run(['down', 'down', 'down', 'degraded', 'degraded', 'degraded', 'degraded']),
    [null, null, 'down', null, null, null, null], 'down avisado no baja a DEGRADADO');
  assert.deepStrictEqual(run(['down', 'down', 'down', 'degraded', 'up']), [null, null, 'down', null, 'up'], 'la recuperación sí se avisa');
});

test('QA-A2 motor: alternar down/degraded tras un aviso no produce mensajes nuevos; la subida degraded -> down avisa una sola vez', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 2, notifyDegraded: true } });
  h.down(); h.down();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 1);
  assert.match(h.chan.texts()[0], /CAÍDO/);
  ['degraded', 'down', 'degraded', 'down', 'degraded', 'degraded', 'down'].forEach(function (s) { h.emit('t1', s); });
  await h.clock.advance(VENTANA * 3);
  assert.strictEqual(h.chan.calls.length, 1, 'ningún aviso repetido: ' + JSON.stringify(h.chan.texts()));

  var g = H.harness({ cfg: { failsBeforeAlert: 2, notifyDegraded: true } });
  g.emit('t1', 'degraded'); g.emit('t1', 'degraded');
  await g.clock.advance(VENTANA);
  assert.match(g.chan.texts()[0], /DEGRADADO/);
  g.down(); g.emit('t1', 'degraded'); g.down();
  await g.clock.advance(VENTANA * 2);
  assert.strictEqual(g.chan.calls.length, 1, 'down aislados no suben la gravedad');
  g.down(); g.down();
  await g.clock.advance(VENTANA * 2);
  assert.strictEqual(g.chan.calls.length, 2);
  assert.match(g.chan.texts()[1], /CAÍDO/);
});

/* =============================================================================================
 * QA-A4 / SEC-A8: guardado diferido y coalescido de `alerted`
 * ========================================================================================== */

test('QA-A4 varias altas de `alerted` en ráfaga producen una sola escritura tras ~500 ms', async function () {
  var ids = ['a', 'b', 'c', 'd', 'e'];
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: ids.map(function (i) { return [i, 'Srv-' + i]; }) });
  var s0 = h.disk.saves;
  ids.forEach(function (i) { h.down(i); });
  await h.clock.advance(0);
  assert.strictEqual(h.disk.saves, s0, 'nada se escribe de inmediato');
  await h.clock.advance(499);
  assert.strictEqual(h.disk.saves, s0, 'aún no han pasado 500 ms');
  await h.clock.advance(1);
  assert.strictEqual(h.disk.saves, s0 + 1, 'una única escritura para cinco cambios');
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted).sort(), ids);
  await h.clock.advance(5000);
  assert.strictEqual(h.disk.saves, s0 + 1, 'sin más cambios no hay más escrituras (el temporizador no queda armado)');
});

test('QA-A4 SEC-A8 stop() fuerza la escritura pendiente de `alerted` y no deja temporizadores de guardado', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'A'], ['b', 'B']] });
  var s0 = h.disk.saves;
  h.down('a'); h.down('b');
  assert.strictEqual(h.disk.saves, s0);
  h.notifier.stop();
  assert.strictEqual(h.disk.saves, s0 + 1, 'stop escribe lo pendiente');
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted).sort(), ['a', 'b']);
  await h.clock.advance(10000);
  assert.strictEqual(h.disk.saves, s0 + 1, 'ninguna escritura posterior');
  assert.strictEqual(h.clock.pending(), 0, 'sin temporizadores colgados');
});

test('QA-A4 un reinicio tras stop() recupera `alerted` del disco y avisa la recuperación', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.down();
  h.restart(); // restart llama a stop(): el cambio pendiente llega al "disco"
  assert.strictEqual(h.disk.cfg.alerted.t1, 'down');
  h.up();
  await h.clock.advance(VENTANA);
  assert.match(h.chan.texts()[0], /RECUPERADO/);
});

test('QA-A4 con un cambio de `alerted` que vuelve a su valor (alta y baja dentro de la ventana) solo hay una escritura', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  var s0 = h.disk.saves;
  h.down(); h.up();
  await h.clock.advance(600);
  assert.strictEqual(h.disk.saves, s0 + 1);
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

/* =============================================================================================
 * QA-A6: estructura por chat en chats privados
 * ========================================================================================== */

// El registro por chat (chats[k].log) es interno al motor y no se puede observar desde fuera. Se verifica indirectamente: el tope por
// minuto (TG_MAX_PER_MIN_GROUP) solo debe aplicar a chats de grupo (id negativo); si un chat privado acumulase entradas en ese registro,
// se frenaría como un grupo. Un chat privado con muchos envíos sigue limitado solo por el hueco mínimo entre mensajes.
async function enviarSeguidos(chatId, n) {
  var targets = [];
  for (var i = 0; i < n; i++) targets.push(['t' + i, 'Srv' + i]);
  var h = H.harness({ cfg: { failsBeforeAlert: 1, chatId: chatId }, consts: { GROUP_WINDOW_MS: 10, TG_MAX_PER_MIN_GROUP: 3 }, targets: targets });
  for (var k = 0; k < n; k++) { h.down('t' + k); await h.clock.advance(1100); }
  return h;
}

test('QA-A6 (indirecta) muchos envíos a un chat privado (id positivo) no se frenan por el tope por minuto de grupos', async function () {
  var h = await enviarSeguidos('555123', 8);
  assert.strictEqual(h.chan.calls.length, 8, 'los 8 salen en unos 9 s, sin esperar el minuto del tope de grupos');
  assert.ok(h.chan.calls.every(function (c) { return c.chat === '555123'; }));
  assert.strictEqual(h.notifier.status().sentTotal, 8);
});

test('QA-A6 (control) el mismo ritmo hacia un grupo (id negativo) SÍ se frena por el tope por minuto', async function () {
  var h = await enviarSeguidos('-100777', 8);
  assert.strictEqual(h.chan.calls.length, 3, 'solo 3 por minuto en grupos: ' + h.chan.calls.length);
  await h.clock.advance(60000);
  assert.ok(h.chan.calls.length > 3, 'el resto sale pasado el minuto');
});

/* =============================================================================================
 * QA-A7: deshabilitar un objetivo
 * ========================================================================================== */

test('QA-A7 deshabilitar un objetivo reinicia su contador de fallos', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 2 } });
  h.down(); // 1 de 2
  h.store.findTarget('t1').enabled = false;
  h.notifier.prune();
  h.store.findTarget('t1').enabled = true;
  h.down(); // si no se reinició serían 2 y avisaría
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 0, 'tras rehabilitar la racha empieza de cero');
  h.down();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 1, 'con N=2 down seguidos nuevos sí avisa');
});

test('QA-A7 deshabilitar conserva `alerted`: al rehabilitar y volver «up» se avisa la recuperación', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 2 } });
  h.down(); h.down();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 1);
  h.store.findTarget('t1').enabled = false;
  h.notifier.prune();
  await h.clock.advance(1000);
  assert.strictEqual(h.disk.cfg.alerted.t1, 'down', 'alerted se conserva');
  h.store.findTarget('t1').enabled = true;
  h.up();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 2);
  assert.match(h.chan.texts()[1], /RECUPERADO/);
});

test('QA-A7 prune sigue limpiando `alerted` de objetivos borrados pero no de los deshabilitados', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'A'], ['b', 'B']] });
  h.down('a'); h.down('b');
  await h.clock.advance(1000);
  h.store.findTarget('a').enabled = false;
  h.store.remove('b');
  h.notifier.prune();
  await h.clock.advance(1000);
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted), ['a']);
});

/* =============================================================================================
 * QA-A8: el 429 de un chat no retrasa a otro
 * ========================================================================================== */

test('QA-A8 un 429 en el chat general no retrasa los envíos al chat de otra organización', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, orgChats: { acme: '-100777' } }, targets: [['a', 'Principal1'], ['b', 'Acme1', '', 'acme']] });
  h.chan.program(trans('rate_limited', { retryAfterS: 60 }));
  h.down('a');
  h.down('b');
  await h.clock.advance(VENTANA);
  var c = h.chan.calls;
  assert.strictEqual(c[0].chat, '-100111');
  var acme = c.filter(function (x) { return x.chat === '-100777'; })[0];
  assert.ok(acme, 'el aviso de Acme salió');
  assert.ok(acme.t - c[0].t < 2000, 'sin esperar los 60 s del otro chat: ' + (acme.t - c[0].t) + ' ms');
  var t0 = c[0].t;
  await h.clock.advance(59000);
  assert.strictEqual(h.chan.calls.filter(function (x) { return x.chat === '-100111'; }).length, 1, 'el chat limitado espera su retry_after');
  await h.clock.advance(2000);
  var propios = h.chan.calls.filter(function (x) { return x.chat === '-100111'; });
  assert.strictEqual(propios.length, 2);
  assert.ok(propios[1].t - t0 >= 60000);
});

/* =============================================================================================
 * QA-A9: migración con mensajes encolados
 * ========================================================================================== */

test('QA-A9 tras migrar, el mensaje en vuelo, los encolados y los nuevos van al chat nuevo y en orden', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta'], ['c', 'Gama'], ['d', 'Delta'], ['e', 'Eps']] });
  h.chan.program({ hold: true });
  h.down('a'); await h.clock.advance(VENTANA);        // sale y queda en vuelo
  assert.strictEqual(h.chan.calls.length, 1);
  h.down('b'); await h.clock.advance(VENTANA);        // encolados detrás del que va en vuelo
  h.down('c'); await h.clock.advance(VENTANA);
  h.down('d');                                        // ventana de agrupación aún abierta con el id viejo
  assert.strictEqual(h.chan.calls.length, 1);
  h.chan.held[0](err('chat_not_found', { migrateTo: -1009998887776 }));
  await h.clock.advance(VENTANA + 20000);
  h.down('e'); await h.clock.advance(VENTANA + 5000);
  var c = h.chan.calls;
  assert.strictEqual(c[0].chat, '-100111');
  var resto = c.slice(1);
  assert.strictEqual(resto.length, 5, 'Alfa (reintento), Beta, Gama, Delta, Eps: ' + JSON.stringify(h.chan.texts()));
  assert.ok(resto.every(function (x) { return x.chat === '-1009998887776'; }), 'todos al chat nuevo: ' + JSON.stringify(resto.map(function (x) { return x.chat; })));
  assert.deepStrictEqual(resto.map(function (x) { return /(Alfa|Beta|Gama|Delta|Eps)/.exec(x.text)[1]; }), ['Alfa', 'Beta', 'Gama', 'Delta', 'Eps'], 'en orden');
  assert.strictEqual(h.disk.cfg.chatId, '-1009998887776');
  assert.strictEqual(h.notifier.status().sentTotal, 5);
});

test('QA-A9 tras migrar, el mensaje en vuelo, el de la ventana abierta y los nuevos van al chat nuevo y en orden', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta'], ['c', 'Gama']] });
  h.chan.program({ hold: true });
  h.down('a'); await h.clock.advance(VENTANA);        // sale y queda en vuelo
  h.down('b');                                        // ventana de agrupación aún abierta con el id viejo
  h.chan.held[0](err('chat_not_found', { migrateTo: -1009998887776 }));
  await h.clock.advance(VENTANA + 20000);
  h.down('c'); await h.clock.advance(VENTANA + 5000);
  var resto = h.chan.calls.slice(1);
  assert.strictEqual(h.chan.calls[0].chat, '-100111');
  assert.deepStrictEqual(resto.map(function (x) { return x.chat; }), ['-1009998887776', '-1009998887776', '-1009998887776']);
  assert.deepStrictEqual(resto.map(function (x) { return /(Alfa|Beta|Gama)/.exec(x.text)[1]; }), ['Alfa', 'Beta', 'Gama']);
  assert.strictEqual(h.notifier.status().sentTotal, 3); assert.strictEqual(h.notifier.status().failedTotal, 0);
});


/* =============================================================================================
 * QA-A12: contadores y estado de error
 * ========================================================================================== */

test('QA-A12 un error definitivo cuenta solo en failedTotal (no en droppedTotal) y deja el estado en «error»', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(err('blocked'));
  h.down();
  await h.clock.advance(VENTANA + 5000);
  var st = h.notifier.status();
  assert.strictEqual(st.failedTotal, 1); assert.strictEqual(st.droppedTotal, 0); assert.strictEqual(st.sentTotal, 0);
  assert.strictEqual(st.state, 'error');
  assert.strictEqual(st.lastError.code, 'blocked');
});

test('QA-A12 la cola llena cuenta en droppedTotal (no en failedTotal)', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, consts: { MAX_QUEUE: 2 }, targets: [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']] });
  h.chan.program({ hold: true });
  h.down('a'); await h.clock.advance(VENTANA);
  h.down('b'); await h.clock.advance(VENTANA);
  h.down('c'); await h.clock.advance(VENTANA);
  h.down('d'); await h.clock.advance(VENTANA);
  var st = h.notifier.status();
  assert.strictEqual(st.droppedTotal, 2); assert.strictEqual(st.failedTotal, 0);
  assert.strictEqual(st.queued, 2, 'el que va en vuelo y el más reciente');
});

test('QA-A12 reactivar las alertas reinicia el estado de error (failing y lastError)', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(err('blocked'));
  h.down();
  await h.clock.advance(VENTANA + 5000);
  assert.strictEqual(h.notifier.status().state, 'error');
  h.disk.cfg.enabled = false; h.notifier.reload();
  assert.strictEqual(h.notifier.status().state, 'off');
  h.disk.cfg.enabled = true; h.notifier.reload();
  var st = h.notifier.status();
  assert.strictEqual(st.state, 'ok');
  assert.strictEqual(st.lastError, null);
});

test('QA-A12 un envío correcto tras un error devuelve el estado a «ok»', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'A'], ['b', 'B']] });
  h.chan.program(err('blocked'), OK);
  h.down('a'); await h.clock.advance(VENTANA + 2000);
  assert.strictEqual(h.notifier.status().state, 'error');
  h.down('b'); await h.clock.advance(VENTANA + 2000);
  assert.strictEqual(h.notifier.status().state, 'ok');
});

/* =============================================================================================
 * SEC-A1: dirección en modo completo
 * ========================================================================================== */

function lineaDireccion(address) {
  var t = notify.formatMessage([item('down', 'Portal', { address: address, reason: 'sin respuesta' })], { detail: 'full' });
  var l = t.split('\n').filter(function (x) { return /^Dirección: /.test(x); })[0];
  return { texto: t, linea: l };
}

test('SEC-A1 modo completo: una URL con usuario, contraseña, query y fragmento se envía solo como protocolo://host:puerto/ruta', function () {
  var r = lineaDireccion('https://user:pass@host:8443/ruta?apikey=K#f');
  assert.strictEqual(r.linea, 'Dirección: https://host:8443/ruta');
  ['user', 'pass', 'apikey', 'K#', '#f', '?'].forEach(function (s) { assert.ok(r.texto.indexOf(s) < 0, 'no debe contener «' + s + '»: ' + r.texto); });
});

test('SEC-A1 modo completo: variantes de URL (sin ruta, solo usuario, solo query, ruta con puntos)', function () {
  assert.strictEqual(lineaDireccion('http://admin@10.0.0.5/panel?token=abc').linea, 'Dirección: http://10.0.0.5/panel');
  assert.strictEqual(lineaDireccion('https://host:8443?x=1').linea, 'Dirección: https://host:8443');
  assert.strictEqual(lineaDireccion('https://host/a/b.c?x=1&y=2#z').linea, 'Dirección: https://host/a/b.c');
  assert.strictEqual(lineaDireccion('https://host/').linea, 'Dirección: https://host/');
});

test('SEC-A1 modo completo: un host o una IP (sin esquema) se envía igual', function () {
  ['servidor.interno.local', '10.0.0.5', '192.168.1.20:8080', '2001:db8::1'].forEach(function (a) {
    assert.strictEqual(lineaDireccion(a).linea, 'Dirección: ' + a);
  });
});

test('SEC-A1 una URL que no se puede analizar también pierde las credenciales y la query', function () {
  var r = lineaDireccion('http://usr:clave@exa mple/x?k=secreto');
  assert.ok(r.linea, 'hay línea de dirección');
  ['usr', 'clave', 'secreto', 'k='].forEach(function (s) { assert.ok(r.linea.indexOf(s) < 0, 'no debe contener «' + s + '»: ' + r.linea); });
});

test('SEC-A1 modo mínimo: no se envía la dirección en absoluto', function () {
  var t = notify.formatMessage([item('down', 'Portal', { address: 'https://user:pass@host/x?k=1' })], { detail: 'minimal' });
  assert.ok(!/Dirección|user|pass|host/.test(t), t);
});

test('SEC-A1 de extremo a extremo con el motor: lo que llega al canal en modo completo no lleva credenciales', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, detail: 'full' }, targets: [['t1', 'Portal', 'https://user:pass@host:8443/ruta?apikey=K#f']] });
  h.down();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 1);
  assert.ok(h.chan.texts()[0].indexOf('Dirección: https://host:8443/ruta\n') >= 0, h.chan.texts()[0]);
  assert.ok(!/user|pass|apikey/.test(h.chan.texts()[0]));
});

/* =============================================================================================
 * SEC-A2: saltos de línea en nombres y motivos
 * ========================================================================================== */

var SALTOS = /[\n\r\u2028\u2029]/;

test('SEC-A2 un nombre con \\n, \\r y U+2028 no produce líneas nuevas en el mensaje mínimo', function () {
  var nombre = 'Falso\n🟢 Otro: RECUPERADO\r\nMás\u2028y\u2029más';
  var t = notify.formatMessage([item('down', nombre)], { detail: 'minimal' });
  assert.ok(!SALTOS.test(t), JSON.stringify(t));
  assert.strictEqual(t.split('\n').length, 1);
  assert.match(t, /^🔴 Falso/);
  assert.match(t, /: CAÍDO$/);
});

test('SEC-A2 modo completo: nombre, etiqueta, dirección y motivo con saltos mantienen exactamente 4 líneas (cabecera, dirección, motivo, hora)', function () {
  var it = item('down', 'Nom\nbre', { label: 'Org\r\nX', address: '10.0.0.1\nMotivo: falso', reason: 'a\nb\u2028c' });
  var t = notify.formatMessage([it], { detail: 'full' });
  assert.ok(!/[\r\u2028\u2029]/.test(t));
  var lineas = t.split('\n');
  assert.strictEqual(lineas.length, 4, JSON.stringify(lineas));
  assert.deepStrictEqual(lineas.map(function (l) { return l.split(':')[0].replace(/^.* /, ''); }).slice(1), ['Dirección', 'Motivo', 'Hora']);
});

test('SEC-A2 en un aviso agrupado cada elemento sigue ocupando una línea y no se falsean otros', function () {
  var t = notify.formatMessage([item('down', 'A\n🟢 Falso: RECUPERADO', { ts: 1 }), item('down', 'B\u2028C', { ts: 2 })], { detail: 'minimal' });
  var lineas = t.split('\n');
  assert.strictEqual(lineas.length, 3, JSON.stringify(lineas));
  assert.strictEqual(lineas[0], '2 avisos');
  assert.ok(!/[\r\u2028\u2029]/.test(t));
});

test('SEC-A2 de extremo a extremo con el motor: el objetivo con saltos en el nombre llega en una sola línea', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['t1', 'Malo\n🟢 Bueno: RECUPERADO\u2028x', '10.0.0.1']] });
  h.down();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 1);
  assert.strictEqual(h.chan.texts()[0].split('\n').length, 1);
  assert.ok(!SALTOS.test(h.chan.texts()[0]));
});

/* =============================================================================================
 * SEC-A3: migrate_to_chat_id no válido
 * ========================================================================================== */

var INVALIDOS = [' 0x10 ', '0x10', -5000000000000, 5000000000000000, '0', 0, '1e3', '-', 'abc', '12 34', '1.5', 1.5, '', { a: 1 }];
// Un arreglo [1] lo rechaza el canal (classify) pero normMigrate lo aceptaría como «1»; el canal real nunca se lo entrega al motor.
var INVALIDOS_CANAL = INVALIDOS.concat([[1]]);

test('SEC-A3 el canal descarta un migrate_to_chat_id no válido (sin migrateTo y sin repetir el valor en el mensaje)', function () {
  INVALIDOS_CANAL.forEach(function (v) {
    var r = tg.classify(400, { ok: false, description: 'Bad Request: group chat was upgraded', parameters: { migrate_to_chat_id: v } });
    assert.strictEqual(r.ok, false);
    assert.ok(!('migrateTo' in r), 'sin migrateTo para ' + JSON.stringify(v));
    assert.ok(String(r.message).indexOf('0x10') < 0 && String(r.message).indexOf('5000000') < 0);
  });
  var bueno = tg.classify(400, { ok: false, parameters: { migrate_to_chat_id: ' -1009990001112 ' } });
  assert.strictEqual(bueno.migrateTo, -1009990001112, 'un id válido (con espacios) sí se normaliza');
});

test('SEC-A3 el motor no migra ni guarda un migrateTo no válido y no lo escribe en el log', async function () {
  for (var i = 0; i < INVALIDOS.length; i++) {
    var v = INVALIDOS[i];
    var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
    h.chan.program(err('chat_not_found', { migrateTo: v }), OK);
    h.down();
    await h.clock.advance(VENTANA + 30000);
    var etiqueta = JSON.stringify(v);
    assert.strictEqual(h.disk.cfg.chatId, '-100111', 'chat guardado intacto para ' + etiqueta);
    assert.ok(h.chan.calls.every(function (c) { return c.chat === '-100111'; }), 'nunca se envía a otro chat (' + etiqueta + ')');
    assert.strictEqual(h.notifier.status().failedTotal, 1, 'cuenta como error definitivo (' + etiqueta + ')');
    var log = h.logs.join('\n') + JSON.stringify(h.notifier.status());
    if (typeof v === 'string' && v.trim().length >= 3) assert.ok(log.indexOf(v.trim()) < 0, 'el valor no aparece en el log/estado: ' + etiqueta);
    if (typeof v === 'number' && String(v).length >= 4) assert.ok(log.indexOf(String(v)) < 0, 'el valor no aparece en el log/estado: ' + etiqueta);
    assert.ok(!/supergrupo/.test(log), 'no se anuncia ninguna migración');
  }
});

test('SEC-A3 test(): un migrateTo no válido no migra, no guarda y no se devuelve en la respuesta', async function () {
  var h = H.harness({ cfg: { enabled: false } });
  h.chan.program(err('chat_not_found', { migrateTo: ' 0x10 ' }));
  var r = await h.notifier.test();
  assert.strictEqual(r.ok, false);
  assert.ok(!('migrateTo' in r) && !('chatId' in r));
  assert.ok(JSON.stringify(r).indexOf('0x10') < 0);
  assert.strictEqual(h.disk.cfg.chatId, '-100111');
  assert.strictEqual(h.chan.calls.length, 1, 'sin reintento');
});

test('SEC-A3 test(): un migrateTo válido sí migra y devuelve chatId y migratedTo', async function () {
  var h = H.harness({ cfg: { enabled: false } });
  h.chan.program(err('chat_not_found', { migrateTo: -1009990001112 }), OK);
  var r = await h.notifier.test();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.chatId, '-1009990001112'); assert.strictEqual(r.migratedTo, '-1009990001112');
  assert.strictEqual(h.disk.cfg.chatId, '-1009990001112');
});

/* =============================================================================================
 * Prueba del usuario con un bot real (2026-11-19): la caída se avisó a un chat erróneo (el propio bot) y, al corregir
 * el chat, no se repetía. Cambiar el chat general olvida las caídas avisadas y el chat nuevo las recibe tras N fallos.
 * ========================================================================================== */

test('cambiar el chat general vuelve a avisar las caídas vigentes al chat nuevo (tras N fallos)', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 2, chatId: '@MiBot_bot' } });
  h.chan.program(err('chat_is_bot'));
  h.down(); h.down();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 1, 'primer intento al chat erróneo');
  h.disk.cfg.chatId = '555'; // el administrador guarda el chat correcto
  h.notifier.reload();
  assert.deepStrictEqual(h.disk.cfg.alerted, {}, 'se olvidan las caídas avisadas al chat anterior');
  h.down(); // los contadores en memoria ya superan N: avisa en la siguiente caída
  await h.clock.advance(VENTANA);
  var c = h.chan.calls;
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[1].chat, '555');
  assert.ok(h.logs.some(function (l) { return /Chat de destino cambiado/.test(l); }));
});

test('guardar otros ajustes sin cambiar el chat no repite avisos ya enviados', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.down();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 1);
  await h.clock.advance(1000);
  h.disk.cfg.detail = 'full';
  h.notifier.reload();
  h.down();
  await h.clock.advance(VENTANA);
  assert.strictEqual(h.chan.calls.length, 1, 'sin aviso repetido');
});
