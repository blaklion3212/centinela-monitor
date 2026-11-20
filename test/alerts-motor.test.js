'use strict';
/*
 * Alertas por Telegram: motor de avisos (server/lib/notify.js). Con reloj falso y canal falso: ninguna prueba espera tiempo real.
 * Requisitos: RA-03, RA-11, RA-30 a RA-35, RA-40 a RA-48, RA-52, RA-53, sección 6 (casos límite) y anexo A
 * (docs/requisitos/alertas.md). El formato (RA-32 a RA-34) y la decisión (RA-40 a RA-44) se prueban como funciones puras.
 */
var test = require('node:test');
var assert = require('node:assert');
var notify = require('../server/lib/notify');
var H = require('./helpers/alerts-harness');

var TOKEN = H.TOKEN, TOKEN_ENV = H.TOKEN_ENV;
var OK = { ok: true, result: { message_id: 1 } };
function err(code, extra) { return Object.assign({ ok: false, code: code, message: 'Fallo ' + code, transient: false }, extra || {}); }
function trans(code, extra) { return err(code, Object.assign({ transient: true }, extra || {})); }
// Contrato 2.5.0: la decisión pura es AT.decideTarget (RT-14). El estado de un objetivo es { alerted, counters } con claves locales.
var AT = require('../server/lib/alert-types');
var NOTIFY = Object.assign({}, AT.DEFAULT_NOTIFY);
function notifyWith(o) { return Object.assign({}, NOTIFY, o || {}); }
// Resultado de un objetivo según el estado: up sin motivos; degraded con latencia crítica (tipo latency) o la que se indique;
// down con un motivo down:true. Todos traen ping medible (received > 0) para que la latencia cuente como medida.
function res(status, reasons) {
  var r = { id: 't1', ts: 1700000000000, status: status, ping: { received: 4 } };
  if (reasons) r.reasons = reasons;
  else if (status === 'up' || status === 'unknown') r.reasons = [];
  else if (status === 'degraded') r.reasons = [{ level: 'crit', code: 'latency', down: false, text: 'latencia alta' }];
  else r.reasons = [{ level: 'crit', code: 'port', down: true, text: 'puerto cerrado' }];
  return r;
}
// Un paso de decideTarget; o = { n, notify, thresholds }.
function stepT(prev, r, o) {
  o = o || {};
  var p = prev || { alerted: {}, counters: {} };
  var d = AT.decideTarget({ id: 't1', r: r, alerted: p.alerted, counters: p.counters, notify: o.notify || NOTIFY, n: o.n == null ? 2 : o.n, thresholds: o.thresholds });
  return d;
}
// Aplica una secuencia de estados (o de resultados ya armados) y devuelve una acción por paso: null o 'alert:tipo' / 'recovery:tipo'
// (varios eventos del mismo paso se unen con «+»).
function seq(items, o, prev) {
  var p = prev || { alerted: {}, counters: {} }, out = [];
  items.forEach(function (it) {
    var d = stepT(p, typeof it === 'string' ? res(it) : it, o);
    out.push(d.events.length ? d.events.map(function (e) { return e.kind + ':' + e.type; }).join('+') : null);
    p = { alerted: d.alerted, counters: d.counters };
  });
  return { actions: out, last: p };
}
function item(status, name, o) { return Object.assign({ status: status, name: name, label: '', address: '', reason: '', ts: 1700000000000 }, o || {}); }

/* =============================================================================================
 * decide (pura): RA-40 a RA-44
 * ========================================================================================== */

test('RA-40/RT-14 decideTarget: con N=2 un solo aviso de caída en la 2.ª verificación y ninguno en las siguientes', function () {
  var r = seq(['down', 'down', 'down', 'down']);
  assert.deepStrictEqual(r.actions, [null, 'alert:down', null, null]);
  assert.deepStrictEqual(r.last.alerted, { down: 'on' });
});

test('RA-40/RT-14 decideTarget: con N=1 el aviso sale en la primera verificación down; con N=3 en la tercera', function () {
  assert.deepStrictEqual(seq(['down', 'down'], { n: 1 }).actions, ['alert:down', null]);
  assert.deepStrictEqual(seq(['down', 'down', 'down', 'down'], { n: 3 }).actions, [null, null, 'alert:down', null]);
});

test('RA-40/RT-14 decideTarget: un down aislado (menos de N) seguido de up no avisa ni caída ni recuperación y limpia el contador', function () {
  assert.deepStrictEqual(seq(['down', 'up', 'down', 'up']).actions, [null, null, null, null]);
  var l = seq(['down', 'up']).last;
  assert.deepStrictEqual(l.counters, {}, 'el contador de down se reinicia (antes: fails === 0)');
  assert.deepStrictEqual(l.alerted, {});
});

test('RA-40 -> RT-14 decideTarget: un resultado degraded sin motivo down:true es un resultado medible sin la condición y REINICIA la racha de down', function () {
  // Antes (2.4.0): degraded con notifyDegraded apagado no tocaba la racha de down y [down, degraded, down] avisaba.
  // Ahora (RT-14, RT-03): cada tipo cuenta por separado y un resultado medible sin la condición reinicia su contador.
  assert.deepStrictEqual(seq(['down', 'degraded', 'down']).actions, [null, null, null]);
  assert.deepStrictEqual(seq(['down', 'up', 'down']).actions, [null, null, null]);
  assert.deepStrictEqual(seq(['down', 'down', 'down']).actions, [null, 'alert:down', null], 'sin interrupción sí avisa');
});

test('RA-42 -> RT-01/RT-03 decideTarget: con el tipo latency activo, N resultados degraded (crit) seguidos avisan; apagado no avisa nunca', function () {
  assert.deepStrictEqual(seq(['degraded', 'degraded', 'degraded'], { notify: notifyWith({ latency: true }) }).actions, [null, 'alert:latency', null]);
  assert.deepStrictEqual(seq(['degraded', 'degraded', 'degraded']).actions, [null, null, null], 'con los valores por defecto (latency apagado) no avisa');
  var r = seq(['degraded', 'degraded', 'degraded'], { notify: notifyWith({ latency: true }) });
  assert.deepStrictEqual(r.last.alerted, { 'latency|latency': 'on' });
});

test('RA-42 -> RT-01 decideTarget: la latencia de nivel warn es del tipo other (no del tipo latency) y solo avisa con other activo', function () {
  var warn = res('degraded', [{ level: 'warn', code: 'latency', down: false, text: 'latencia algo alta' }]);
  assert.deepStrictEqual(seq([warn, warn], { notify: notifyWith({ latency: true }) }).actions, [null, null], 'latency activo no cubre el warn');
  var r = seq([warn, warn], { notify: notifyWith({ other: true }) });
  assert.deepStrictEqual(r.actions, [null, 'alert:other']);
  assert.deepStrictEqual(r.last.alerted, { 'other|latency': 'on' });
});

test('RA-42 -> RT-03 decideTarget: la racha ya no mezcla degraded y down; cada tipo cuenta por separado y un resultado con ambos avisa a la vez', function () {
  var o = { notify: notifyWith({ latency: true }) };
  // Antes: [degraded, down] y [down, degraded] avisaban al segundo resultado (racha única «distinta de up»).
  assert.deepStrictEqual(seq(['degraded', 'down'], o).actions, [null, null], 'cada tipo lleva su propio contador');
  assert.deepStrictEqual(seq(['down', 'degraded'], o).actions, [null, null]);
  // Un mismo resultado con motivos de los dos tipos: dos avisos independientes en el mismo paso.
  var both = res('down', [{ level: 'crit', code: 'port', down: true, text: 'puerto cerrado' }, { level: 'crit', code: 'latency', down: false, text: 'latencia alta' }]);
  var r = seq([both, both], o);
  assert.deepStrictEqual(r.actions[0], null);
  assert.deepStrictEqual(r.actions[1].split('+').sort(), ['alert:down', 'alert:latency']);
});

test('RA-41/RT-14 decideTarget: recuperación solo si hubo aviso previo y recovery activo', function () {
  var r = seq(['down', 'down', 'up']);
  assert.deepStrictEqual(r.actions, [null, 'alert:down', 'recovery:down']);
  assert.deepStrictEqual(r.last.alerted, {});
  assert.deepStrictEqual(seq(['up', 'up']).actions, [null, null], 'nunca avisado: no hay recuperación');
});

test('RA-41/RT-14 decideTarget: con recovery apagado el tipo sale de alerted y sus contadores en silencio', function () {
  var r = seq(['down', 'down', 'up'], { notify: notifyWith({ recovery: false }) });
  assert.deepStrictEqual(r.actions, [null, 'alert:down', null]);
  assert.deepStrictEqual(r.last.alerted, {});
  assert.deepStrictEqual(r.last.counters, {});
});

test('RA-43 -> RT-14/RT-04 decideTarget: matriz de transiciones del contrato nuevo (down y latency son tipos independientes)', function () {
  var on = { notify: notifyWith({ latency: true }) };
  // down avisado -> degraded: down se recupera al DEJAR de estar caído (RT-14), sin esperar a que terminen las degradaciones.
  // Antes (2.4.0): «sigue avisado como caído hasta up» y no avisaba nada.
  var a = seq(['down', 'down', 'degraded']);
  assert.deepStrictEqual(a.actions, [null, 'alert:down', 'recovery:down']);
  assert.deepStrictEqual(a.last.alerted, {});
  // down avisado -> degraded con latency activo: recupera down y empieza a contar latency; avisa al segundo degraded.
  var b = seq(['down', 'down', 'degraded', 'degraded'], on);
  assert.deepStrictEqual(b.actions, [null, 'alert:down', 'recovery:down', 'alert:latency']);
  assert.deepStrictEqual(b.last.alerted, { 'latency|latency': 'on' });
  // degraded avisado -> down: aviso CAÍDO tras N down y la latencia, ya no presente en un resultado medible, se recupera.
  assert.deepStrictEqual(seq(['degraded', 'degraded', 'down', 'down'], on).actions, [null, 'alert:latency', 'recovery:latency', 'alert:down']);
  // degraded avisado -> up: RECUPERADO del tipo latency.
  assert.deepStrictEqual(seq(['degraded', 'degraded', 'up'], on).actions, [null, 'alert:latency', 'recovery:latency']);
  // up -> down tras N y vuelta: un aviso de cada.
  assert.deepStrictEqual(seq(['up', 'down', 'down', 'up']).actions, [null, null, 'alert:down', 'recovery:down']);
});

test('RA-43/RT-14 decideTarget: unknown no genera avisos ni altera el estado (ni alerted ni contadores)', function () {
  var prev = { alerted: { down: 'on' }, counters: { down: { level: 'on', count: 3, crit: 0, missing: 0 } } };
  var d = stepT(prev, res('unknown'));
  assert.deepStrictEqual(d.events, []);
  assert.deepStrictEqual(d.alerted, prev.alerted);
  assert.deepStrictEqual(d.counters, prev.counters);
  var d2 = stepT({ alerted: {}, counters: { down: { level: 'on', count: 1, crit: 0, missing: 0 } } }, res('unknown'));
  assert.deepStrictEqual(d2.counters, { down: { level: 'on', count: 1, crit: 0, missing: 0 } });
  assert.deepStrictEqual(d2.events, []);
});

test('RA-44/RT-21 decideTarget: tras reiniciar, un objetivo ya avisado que sigue down no repite el aviso y su up sí se avisa', function () {
  // El contador parte de cero (memoria) pero la clave persistida evita repetir el aviso.
  var r = seq(['down', 'down', 'up'], null, { alerted: { down: 'on' }, counters: {} });
  assert.deepStrictEqual(r.actions, [null, null, 'recovery:down']);
});

test('Casos límite decideTarget: cambio de N en caliente aplica a la racha en curso (el contador se compara con el N vigente)', function () {
  var c = function (n) { return { alerted: {}, counters: { down: { level: 'on', count: n, crit: 0, missing: 0 } } }; };
  assert.deepStrictEqual(seq(['down'], { n: 2 }, c(1)).actions, ['alert:down'], 'N bajado: sale en la siguiente');
  assert.deepStrictEqual(seq(['down'], { n: 3 }, c(4)).actions, ['alert:down']);
  assert.deepStrictEqual(seq(['down'], { n: 5 }, c(1)).actions, [null], 'N subido: sigue contando');
});

test('RA-40/RT-14 decideTarget: no muta el estado previo y tolera entradas vacías', function () {
  var prev = { alerted: { down: 'on' }, counters: { down: { level: 'on', count: 1, crit: 0, missing: 0 } } };
  var copia = JSON.parse(JSON.stringify(prev));
  AT.decideTarget({ id: 't1', r: res('down'), alerted: prev.alerted, counters: prev.counters, notify: NOTIFY, n: 2 });
  assert.deepStrictEqual(prev, copia);
  assert.doesNotThrow(function () { AT.decideTarget(null); });
  assert.doesNotThrow(function () { AT.decideTarget(undefined); });
  assert.doesNotThrow(function () { AT.decideTarget({}); });
  assert.doesNotThrow(function () { AT.decideTarget({ r: { status: 'up' } }); });
});

test('RT-14 salvaguarda: estado down sin ningún motivo down:true avisa «Sin respuesta» como tipo down', function () {
  var r = seq([res('down', []), res('down', [])]);
  assert.deepStrictEqual(r.actions, [null, 'alert:down']);
  var d = stepT({ alerted: {}, counters: { down: { level: 'on', count: 1, crit: 0, missing: 0 } } }, res('down', []));
  assert.deepStrictEqual(d.events[0].reasons, ['Sin respuesta']);
});

/* =============================================================================================
 * formatMessage (pura): RA-32, RA-33, RA-34 y sección 6
 * ========================================================================================== */

test('RA-32 formatMessage mínimo: icono, [organización], nombre y estado con el formato exacto', function () {
  var m = function (st, lab) { return notify.formatMessage([item(st, 'Portal intranet', { label: lab })], { detail: 'minimal' }); };
  assert.strictEqual(m('down', 'Cliente ACME'), '🔴 [Cliente ACME] Portal intranet: CAÍDO');
  assert.strictEqual(m('degraded', 'Cliente ACME'), '🟠 [Cliente ACME] Portal intranet: DEGRADADO');
  assert.strictEqual(m('up', 'Cliente ACME'), '🟢 [Cliente ACME] Portal intranet: RECUPERADO');
});

test('RA-32 formatMessage mínimo: sin organización no hay corchetes ni espacios sobrantes', function () {
  var t = notify.formatMessage([item('down', 'Portal intranet')], { detail: 'minimal' });
  assert.strictEqual(t, '🔴 Portal intranet: CAÍDO');
  assert.ok(t.indexOf('[') < 0 && t.indexOf('  ') < 0);
});

test('RA-32 formatMessage mínimo: no incluye dirección, motivo, IP ni hora aunque el aviso los traiga', function () {
  var t = notify.formatMessage([item('down', 'Portal', { address: '10.20.30.40', reason: 'Puerto 443 cerrado' })], { detail: 'minimal' });
  assert.ok(t.indexOf('10.20.30.40') < 0, t);
  assert.ok(t.indexOf('Puerto 443') < 0, t);
  assert.ok(!/\d{2}:\d{2}/.test(t), 'sin hora: ' + t);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(t), 'sin fecha: ' + t);
});

test('RA-32 formatMessage: los caracteres especiales del nombre u organización llegan literales', function () {
  var raros = ['<b>x', 'a & b', '*negrita*', '_cursiva_', '[enlace](http://x)', '</script><img src=x onerror=1>', '`codigo`', 'a\\b'];
  raros.forEach(function (n) {
    var t = notify.formatMessage([item('down', n, { label: n })], { detail: 'minimal' });
    assert.strictEqual(t, '🔴 [' + n + '] ' + n + ': CAÍDO', n);
  });
});

test('Casos límite formatMessage: un nombre de más de 200 caracteres se recorta con «…»', function () {
  var largo = new Array(301).join('n');
  var t = notify.formatMessage([item('down', largo)], { detail: 'minimal' });
  assert.ok(t.indexOf('…') > 0);
  assert.ok(t.length < 260, 'longitud ' + t.length);
  assert.ok(t.indexOf(largo) < 0);
  var lab = notify.formatMessage([item('down', 'x', { label: largo })], { detail: 'minimal' });
  assert.ok(lab.length < 260);
});

test('RA-33 formatMessage completo: añade dirección, motivo y hora; omite campos vacíos sin líneas en blanco', function () {
  var ts = Date.UTC(2026, 10, 19, 14, 5, 9);
  var t = notify.formatMessage([item('down', 'Portal', { label: 'ACME', address: 'https://portal.acme.test', reason: 'HTTP 503', ts: ts })], { detail: 'full' });
  var lines = t.split('\n');
  assert.strictEqual(lines[0], '🔴 [ACME] Portal: CAÍDO');
  assert.ok(t.indexOf('https://portal.acme.test') > 0);
  assert.ok(t.indexOf('HTTP 503') > 0);
  assert.match(t, /\d{2}:\d{2}:\d{2}/, 'incluye la hora del evento');
  assert.ok(lines.every(function (l) { return l.trim() !== ''; }), 'sin líneas en blanco: ' + JSON.stringify(t));
  var sinAddr = notify.formatMessage([item('down', 'Portal', { address: '', reason: 'HTTP 503', ts: ts })], { detail: 'full' });
  assert.ok(sinAddr.split('\n').every(function (l) { return l.trim() !== ''; }));
  assert.ok(sinAddr.indexOf('HTTP 503') > 0);
  var sinNada = notify.formatMessage([item('down', 'Portal', { address: '', reason: '', ts: NaN })], { detail: 'full' });
  assert.strictEqual(sinNada, '🔴 Portal: CAÍDO');
});

test('RA-33 formatMessage completo: el estado up muestra «Servicio recuperado» como motivo', function () {
  var t = notify.formatMessage([item('up', 'Portal', { address: '10.0.0.1', reason: 'ignorado' })], { detail: 'full' });
  assert.ok(t.indexOf('Servicio recuperado') > 0, t);
  assert.ok(t.indexOf('ignorado') < 0, t);
});

test('RA-33 formatMessage completo: todo el texto se recorta a TG_MAX_TEXT', function () {
  var t = notify.formatMessage([item('down', 'P', { address: new Array(9000).join('a'), reason: new Array(9000).join('b') })], { detail: 'full' });
  assert.ok(t.length <= 4096, 'longitud ' + t.length);
  var corto = notify.formatMessage([item('down', 'P', { reason: new Array(500).join('r') })], { detail: 'full' }, { TG_MAX_TEXT: 100 });
  assert.ok(corto.length <= 100, 'con consts: ' + corto.length);
});

test('RA-34 formatMessage: un aviso único va como mensaje simple, sin encabezado de grupo', function () {
  var t = notify.formatMessage([item('down', 'Uno')], { detail: 'minimal' });
  assert.ok(!/avisos/.test(t), t);
  assert.strictEqual(t.split('\n').length, 1);
});

test('RA-34 formatMessage: varios avisos llevan encabezado con el recuento y una línea por objetivo, ordenados por ts', function () {
  var t = notify.formatMessage([item('down', 'C', { ts: 3000 }), item('down', 'A', { ts: 1000 }), item('up', 'B', { ts: 2000 })], { detail: 'minimal' });
  var l = t.split('\n');
  assert.match(l[0], /^3 avisos$/);
  assert.strictEqual(l.length, 4);
  assert.deepStrictEqual(l.slice(1), ['🔴 A: CAÍDO', '🟢 B: RECUPERADO', '🔴 C: CAÍDO']);
});

test('RA-34 formatMessage: más de MAX_GROUP_LINES se resume con «… y N más» en un solo mensaje', function () {
  var items = [];
  for (var i = 1; i <= 25; i++) items.push(item('down', 'Srv' + i, { ts: 1000 + i }));
  var t = notify.formatMessage(items, { detail: 'minimal' });
  var l = t.split('\n');
  assert.match(l[0], /^25 avisos$/);
  assert.strictEqual(l.filter(function (x) { return /^🔴 /.test(x); }).length, 20, 'exactamente 20 líneas detalladas');
  assert.strictEqual(l[l.length - 1], '… y 5 más');
  assert.ok(t.length <= 4096);
});

test('RA-34 formatMessage: exactamente MAX_GROUP_LINES avisos no genera resumen', function () {
  var items = [];
  for (var i = 1; i <= 20; i++) items.push(item('down', 'Srv' + i, { ts: i }));
  var t = notify.formatMessage(items, { detail: 'minimal' });
  assert.ok(t.indexOf(' más') < 0, t);
});

test('RA-34 formatMessage: respeta MAX_GROUP_LINES de consts', function () {
  var items = [];
  for (var i = 1; i <= 6; i++) items.push(item('down', 'S' + i, { ts: i }));
  var t = notify.formatMessage(items, { detail: 'minimal' }, { MAX_GROUP_LINES: 3 });
  assert.strictEqual(t.split('\n').filter(function (x) { return /^🔴 /.test(x); }).length, 3);
  assert.match(t, /… y 3 más$/);
});

test('RA-34 formatMessage: un grupo que excede TG_MAX_TEXT se resume sin superar el límite y las cuentas cuadran', function () {
  var items = [], nombre = new Array(200).join('x');
  for (var i = 1; i <= 500; i++) items.push(item('down', nombre + i, { ts: i }));
  var t = notify.formatMessage(items, { detail: 'minimal' });
  assert.ok(t.length <= 4096, 'longitud ' + t.length);
  var l = t.split('\n');
  var detalle = l.filter(function (x) { return /^🔴 /.test(x); }).length;
  var m = /… y (\d+) más$/.exec(t);
  assert.ok(m, 'debe terminar con el resumen: ' + t.slice(-60));
  assert.strictEqual(detalle + Number(m[1]), 500, 'líneas mostradas + resumidas = total');
  assert.match(l[0], /^500 avisos$/);
});

test('RA-34 formatMessage: en modo completo un grupo largo tampoco supera TG_MAX_TEXT', function () {
  var items = [];
  for (var i = 1; i <= 40; i++) items.push(item('down', 'Servicio ' + i, { address: 'http://srv' + i + '.test/' + new Array(150).join('p'), reason: new Array(120).join('m'), ts: i }));
  var t = notify.formatMessage(items, { detail: 'full' });
  assert.ok(t.length <= 4096, 'longitud ' + t.length);
  assert.match(t, /… y \d+ más$/);
});

test('RA-34 formatMessage: lista vacía devuelve cadena vacía y entradas nulas no lanzan', function () {
  assert.strictEqual(notify.formatMessage([], { detail: 'minimal' }), '');
  assert.strictEqual(notify.formatMessage(undefined, undefined), '');
});

/* =============================================================================================
 * Motor con reloj y canal falsos
 * ========================================================================================== */

/* ---------- suscripción y ciclo de vida (RA-30, RA-03, RA-48) ---------- */

test('RA-30 suscripción: solo se suscribe a result cuando la función está efectivamente activa', function () {
  assert.strictEqual(H.harness({ cfg: { enabled: false } }).sched.listenerCount('result'), 0, 'desactivada');
  assert.strictEqual(H.harness({ cfg: { token: '' } }).sched.listenerCount('result'), 0, 'sin token');
  assert.strictEqual(H.harness({ cfg: { chatId: '' } }).sched.listenerCount('result'), 0, 'sin chat');
  assert.strictEqual(H.harness({ env: { CENTINELA_ALERTS_DISABLED: '1' } }).sched.listenerCount('result'), 0, 'bloqueada por entorno');
  assert.strictEqual(H.harness().sched.listenerCount('result'), 1, 'activa');
  assert.strictEqual(H.harness({ cfg: { token: '' }, env: { CENTINELA_TELEGRAM_TOKEN: TOKEN_ENV } }).sched.listenerCount('result'), 1, 'token por entorno');
});

test('RA-30 suscripción: reload() se (des)suscribe según la configuración y stop() se desuscribe', function () {
  var h = H.harness({ cfg: { enabled: false } });
  assert.strictEqual(h.sched.listenerCount('result'), 0);
  h.disk.cfg.enabled = true; h.notifier.reload();
  assert.strictEqual(h.sched.listenerCount('result'), 1);
  h.notifier.reload();
  assert.strictEqual(h.sched.listenerCount('result'), 1, 'reload repetido no duplica la suscripción');
  h.disk.cfg.enabled = false; h.notifier.reload();
  assert.strictEqual(h.sched.listenerCount('result'), 0);
  h.disk.cfg.enabled = true; h.notifier.reload();
  h.notifier.stop();
  assert.strictEqual(h.sched.listenerCount('result'), 0);
});

test('RA-06/RA-01 desactivada: 100 cambios de estado no producen ninguna llamada al canal ni temporizadores', async function () {
  var h = H.harness({ cfg: { enabled: false } });
  for (var i = 0; i < 100; i++) { h.emit('t1', i % 2 ? 'up' : 'down'); }
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 0);
  assert.strictEqual(h.clock.pending(), 0);
  assert.strictEqual(h.chan.updatesCalls, 0);
});

test('RA-04 bloqueo por entorno: aunque enabled=true no se envía nada y status informa blocked', async function () {
  var h = H.harness({ env: { CENTINELA_ALERTS_DISABLED: 'true' } });
  h.down(); h.down();
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 0);
  assert.strictEqual(h.notifier.status().state, 'blocked');
});

test('RA-48 stop(): cancela temporizadores y la cola; no se envía nada después', async function () {
  var h = H.harness();
  h.down(); h.down();
  assert.ok(h.clock.pending() > 0, 'hay ventana de agrupación abierta');
  h.notifier.stop();
  assert.strictEqual(h.clock.pending(), 0);
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 0);
});

test('RA-03 desactivar con avisos en ventana: cola y ventanas quedan vacías, sin temporizadores ni envíos posteriores', async function () {
  var h = H.harness();
  h.down(); h.down();
  assert.strictEqual(h.notifier.status().inWindow, 1);
  h.disk.cfg.enabled = false; h.notifier.reload();
  assert.strictEqual(h.notifier.status().inWindow, 0);
  assert.strictEqual(h.notifier.status().queued, 0);
  assert.strictEqual(h.clock.pending(), 0);
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 0);
  h.down(); h.down(); h.down();
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 0, 'los eventos posteriores no generan avisos');
});

test('RA-03 desactivar con un mensaje esperando reintento: se cancela el temporizador y no se vuelve a enviar', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(trans('unknown'));
  h.down();
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 1);
  assert.strictEqual(h.notifier.status().queued, 1, 'a la espera del reintento');
  h.disk.cfg.enabled = false; h.notifier.reload();
  assert.strictEqual(h.notifier.status().queued, 0);
  assert.strictEqual(h.clock.pending(), 0);
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 1);
});

test('RA-03 desactivar con un envío en vuelo: su respuesta tardía no reanima la cola', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program({ hold: true });
  h.down();
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 1);
  h.disk.cfg.enabled = false; h.notifier.reload();
  h.chan.held[0](trans('unknown')); // llega tarde con error transitorio
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 1, 'no hay reintento');
  assert.strictEqual(h.clock.pending(), 0);
});

/* ---------- avisos básicos (RA-98 escenario 2, RA-40, RA-41) ---------- */

test('RA-98.2 un down tras N=2 fallos se envía una sola vez, con el formato mínimo, tras la ventana de agrupación', async function () {
  var h = H.harness();
  h.down();
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 0, 'un fallo no basta');
  h.down();
  await h.clock.advance(29999);
  assert.strictEqual(h.chan.calls.length, 0, 'aún dentro de la ventana de agrupación (30 s)');
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 1);
  assert.strictEqual(h.chan.calls[0].text, '🔴 Portal: CAÍDO');
  assert.strictEqual(h.chan.calls[0].chat, '-100111');
  assert.strictEqual(h.chan.calls[0].token, TOKEN);
  h.down(); h.down();
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 1, 'los down siguientes no repiten el aviso');
});

test('RA-40 N=1: el aviso sale en la primera verificación down', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.down();
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: CAÍDO']);
});

test('RA-41 recuperación: tras un aviso de caída, el primer up avisa RECUPERADO', async function () {
  var h = H.harness();
  h.down(); h.down();
  await h.clock.advance(30000);
  h.up();
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: CAÍDO', '🟢 Portal: RECUPERADO']);
});

test('RA-41/RT-14 recuperación: con notify.recovery apagado no se avisa; sin caída avisada tampoco', async function () {
  var h = H.harness({ cfg: { notify: { recovery: false } } });
  h.down(); h.down(); await h.clock.advance(30000); h.up(); await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: CAÍDO']);
  var g = H.harness();
  g.down(); g.up(); await g.clock.advance(60000);
  assert.strictEqual(g.chan.calls.length, 0, 'una caída que nunca se avisó no tiene recuperación');
});

test('RA-42 -> RT-30/RT-01 latencia: con notify.latency avisa 🟠 «LATENCIA ALTA» tras N resultados crit; sin él no avisa', async function () {
  // Antes: notifyDegraded avisaba «DEGRADADO» genérico. Ahora el aviso es por tipo y la etiqueta depende del code.
  var h = H.harness({ cfg: { notify: { latency: true } } });
  h.emit('t1', 'degraded'); h.emit('t1', 'degraded');
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🟠 Portal: LATENCIA ALTA']);
  var g = H.harness();
  g.emit('t1', 'degraded'); g.emit('t1', 'degraded'); g.emit('t1', 'degraded');
  await g.clock.advance(60000);
  assert.strictEqual(g.chan.calls.length, 0);
});

test('RA-43 unknown y resultados inválidos no generan avisos ni lanzan excepciones', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.emit('t1', 'unknown'); h.emit('t1', 'raro'); h.emit('t1', undefined);
  assert.doesNotThrow(function () { h.notifier.onResult(null); h.notifier.onResult({}); h.notifier.onResult({ id: 't1' }); h.notifier.onResult(undefined); });
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 0);
});

test('RA-98.3 un servicio que alterna caído/activo no genera más de un aviso por ciclo según N', async function () {
  var h = H.harness();
  // down,up,down,up con N=2: nunca llega a 2 seguidos.
  ['down', 'up', 'down', 'up', 'down', 'up'].forEach(function (s) { h.emit('t1', s); });
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 0, 'alternancia rápida: ningún aviso');
  // Ciclos completos: cada ciclo down,down,up da una caída y una recuperación.
  for (var i = 0; i < 3; i++) { h.down(); h.down(); await h.clock.advance(30000); h.up(); await h.clock.advance(30000); }
  var t = h.chan.texts();
  assert.strictEqual(t.length, 6);
  assert.strictEqual(t.filter(function (x) { return /CAÍDO/.test(x); }).length, 3);
  assert.strictEqual(t.filter(function (x) { return /RECUPERADO/.test(x); }).length, 3);
  // Mezcla: down,down,down,up,down,up,down,down => caída, recuperación, caída.
  var g = H.harness();
  ['down', 'down', 'down', 'up', 'down', 'up', 'down', 'down'].forEach(function (s) { g.emit('t1', s); });
  await g.clock.advance(30000);
  assert.strictEqual(g.chan.calls.length, 1, 'todo cae en la misma ventana: un mensaje agrupado');
  assert.ok(/CAÍDO/.test(g.chan.calls[0].text));
});

test('RA-40 el contador de fallos es por objetivo', async function () {
  var h = H.harness({ targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.down('a'); h.down('b'); h.up('a'); h.down('a');
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 0, 'cada uno lleva su propia racha');
  h.down('b');
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Beta: CAÍDO']);
});

/* ---------- etiqueta de organización y destino (RA-11, RA-31, RA-32) ---------- */

test('RA-32 la organización principal (default) no lleva etiqueta; otra organización sí', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['p', 'Portal', '', 'default'], ['q', 'Correo', '', 'acme']] });
  h.down('p');
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: CAÍDO']);
  h.down('q');
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.texts()[1], '🔴 [Cliente ACME] Correo: CAÍDO');
});

test('RA-31 destino por chat: con orgChats cargado, cada organización envía a su chat y se agrupan por separado (RA-98.8)', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, orgChats: { acme: '-100777' } },
    targets: [['a1', 'A1', '', 'acme'], ['a2', 'A2', '', 'acme'], ['d1', 'D1', '', 'default'], ['d2', 'D2', '', 'default']] });
  h.down('a1'); h.down('d1'); h.down('a2'); h.down('d2');
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 2, 'un mensaje agrupado por chat');
  var porChat = {};
  h.chan.calls.forEach(function (c) { porChat[c.chat] = c.text; });
  assert.deepStrictEqual(Object.keys(porChat).sort(), ['-100111', '-100777']);
  assert.match(porChat['-100777'], /^2 avisos\n/);
  assert.ok(/A1/.test(porChat['-100777']) && /A2/.test(porChat['-100777']) && !/D1|D2/.test(porChat['-100777']));
  assert.ok(/D1/.test(porChat['-100111']) && /D2/.test(porChat['-100111']) && !/A1|A2/.test(porChat['-100111']));
});

test('RA-31 una organización sin chat propio usa el general', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, orgChats: { acme: '-100777' } }, targets: [['x', 'X', '', 'otra']] });
  h.down('x');
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls[0].chat, '-100111');
});

test('Casos límite cambio de chatId con avisos en ventana: los encolados van al chat con el que se resolvieron; los nuevos al nuevo', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.down('a');
  h.disk.cfg.chatId = '-100222'; h.notifier.reload();
  h.down('b');
  await h.clock.advance(31000);
  var m = {};
  h.chan.calls.forEach(function (c) { m[c.chat] = c.text; });
  assert.ok(/Alfa/.test(m['-100111']), JSON.stringify(m));
  assert.ok(/Beta/.test(m['-100222']), JSON.stringify(m));
  assert.ok(!/Beta/.test(m['-100111']) && !/Alfa/.test(m['-100222']));
});

/* ---------- agrupación (RA-34) ---------- */

test('RA-34 agrupación: varios avisos del mismo chat dentro de la ventana contada desde el primero van en un solo mensaje', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta'], ['c', 'Gamma']] });
  h.down('a');
  await h.clock.advance(10000);
  h.down('b');
  await h.clock.advance(19000);
  h.down('c');
  await h.clock.advance(1000);
  assert.strictEqual(h.chan.calls.length, 1);
  assert.match(h.chan.calls[0].text, /^3 avisos\n/);
  assert.strictEqual(h.chan.calls[0].t - 1700000000000, 30000, 'se envió a los 30 s del primer aviso');
});

test('RA-34 agrupación: un aviso fuera de la ventana abre otro grupo', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.down('a');
  await h.clock.advance(31000);
  h.down('b');
  await h.clock.advance(31000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Alfa: CAÍDO', '🔴 Beta: CAÍDO']);
});

test('RA-34 agrupación: la caída y la recuperación del mismo objetivo en la misma ventana salen en un solo mensaje, en orden', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.down();
  await h.clock.advance(5000);
  h.up();
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 1);
  var l = h.chan.calls[0].text.split('\n');
  assert.strictEqual(l[0], '2 avisos');
  assert.strictEqual(l[1], '🔴 Portal: CAÍDO');
  assert.strictEqual(l[2], '🟢 Portal: RECUPERADO');
});

test('RA-34 tormenta: 500 objetivos que caen a la vez producen un solo mensaje ≤ 4096 con «… y N más» y no desbordan la cola', async function () {
  var targets = [];
  for (var i = 0; i < 500; i++) targets.push(['t' + i, 'Servidor numero ' + i, '10.0.' + (i >> 8) + '.' + (i & 255)]);
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: targets });
  targets.forEach(function (t) { h.down(t[0]); });
  assert.strictEqual(h.notifier.status().inWindow, 500);
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 1);
  var t = h.chan.calls[0].text;
  assert.ok(t.length <= 4096);
  assert.match(t, /^500 avisos\n/);
  assert.match(t, /… y \d+ más$/);
  var st = h.notifier.status();
  assert.strictEqual(st.droppedTotal, 0);
  assert.strictEqual(st.sentTotal, 1);
});

/* ---------- datos capturados y objetivo borrado (sección 6) ---------- */

test('Casos límite: el modo completo usa la dirección y el motivo capturados al avisar aunque el objetivo se borre antes del envío', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, detail: 'full' }, targets: [['t1', 'Portal', 'https://portal.test/health']] });
  h.emit('t1', 'down', { reasons: [{ level: 'crit', text: 'HTTP 503', down: true }, { level: 'info', text: 'ruido informativo' }] });
  h.store.remove('t1');
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 1);
  var t = h.chan.calls[0].text;
  assert.ok(t.indexOf('https://portal.test/health') > 0, t);
  assert.ok(t.indexOf('HTTP 503') > 0, t);
  assert.ok(t.indexOf('ruido informativo') < 0, 'los motivos informativos no cuentan');
});

test('RA-33 modo completo: la recuperación muestra «Servicio recuperado»', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, detail: 'full' } });
  h.down(); await h.clock.advance(30000);
  h.up(); await h.clock.advance(30000);
  assert.ok(h.chan.calls[1].text.indexOf('Servicio recuperado') > 0, h.chan.calls[1].text);
});

test('Casos límite: un objetivo sin nombre conocido (ya borrado) se avisa con su id sin lanzar', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [] });
  h.emit('fantasma', 'down');
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 1);
  assert.ok(h.chan.calls[0].text.indexOf('fantasma') > 0);
});

test('Casos límite: cambio de N en caliente aplica a las rachas en curso sin reiniciarlas', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 3 } });
  h.down(); h.down();
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 0);
  h.disk.cfg.failsBeforeAlert = 2; h.notifier.reload();
  h.down();
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 1, 'el nuevo N ya se cumple: aviso en la siguiente verificación down');
});

test('RA-21 el motor envía con el token de la variable de entorno cuando existe (prioridad sobre el del panel)', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, env: { CENTINELA_TELEGRAM_TOKEN: TOKEN_ENV } });
  h.down();
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls[0].token, TOKEN_ENV);
});

/* ---------- persistencia de alerted y reinicio (RA-44, RA-98.9) ---------- */

test('RA-44/RT-10/RT-12 alerted: se guarda al avisar la caída y se quita al avisar la recuperación; solo se escribe cuando cambia', async function () {
  var h = H.harness();
  var s0 = h.disk.saves;
  h.down();
  await h.clock.advance(500); // el guardado de alerted es diferido (SAVE_DELAY_MS)
  assert.strictEqual(h.disk.saves, s0, 'sin aviso aún: nada que guardar');
  h.down();
  await h.clock.advance(500);
  assert.deepStrictEqual(h.disk.cfg.alerted, { 't1|down': 'on' });
  assert.strictEqual(h.disk.saves, s0 + 1);
  h.down(); h.down(); h.down();
  await h.clock.advance(500);
  assert.strictEqual(h.disk.saves, s0 + 1, 'más down no reescriben el archivo');
  await h.clock.advance(30000);
  h.up();
  await h.clock.advance(500);
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
  assert.strictEqual(h.disk.saves, s0 + 2);
  h.up(); h.up();
  assert.strictEqual(h.disk.saves, s0 + 2);
});

test('RA-44/RT-12 alerted: guardarlo conserva el resto de la configuración del disco (token, ajustes editados)', async function () {
  var h = H.harness();
  h.disk.cfg.detail = 'full'; h.disk.cfg.chatId = '-100999'; // edición posterior desde el panel, sin reload todavía
  h.down(); h.down();
  await h.clock.advance(500);
  assert.strictEqual(h.disk.cfg.token, TOKEN);
  assert.strictEqual(h.disk.cfg.chatId, '-100999');
  assert.strictEqual(h.disk.cfg.detail, 'full');
  assert.deepStrictEqual(h.disk.cfg.alerted, { 't1|down': 'on' });
});

test('RA-98.9 reinicio: una caída ya avisada y todavía caída no se repite; su recuperación sí se avisa', async function () {
  var h = H.harness();
  h.down(); h.down();
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls.length, 1);
  h.restart();
  h.down(); h.down(); h.down();
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 1, 'no se repite tras el reinicio');
  h.up();
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: CAÍDO', '🟢 Portal: RECUPERADO']);
  assert.deepStrictEqual(h.disk.cfg.alerted, {});
});

test('RA-98.9 reinicio: una caída no avisada se avisa tras N fallos seguidos contados desde cero', async function () {
  var h = H.harness();
  h.down(); // 1 fallo antes del reinicio: se pierde el contador
  h.restart();
  h.down();
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 0, 'tras el reinicio el contador empieza en 0');
  h.down();
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Portal: CAÍDO']);
});

test('RA-44/RT-21 reinicio: los avisos en ventana o cola se pierden, pero el objetivo queda en alerted y su recuperación se avisa', async function () {
  var h = H.harness();
  h.down(); h.down(); // en ventana de agrupación
  h.restart(); // stop() fuerza el guardado pendiente de alerted
  assert.deepStrictEqual(h.disk.cfg.alerted, { 't1|down': 'on' });
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 0, 'la ventana se perdió');
  h.up();
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🟢 Portal: RECUPERADO']);
});

test('RA-44 objetivo nuevo con el servidor en marcha: si está caído desde su primera verificación se avisa tras N fallos', async function () {
  var h = H.harness();
  h.store.add('nuevo', 'Recien creado', '10.9.9.9');
  h.down('nuevo');
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 0);
  h.down('nuevo');
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🔴 Recien creado: CAÍDO']);
});

test('RA-44/RT-21 latencia no avisada tras reiniciar con notify.latency: el contador parte de cero y avisa como cualquier caída', async function () {
  var h = H.harness({ cfg: { notify: { latency: true } } });
  h.emit('t1', 'degraded');
  h.restart();
  h.emit('t1', 'degraded');
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 0);
  h.emit('t1', 'degraded');
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.texts(), ['🟠 Portal: LATENCIA ALTA']);
});

test('RA-44/RT-12 desactivar la función vacía alerted y los contadores: al reactivar se parte de cero sin recuperaciones antiguas', async function () {
  var h = H.harness();
  h.down(); h.down();
  await h.clock.advance(30000);
  assert.deepStrictEqual(h.disk.cfg.alerted, { 't1|down': 'on' });
  h.disk.cfg.enabled = false; h.notifier.reload();
  await h.clock.advance(500);
  assert.deepStrictEqual(h.disk.cfg.alerted, {}, 'alerted vaciado en disco');
  h.disk.cfg.enabled = true; h.notifier.reload();
  h.up();
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 1, 'sin recuperación de caídas antiguas');
  h.down();
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 1, 'el contador de fallos también se reinició');
});

test('RA-44/RT-13 borrar un objetivo lo saca de alerted (prune) y no se avisa su recuperación', async function () {
  var h = H.harness({ targets: [['t1', 'Portal'], ['t2', 'Otro']] });
  h.down('t1'); h.down('t1'); h.down('t2'); h.down('t2');
  await h.clock.advance(30000);
  assert.deepStrictEqual(Object.keys(h.disk.cfg.alerted).sort(), ['t1|down', 't2|down']);
  h.store.remove('t1');
  h.notifier.prune();
  await h.clock.advance(500);
  assert.deepStrictEqual(h.disk.cfg.alerted, { 't2|down': 'on' });
  var s = h.disk.saves;
  h.notifier.prune();
  await h.clock.advance(500);
  assert.strictEqual(h.disk.saves, s, 'prune sin cambios no escribe');
  h.up('t1');
  await h.clock.advance(60000);
  assert.strictEqual(h.chan.calls.length, 1, 'solo el aviso de caída conjunto original');
});

/* ---------- no bloqueo (RA-35) ---------- */

test('RA-35 onResult retorna de forma síncrona antes de que Telegram responda y no llama al canal en línea', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, consts: { GROUP_WINDOW_MS: 0 } });
  h.chan.program({ hold: true });
  var ret = h.notifier.onResult({ id: 't1', status: 'down', ts: h.clock.now(), reasons: [] });
  assert.strictEqual(ret, undefined, 'no devuelve una promesa que haya que esperar');
  assert.strictEqual(h.chan.calls.length, 0, 'el envío no ocurre dentro de la llamada');
  await h.clock.advance(0);
  assert.strictEqual(h.chan.calls.length, 1, 'el envío empezó y sigue en vuelo');
  var t0 = Date.now();
  for (var i = 0; i < 200; i++) h.emit('t1', 'down'); // con la petición anterior sin responder
  assert.ok(Date.now() - t0 < 500, 'procesar resultados no espera al canal');
});

test('RA-35 una excepción del canal o del registro no escapa de onResult ni del envío', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, consts: { GROUP_WINDOW_MS: 0 } });
  h.chan.program({ throws: true });
  assert.doesNotThrow(function () { h.down(); });
  await h.clock.advance(0);
  assert.strictEqual(h.chan.calls.length, 1);
  h.chan.sendMessage = function () { throw new Error('síncrona'); };
  h.up();
  await h.clock.advance(60000);
  assert.ok(true, 'el motor sigue vivo');
});

/* ---------- reintentos, errores definitivos y cola (RA-45) ---------- */

test('RA-45 reintentos: un fallo transitorio se reintenta con BACKOFF_MS creciente hasta tener éxito', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(trans('unknown'), trans('no_internet'), OK);
  h.down();
  await h.clock.advance(30000);
  var t0 = h.chan.calls[0].t;
  await h.clock.advance(1999);
  assert.strictEqual(h.chan.calls.length, 1, 'aún no pasaron 2 s');
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 2);
  assert.ok(h.chan.calls[1].t - t0 >= 2000);
  await h.clock.advance(3999);
  assert.strictEqual(h.chan.calls.length, 2, 'la segunda espera es de 4 s');
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 3);
  assert.ok(h.chan.calls[2].t - h.chan.calls[1].t >= 4000);
  assert.strictEqual(h.chan.calls[2].text, h.chan.calls[0].text, 'el mismo mensaje en cada intento');
  var st = h.notifier.status();
  assert.strictEqual(st.sentTotal, 1); assert.strictEqual(st.failedTotal, 0); assert.strictEqual(st.state, 'ok');
});

test('RA-45 reintentos: agotados MAX_ATTEMPTS (5) se descarta, se registra el error y se continúa con el siguiente', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.chan.program(trans('timeout'), trans('timeout'), trans('timeout'), trans('timeout'), trans('timeout'));
  h.down('a');
  await h.clock.advance(30000);
  h.down('b');
  await h.clock.advance(31000 + 2000 + 4000 + 8000 + 16000);
  var alfa = h.chan.calls.filter(function (c) { return /Alfa/.test(c.text); });
  assert.strictEqual(alfa.length, 5, 'exactamente 5 intentos');
  var gaps = [2000, 4000, 8000, 16000];
  gaps.forEach(function (g, i) { assert.ok(alfa[i + 1].t - alfa[i].t >= g, 'espera ' + (i + 1) + ' >= ' + g); });
  var beta = h.chan.calls.filter(function (c) { return /Beta/.test(c.text); });
  assert.strictEqual(beta.length, 1, 'continúa con el siguiente mensaje');
  var st = h.notifier.status();
  assert.strictEqual(st.failedTotal, 1); assert.strictEqual(st.droppedTotal, 0, 'un fallo definitivo cuenta solo en failedTotal'); assert.strictEqual(st.sentTotal, 1);
  assert.strictEqual(st.queued, 0);
  assert.strictEqual(st.state, 'ok', 'el último envío fue correcto');
});

test('RA-45 error transitorio persistente: lastError y state=error mientras falle', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.setDefault(trans('no_internet'));
  h.down();
  await h.clock.advance(30000);
  var st = h.notifier.status();
  assert.strictEqual(st.state, 'error');
  assert.strictEqual(st.lastError.code, 'no_internet');
  assert.strictEqual(typeof st.lastError.at, 'number');
  assert.ok(st.lastError.message.length > 0);
});

test('RA-45 error definitivo (401, 400 chat no encontrado, 403): sin reintento, mensaje descartado, error registrado y función no desactivada', async function () {
  for (var code of ['invalid_token', 'chat_not_found', 'blocked']) {
    var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
    h.chan.program(err(code));
    h.down();
    await h.clock.advance(30000 + 120000);
    assert.strictEqual(h.chan.calls.length, 1, code + ': un solo intento');
    var st = h.notifier.status();
    assert.strictEqual(st.failedTotal, 1, code); assert.strictEqual(st.droppedTotal, 0, code);
    assert.strictEqual(st.lastError.code, code);
    assert.strictEqual(st.state, 'error', code + ': se muestra en el indicador');
    assert.strictEqual(h.disk.cfg.enabled, true, code + ': no desactiva la función');
    assert.strictEqual(h.sched.listenerCount('result'), 1);
  }
});

test('RA-45 un 401 repetido deja el estado en error sin desactivar; un envío correcto posterior lo restablece', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta'], ['c', 'Gamma']] });
  h.chan.program(err('invalid_token'), err('invalid_token'), OK);
  h.down('a'); await h.clock.advance(31000);
  h.down('b'); await h.clock.advance(31000);
  assert.strictEqual(h.notifier.status().state, 'error');
  h.down('c'); await h.clock.advance(31000);
  assert.strictEqual(h.notifier.status().state, 'ok');
  assert.strictEqual(h.notifier.status().failedTotal, 2);
});

test('RA-45 un chat que falla no bloquea a otro: el otro chat se envía sin esperar el retroceso', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, orgChats: { acme: '-100777' } }, targets: [['d', 'Dflt', '', 'default'], ['a', 'Acme1', '', 'acme']] });
  h.chan.program(trans('unknown')); // el primer envío (chat general) falla de forma transitoria
  h.down('d'); h.down('a');
  await h.clock.advance(30000);
  var otro = h.chan.calls.filter(function (c) { return c.chat === '-100777'; });
  assert.strictEqual(otro.length, 1);
  var t0 = h.chan.calls[0].t;
  assert.ok(otro[0].t - t0 <= 0, 'el segundo chat sale en el mismo instante, sin esperar el retroceso del primero');
});

test('RA-45 MAX_QUEUE: al superarse se descartan los más antiguos (nunca el que va en vuelo) y se cuentan', async function () {
  var names = ['a', 'b', 'c', 'd', 'e', 'f'];
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, consts: { GROUP_WINDOW_MS: 0, MAX_QUEUE: 3 }, targets: names.map(function (n) { return [n, 'Srv-' + n]; }) });
  h.chan.program({ hold: true });
  for (var i = 0; i < names.length; i++) { h.down(names[i]); await h.clock.advance(0); }
  var st = h.notifier.status();
  assert.strictEqual(st.queued, 3, 'tope respetado');
  assert.strictEqual(st.droppedTotal, 3);
  h.chan.held[0](OK);
  await h.clock.advance(20000);
  var texts = h.chan.texts();
  assert.ok(/Srv-a/.test(texts[0]), 'el que iba en vuelo se conservó');
  assert.deepStrictEqual(texts.slice(1).map(function (t) { return /Srv-(\w)/.exec(t)[1]; }), ['e', 'f'], 'sobreviven los más recientes');
});

/* ---------- retry_after (RA-46) ---------- */

test('RA-98.5 / RA-46 429 con retry_after: no se envía nada al chat hasta pasados R s y el mensaje se entrega', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'Alfa'], ['b', 'Beta']] });
  h.chan.program(trans('rate_limited', { retryAfterS: 20 }));
  h.down('a');
  await h.clock.advance(30000);
  var t0 = h.chan.calls[0].t;
  h.down('b'); // otro aviso al mismo chat llega durante la espera
  await h.clock.advance(19000 + 0);
  assert.strictEqual(h.chan.calls.length, 1, 'nada antes de R s (ni siquiera el aviso nuevo)');
  await h.clock.advance(1000);
  assert.ok(h.chan.calls.length >= 2);
  assert.ok(h.chan.calls[1].t - t0 >= 20000, 'separación ' + (h.chan.calls[1].t - t0));
  assert.strictEqual(h.chan.calls[1].text, h.chan.calls[0].text, 'se reintenta el mismo mensaje');
});

test('RA-46 el 429 con retry_after no consume intentos: más de MAX_ATTEMPTS respuestas 429 seguidas no descartan el mensaje', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  for (var i = 0; i < 7; i++) h.chan.program(trans('rate_limited', { retryAfterS: 1 }));
  h.chan.program(OK);
  h.down();
  await h.clock.advance(30000 + 7 * 1100);
  assert.strictEqual(h.chan.calls.length, 8);
  var st = h.notifier.status();
  assert.strictEqual(st.sentTotal, 1); assert.strictEqual(st.failedTotal, 0); assert.strictEqual(st.droppedTotal, 0);
});

test('RA-46 retry_after mayor que MAX_RETRY_AFTER_S (3600) se acota a esa cota', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(trans('rate_limited', { retryAfterS: 999999 }), OK);
  h.down();
  await h.clock.advance(30000);
  var t0 = h.chan.calls[0].t;
  await h.clock.advance(3599 * 1000);
  assert.strictEqual(h.chan.calls.length, 1);
  await h.clock.advance(2000);
  assert.strictEqual(h.chan.calls.length, 2, 'a las 3600 s ya se reintentó');
  assert.ok(h.chan.calls[1].t - t0 >= 3600000);
  assert.ok(h.chan.calls[1].t - t0 < 3600000 + 5000);
});

test('RA-46 429 sin retry_after: se usa el retroceso BACKOFF_MS (cuenta como intento)', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(trans('rate_limited'), OK);
  h.down();
  await h.clock.advance(30000);
  var t0 = h.chan.calls[0].t;
  await h.clock.advance(1999);
  assert.strictEqual(h.chan.calls.length, 1);
  await h.clock.advance(1);
  assert.strictEqual(h.chan.calls.length, 2);
  assert.ok(h.chan.calls[1].t - t0 >= 2000);
  var g = H.harness({ cfg: { failsBeforeAlert: 1 } });
  for (var i = 0; i < 5; i++) g.chan.program(trans('rate_limited'));
  g.down();
  await g.clock.advance(30000 + 40000);
  assert.strictEqual(g.chan.calls.length, 5);
  assert.strictEqual(g.notifier.status().failedTotal, 1, 'sin retry_after sí se agotan los intentos (cuenta solo en failedTotal)');
});

/* ---------- ritmo (RA-47) ---------- */

test('RA-47 al mismo chat hay al menos TG_MIN_GAP_CHAT_MS (1 s) entre mensajes', async function () {
  var names = ['a', 'b', 'c', 'd'];
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, consts: { GROUP_WINDOW_MS: 0 }, targets: names.map(function (n) { return [n, 'S' + n]; }) });
  for (var i = 0; i < names.length; i++) { h.down(names[i]); await h.clock.advance(0); }
  await h.clock.advance(10000);
  assert.strictEqual(h.chan.calls.length, 4);
  for (var k = 1; k < 4; k++) assert.ok(h.chan.calls[k].t - h.chan.calls[k - 1].t >= 1000, 'hueco ' + k + ': ' + (h.chan.calls[k].t - h.chan.calls[k - 1].t));
});

test('RA-47 grupos: como máximo TG_MAX_PER_MIN_GROUP (20) mensajes por minuto a un mismo grupo', async function () {
  var names = [];
  for (var i = 0; i < 25; i++) names.push('g' + i);
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, consts: { GROUP_WINDOW_MS: 0 }, targets: names.map(function (n) { return [n, 'S' + n]; }) });
  for (var j = 0; j < names.length; j++) { h.down(names[j]); await h.clock.advance(0); }
  await h.clock.advance(5 * 60000);
  assert.strictEqual(h.chan.calls.length, 25);
  for (var k = 20; k < 25; k++) assert.ok(h.chan.calls[k].t - h.chan.calls[k - 20].t >= 60000, 'el mensaje ' + k + ' sale demasiado pronto');
});

test('RA-47 global: como máximo TG_MAX_PER_SEC_GLOBAL (30) mensajes por segundo en total', async function () {
  var orgChats = {}, targets = [];
  for (var i = 0; i < 40; i++) { orgChats['o' + i] = String(1000 + i); targets.push(['t' + i, 'S' + i, '', 'o' + i]); } // chats privados (positivos): sin límite por grupo
  var h = H.harness({ cfg: { failsBeforeAlert: 1, orgChats: orgChats }, consts: { GROUP_WINDOW_MS: 0 }, targets: targets });
  targets.forEach(function (t) { h.down(t[0]); });
  await h.clock.advance(0);
  await h.clock.advance(5000);
  assert.strictEqual(h.chan.calls.length, 40);
  for (var k = 30; k < 40; k++) assert.ok(h.chan.calls[k].t - h.chan.calls[k - 30].t >= 1000, 'el mensaje ' + k + ' rompe el límite global');
  assert.ok(h.chan.calls[29].t === h.chan.calls[0].t, 'los 30 primeros salen sin esperar');
});

/* ---------- migración de grupo (anexo A) ---------- */

test('Anexo A migrate_to_chat_id: actualiza el chat guardado, reintenta una vez al nuevo chat y deja la nota en el estado', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(err('chat_not_found', { migrateTo: -1009998887776 }), OK);
  h.down();
  await h.clock.advance(30000 + 5000);
  assert.strictEqual(h.chan.calls.length, 2);
  assert.strictEqual(h.chan.calls[0].chat, '-100111');
  assert.strictEqual(h.chan.calls[1].chat, '-1009998887776');
  assert.strictEqual(h.disk.cfg.chatId, '-1009998887776', 'guardado en alerts.json');
  assert.strictEqual(h.chan.calls[1].text, h.chan.calls[0].text);
  var st = h.notifier.status();
  assert.match(st.note, /supergrupo/);
  assert.strictEqual(st.sentTotal, 1);
  assert.ok(h.logs.some(function (l) { return /supergrupo/.test(l); }), 'registrado en el log');
  // Los siguientes avisos van al chat nuevo.
  h.up();
  await h.clock.advance(30000);
  assert.strictEqual(h.chan.calls[2].chat, '-1009998887776');
});

test('Anexo A migrate_to_chat_id: solo se reintenta una vez (sin bucle) y el mensaje se descarta', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(err('chat_not_found', { migrateTo: -100222 }), err('chat_not_found', { migrateTo: -100333 }), OK);
  h.down();
  await h.clock.advance(120000);
  assert.strictEqual(h.chan.calls.length, 2, 'un reintento y se detiene');
  assert.strictEqual(h.notifier.status().failedTotal, 1);
  assert.strictEqual(h.notifier.status().droppedTotal, 0, 'cuenta solo en failedTotal');
});

test('Anexo A migrate_to_chat_id: si el chat migrado es el de una organización se actualiza ahí y el general no cambia', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1, orgChats: { acme: '-100777' } }, targets: [['a', 'Acme1', '', 'acme']] });
  h.disk.cfg.orgChats = { acme: '-100777' };
  h.chan.program(err('chat_not_found', { migrateTo: -100888 }), OK);
  h.down('a');
  await h.clock.advance(60000);
  assert.strictEqual(h.disk.cfg.orgChats.acme, '-100888', 'si es un chat de organización se actualiza ahí');
  assert.strictEqual(h.disk.cfg.chatId, '-100111', 'el general no cambia');
});

/* ---------- acciones explícitas: test y findChats (RA-52) ---------- */

test('RA-52 test(): envía el texto fijo con la versión al chat guardado, sin datos de objetivos y aunque enabled=false', async function () {
  var h = H.harness({ cfg: { enabled: false }, targets: [['t1', 'Secreto-Interno', '10.1.1.1']] });
  var r = await h.notifier.test();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.chan.calls.length, 1);
  var c = h.chan.calls[0];
  assert.match(c.text, /^✅ Centinela: mensaje de prueba/);
  assert.ok(c.text.indexOf('9.9.9') > 0, 'incluye la versión');
  assert.ok(c.text.indexOf('Secreto-Interno') < 0 && c.text.indexOf('10.1.1.1') < 0);
  assert.strictEqual(c.chat, '-100111');
  assert.strictEqual(c.token, TOKEN);
});

test('RA-52 test(chatId): prueba un chat aún no guardado sin modificar la configuración', async function () {
  var h = H.harness();
  var r = await h.notifier.test('@otro_canal');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.chan.calls[0].chat, '@otro_canal');
  assert.strictEqual(h.disk.cfg.chatId, '-100111');
});

test('RA-52 test(): chat opcional con formato inválido no sale a la red', async function () {
  var h = H.harness();
  var r = await h.notifier.test('esto no es un chat');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.chan.calls.length, 0);
});

test('RA-52 test(): sin token => code no_token; sin chat => no_chat; sin salir a la red', async function () {
  var h = H.harness({ cfg: { token: '' } });
  var a = await h.notifier.test();
  assert.strictEqual(a.ok, false); assert.strictEqual(a.code, 'no_token');
  var g = H.harness({ cfg: { chatId: '' } });
  var b = await g.notifier.test();
  assert.strictEqual(b.ok, false); assert.strictEqual(b.code, 'no_chat');
  assert.strictEqual(h.chan.calls.length + g.chan.calls.length, 0);
});

test('RA-04 bloqueo por entorno: test() y findChats() responden alerts_disabled_by_env sin tocar el canal', async function () {
  var h = H.harness({ env: { CENTINELA_ALERTS_DISABLED: '1' } });
  var a = await h.notifier.test(), b = await h.notifier.findChats();
  assert.strictEqual(a.code, 'alerts_disabled_by_env'); assert.strictEqual(b.code, 'alerts_disabled_by_env');
  assert.strictEqual(h.chan.calls.length, 0); assert.strictEqual(h.chan.updatesCalls, 0);
});

test('RA-23 test(): los fallos del canal llegan con code y mensaje, y un canal que revienta se convierte en error controlado', async function () {
  var h = H.harness();
  h.chan.program(err('invalid_token'));
  var r = await h.notifier.test();
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'invalid_token'); assert.ok(r.message);
  h.chan.program({ throws: true });
  var r2 = await h.notifier.test();
  assert.strictEqual(r2.ok, false); assert.strictEqual(r2.code, 'unknown');
});

test('Anexo A test() con chat guardado migrado: actualiza el chat y reintenta; con chat no guardado solo informa el nuevo id', async function () {
  var h = H.harness({ cfg: { enabled: false } });
  h.chan.program(err('chat_not_found', { migrateTo: -100555 }), OK);
  var r = await h.notifier.test();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.chan.calls[1].chat, '-100555');
  assert.strictEqual(h.disk.cfg.chatId, '-100555');
  var g = H.harness();
  g.chan.program(err('chat_not_found', { migrateTo: -100666 }));
  var r2 = await g.notifier.test('-100444');
  assert.strictEqual(r2.ok, false);
  assert.ok(String(r2.message).indexOf('-100666') >= 0, r2.message);
  assert.strictEqual(g.chan.calls.length, 1);
  assert.strictEqual(g.disk.cfg.chatId, '-100111');
});

test('RA-52 findChats(): lista {id,type,title} deduplicada, sin llamar a sendMessage, aunque enabled=false', async function () {
  var h = H.harness({ cfg: { enabled: false } });
  h.chan.updatesRes = { ok: true, result: [
    { update_id: 1, message: { chat: { id: 5, type: 'private', first_name: 'Ana' }, text: 'hola' } },
    { update_id: 2, message: { chat: { id: 5, type: 'private', first_name: 'Ana' }, text: 'otra vez' } },
    { update_id: 3, channel_post: { chat: { id: -100300, type: 'channel', title: 'Avisos' } } }] };
  var r = await h.notifier.findChats();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.chats, [{ id: 5, type: 'private', title: 'Ana' }, { id: -100300, type: 'channel', title: 'Avisos' }]);
  assert.strictEqual(r.hint, undefined);
  assert.strictEqual(h.chan.calls.length, 0);
  assert.strictEqual(h.chan.updatesCalls, 1, 'una sola llamada a getUpdates');
});

test('RA-52 findChats(): sin resultados devuelve chats: [] y la pista de escribirle al bot', async function () {
  var h = H.harness();
  var r = await h.notifier.findChats();
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.chats, []);
  assert.strictEqual(r.hint, 'Escríbele un mensaje al bot y vuelve a pulsar');
});

test('RA-52 findChats(): errores del canal (401, 409) se devuelven con code y sin lanzar; sin token => no_token', async function () {
  var h = H.harness();
  h.chan.updatesRes = err('invalid_token');
  var r = await h.notifier.findChats();
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'invalid_token');
  var g = H.harness({ cfg: { token: '' } });
  assert.strictEqual((await g.notifier.findChats()).code, 'no_token');
});

/* ---------- status (RA-53) ---------- */

test('RA-53 status(): forma, contadores y estados off / ok / error / blocked', async function () {
  var off = H.harness({ cfg: { enabled: false } }).notifier.status();
  assert.strictEqual(off.state, 'off');
  ['state', 'lastSentAt', 'lastError', 'queued', 'inWindow', 'sentTotal', 'failedTotal', 'droppedTotal', 'tokenSource'].forEach(function (k) { assert.ok(k in off, 'falta ' + k); });
  assert.strictEqual(off.lastSentAt, null); assert.strictEqual(off.lastError, null);
  assert.strictEqual(off.sentTotal, 0);
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  assert.strictEqual(h.notifier.status().state, 'ok');
  h.down();
  assert.strictEqual(h.notifier.status().inWindow, 1);
  await h.clock.advance(30000);
  var st = h.notifier.status();
  assert.strictEqual(st.inWindow, 0); assert.strictEqual(st.sentTotal, 1);
  assert.strictEqual(typeof st.lastSentAt, 'number');
  assert.strictEqual(st.tokenSource, 'panel');
  assert.strictEqual(H.harness({ env: { CENTINELA_TELEGRAM_TOKEN: TOKEN_ENV } }).notifier.status().tokenSource, 'env');
});

test('RA-53 status(): no incluye texto de mensajes ni nombres de objetivos ni el token', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['t1', 'NombreMuyEspecifico', '10.77.77.77']] });
  h.chan.program(trans('unknown'));
  h.down();
  await h.clock.advance(30000);
  var s = JSON.stringify(h.notifier.status());
  assert.ok(s.indexOf('NombreMuyEspecifico') < 0, s);
  assert.ok(s.indexOf('10.77.77.77') < 0);
  assert.ok(s.indexOf('CAÍDO') < 0);
  assert.ok(s.indexOf(TOKEN) < 0 && s.indexOf('123456789') < 0);
});

test('RA-22 el motor no registra el token en el log ni siquiera tras fallos del canal', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 } });
  h.chan.program(err('invalid_token'), { throws: true });
  h.down(); await h.clock.advance(31000); h.up(); await h.clock.advance(31000);
  await h.notifier.test();
  assert.ok(h.logs.join('\n').indexOf(TOKEN) < 0);
  assert.ok(h.logs.join('\n').indexOf('123456789') < 0);
});

/* ---------- chatFor sin destino (RA-11) ---------- */

test('RA-11 el motor resuelve el destino siempre con chatFor: un chat general cambiado tras reload se usa para avisos nuevos', async function () {
  var h = H.harness({ cfg: { failsBeforeAlert: 1 }, targets: [['a', 'A'], ['b', 'B']] });
  h.down('a'); await h.clock.advance(30000);
  h.disk.cfg.chatId = '@nuevo_canal'; h.notifier.reload();
  h.down('b'); await h.clock.advance(30000);
  assert.deepStrictEqual(h.chan.calls.map(function (c) { return c.chat; }), ['-100111', '@nuevo_canal']);
});

test('DEFAULTS del motor coinciden con la sección 4 de los requisitos', function () {
  var d = notify.DEFAULTS;
  assert.strictEqual(d.GROUP_WINDOW_MS, 30000);
  assert.strictEqual(d.MAX_ATTEMPTS, 5);
  assert.deepStrictEqual(d.BACKOFF_MS, [2000, 4000, 8000, 16000]);
  assert.strictEqual(d.MAX_QUEUE, 200);
  assert.strictEqual(d.TG_MAX_TEXT, 4096);
  assert.strictEqual(d.TG_MIN_GAP_CHAT_MS, 1000);
  assert.strictEqual(d.TG_MAX_PER_MIN_GROUP, 20);
  assert.strictEqual(d.TG_MAX_PER_SEC_GLOBAL, 30);
  assert.strictEqual(d.MAX_GROUP_LINES, 20);
  assert.strictEqual(d.MAX_RETRY_AFTER_S, 3600);
});
