'use strict';
/*
 * Tipos de alerta seleccionables (2.5.0): decisión por tipo (server/lib/alert-types.js, decideTarget).
 * Requisitos: RT-02, RT-03, RT-04, RT-13 a RT-20, RT-23 (migración de `alerted` en la decisión) y RT-24 (equivalencia con
 * 2.4.0). Función pura: sin reloj real, sin red, sin disco. Los resultados se construyen con el evaluador real
 * (js/core/evaluate.js) para que los motivos tengan la forma que recibe el motor en producción.
 * Convenciones del contrato: `alerted` es el mapa del objetivo con claves locales «tipo» o «tipo|subclave»;
 * eventos { kind: 'alert'|'recovery', type, sub, level, code, reasons, ts }.
 */
var test = require('node:test');
var assert = require('node:assert');
var AT = require('../server/lib/alert-types');
var E = require('../js/core/evaluate.js');
var Defaults = require('../js/config/defaults.js');

var TH = Defaults.SETTINGS.thresholds; // diskWarnPct 85, diskCritPct 90, sslWarnDays 30, sslCritDays 7

/* ---------------------------------------------------------------------------------------------
 * Ayudantes locales
 * ------------------------------------------------------------------------------------------- */
var PING_OK = { sent: 4, received: 4, lossPct: 0, avg: 10, jitter: 1 };
function ping(o) { return Object.assign({}, PING_OK, o || {}); }
function agent(o) { return Object.assign({ cpu: { usagePct: 10, ioWaitPct: 1 }, mem: { usedPct: 10 }, disks: [], services: [] }, o || {}); }
function disks() { return { agent: agent({ disks: Array.prototype.slice.call(arguments).map(function (d) { return { mount: d[0], usedPct: d[1] }; }) }) }; }

var tsSeq = 1700000000000;
// Resultado como el del planificador: el evaluador calcula status y motivos a partir de lo medido.
function res(raw, th) {
  if (raw && raw.manual) return Object.assign({ id: 't1', ts: ++tsSeq }, raw.manual);
  var e = E.evaluate({ checks: { ping: true } }, raw, th || TH);
  return Object.assign({ id: 't1', ts: ++tsSeq, status: e.status, reasons: e.reasons }, raw);
}

function notifyDe(over) { return Object.assign({}, AT.DEFAULT_NOTIFY, { certExpiring: true, certTrust: true, latency: true, resources: true, disk: true, other: true }, over || {}); }

// Simulador de una secuencia de resultados de un objetivo: conserva alerted y contadores entre pasos.
function sim(o) {
  o = o || {};
  var s = { alerted: o.alerted || {}, counters: o.counters || {}, notify: o.notify || notifyDe(), n: o.n || 2, th: o.th || TH, log: [] };
  s.step = function (raw) {
    var r = typeof raw === 'object' && raw && raw.id ? raw : res(raw, s.th);
    var d = AT.decideTarget({ id: 't1', r: r, alerted: s.alerted, counters: s.counters, notify: s.notify, n: s.n, thresholds: s.th });
    s.alerted = d.alerted; s.counters = d.counters; s.last = d; s.log.push(d.events);
    return d.events;
  };
  s.keys = function () { return Object.keys(s.alerted).sort(); };
  return s;
}
function ks(events) { return events.map(function (e) { return e.kind + ':' + e.type + (e.sub ? ':' + e.sub : '') + '@' + e.level; }); }
function alertsOf(events) { return events.filter(function (e) { return e.kind === 'alert'; }); }
function recoveriesOf(events) { return events.filter(function (e) { return e.kind === 'recovery'; }); }
function repetir(s, raw, veces) { var out = []; for (var i = 0; i < veces; i++) out = out.concat(s.step(raw)); return out; }

/* =============================================================================================
 * Matriz por tipo × (activación, no repetición, recuperación, recovery apagado, desactivado, reinicio del contador)
 * RT-14, RT-20
 * ========================================================================================== */

var BASE_UP = { ping: ping() };
// nombre, tipo, subclave, nivel, raw con el problema, raw sano (la fuente se mide correctamente)
var ESCENARIOS = [
  ['down (puerto cerrado)', 'down', '', 'on', { ports: [{ port: 22, open: false }] }, { ports: [{ port: 22, open: true }] }],
  ['certExpired', 'certExpired', '', 'on', { ssl: { daysLeft: -2 } }, { ssl: { daysLeft: 300 } }],
  ['certExpiring (advertencia)', 'certExpiring', '', 'warn', { ssl: { daysLeft: 20 } }, { ssl: { daysLeft: 300 } }],
  ['certTrust', 'certTrust', '', 'on', { ssl: { daysLeft: 300, authorized: false, authError: 'self signed' } }, { ssl: { daysLeft: 300, authorized: true } }],
  ['latency (latencia)', 'latency', 'latency', 'on', { ping: ping({ avg: 500 }) }, BASE_UP],
  ['latency (pérdida)', 'latency', 'loss', 'on', { ping: ping({ received: 2, lossPct: 50 }) }, BASE_UP],
  ['latency (jitter)', 'latency', 'jitter', 'on', { ping: ping({ jitter: 100 }) }, BASE_UP],
  ['latency (ttfb)', 'latency', 'ttfb', 'on', { http: { status: 200, ttfbMs: 3000 } }, { http: { status: 200, ttfbMs: 100 } }],
  ['resources (cpu)', 'resources', 'cpu', 'on', { agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 } }) }, { agent: agent() }],
  ['resources (mem)', 'resources', 'mem', 'on', { agent: agent({ mem: { usedPct: 99 } }) }, { agent: agent() }],
  ['resources (io)', 'resources', 'io', 'on', { agent: agent({ cpu: { usagePct: 10, ioWaitPct: 50 } }) }, { agent: agent() }],
  ['disk (advertencia)', 'disk', '/var', 'warn', disks(['/var', 88]), disks(['/var', 50])],
  ['other (agente sin respuesta)', 'other', 'agent', 'on', { agent: { error: 'sin respuesta' } }, { agent: agent() }],
  ['other (latencia en advertencia)', 'other', 'latency', 'on', { ping: ping({ avg: 200 }) }, BASE_UP],
  ['other (cpu en advertencia)', 'other', 'cpu', 'on', { agent: agent({ cpu: { usagePct: 90, ioWaitPct: 1 } }) }, { agent: agent() }],
  ['other (certificado ilegible)', 'other', 'ssl', 'on', { ssl: { error: 'ECONNRESET' } }, { ssl: { daysLeft: 300 } }],
  ['other (code inventado)', 'other', 'inventado', 'on',
    { manual: { status: 'degraded', reasons: [{ level: 'warn', text: 'algo raro', down: false, code: 'inventado' }] } },
    { manual: { status: 'up', reasons: [] } }]
];

ESCENARIOS.forEach(function (e) {
  var nombre = e[0], tipo = e[1], sub = e[2], nivel = e[3], malo = e[4], sano = e[5];
  [1, 2].forEach(function (n) {
    var pre = 'RT-14/RT-20 ' + nombre + ' con N=' + n + ': ';

    test(pre + 'se avisa exactamente al llegar a N resultados con el problema', function () {
      var s = sim({ n: n });
      for (var i = 1; i < n; i++) assert.deepStrictEqual(s.step(malo), [], 'antes de N no hay aviso (paso ' + i + ')');
      var ev = s.step(malo);
      assert.strictEqual(ev.length, 1);
      assert.strictEqual(ev[0].kind, 'alert');
      assert.strictEqual(ev[0].type, tipo);
      assert.strictEqual(ev[0].sub || '', sub);
      assert.strictEqual(ev[0].level, nivel);
      assert.ok(Array.isArray(ev[0].reasons));
      assert.strictEqual(s.keys().length, 1, 'queda una clave avisada');
    });

    test(pre + 'no se repite mientras el problema continúa (un aviso por episodio)', function () {
      var s = sim({ n: n });
      var todo = repetir(s, malo, n + 6);
      assert.deepStrictEqual(ks(alertsOf(todo)).length, 1, 'un solo aviso: ' + ks(todo).join(', '));
      assert.deepStrictEqual(recoveriesOf(todo), []);
    });

    test(pre + 'recuperación con un resultado medible y sano (un evento de recuperación del mismo tipo)', function () {
      var s = sim({ n: n });
      repetir(s, malo, n);
      var ev = s.step(sano);
      assert.strictEqual(ev.length, 1);
      assert.strictEqual(ev[0].kind, 'recovery');
      assert.strictEqual(ev[0].type, tipo);
      assert.strictEqual(ev[0].sub || '', sub);
      assert.deepStrictEqual(s.keys(), [], 'la clave se elimina');
      assert.deepStrictEqual(repetir(s, sano, 3), [], 'no hay más recuperaciones');
    });

    test(pre + 'con «recovery» apagado la clave se elimina en silencio', function () {
      var s = sim({ n: n, notify: notifyDe({ recovery: false }) });
      assert.strictEqual(alertsOf(repetir(s, malo, n)).length, 1, 'el aviso de activación sí sale');
      assert.deepStrictEqual(s.step(sano), []);
      assert.deepStrictEqual(s.keys(), []);
    });

    test(pre + 'con el tipo desactivado no avisa, no deja claves y no acumula contadores (RT-03)', function () {
      var no = {}; no[tipo] = false;
      var s = sim({ n: n, notify: notifyDe(no) });
      assert.deepStrictEqual(repetir(s, malo, n + 3), []);
      assert.deepStrictEqual(s.keys(), []);
      assert.deepStrictEqual(Object.keys(s.counters).filter(function (k) { return k.split('|')[0] === tipo; }), []);
    });

    test(pre + 'un problema que aparece y desaparece antes de N no avisa nunca', function () {
      if (n === 1) return; // con N=1 el primer resultado ya avisa
      var s = sim({ n: n });
      var todo = [];
      for (var i = 0; i < 4; i++) { todo = todo.concat(repetir(s, malo, n - 1)); todo = todo.concat(s.step(sano)); }
      assert.deepStrictEqual(todo, [], 'un resultado medible y sano reinicia el contador');
    });

    test(pre + 'tras recuperarse, un nuevo episodio vuelve a avisar tras N resultados', function () {
      var s = sim({ n: n });
      repetir(s, malo, n); s.step(sano);
      var ev = repetir(s, malo, n);
      assert.strictEqual(alertsOf(ev).length, 1);
    });
  });
});

test('RT-14 los eventos llevan la marca de tiempo del resultado y el texto del motivo del tipo', function () {
  var s = sim({ n: 1 });
  var r = res({ agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 } }) });
  var ev = s.step(r);
  assert.strictEqual(ev[0].ts, r.ts);
  assert.deepStrictEqual(ev[0].reasons, ['CPU al 99 %']);
});

/* =============================================================================================
 * RT-14. Escalado en certExpiring y disk
 * ========================================================================================== */

[1, 2].forEach(function (n) {
  test('RT-14 certExpiring con N=' + n + ': aviso warn, luego aviso crit al cruzar el umbral crítico, sin repetir', function () {
    var s = sim({ n: n });
    var ev = repetir(s, { ssl: { daysLeft: 20 } }, n);
    assert.deepStrictEqual(ks(ev), ['alert:certExpiring@warn']);
    assert.deepStrictEqual(repetir(s, { ssl: { daysLeft: 19 } }, 3), [], 'sin repetición por comprobación');
    var crit = repetir(s, { ssl: { daysLeft: 6 } }, n);
    assert.deepStrictEqual(ks(crit), ['alert:certExpiring@crit'], 'a los N resultados seguidos en crit');
    assert.strictEqual(s.alerted.certExpiring, 'crit');
    assert.deepStrictEqual(repetir(s, { ssl: { daysLeft: 5 } }, 4), [], 'en crit tampoco se repite');
    assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 300 } })), ['recovery:certExpiring@on'], 'una sola recuperación');
    assert.deepStrictEqual(s.keys(), []);
  });

  test('RT-14 / sección 5 certExpiring con N=' + n + ': salto directo de 31 a 6 días avisa solo crit (el warn nunca visto no se avisa)', function () {
    var s = sim({ n: n });
    assert.deepStrictEqual(repetir(s, { ssl: { daysLeft: 31 } }, 3), []);
    var ev = repetir(s, { ssl: { daysLeft: 6 } }, n + 2);
    assert.deepStrictEqual(ks(ev), ['alert:certExpiring@crit']);
  });

  test('RT-14 certExpiring con N=' + n + ': si el nivel baja (crit -> warn) la clave baja en silencio y un nuevo cruce al alza avisa de nuevo', function () {
    var s = sim({ n: n });
    repetir(s, { ssl: { daysLeft: 5 } }, n);
    assert.strictEqual(s.alerted.certExpiring, 'crit');
    assert.deepStrictEqual(repetir(s, { ssl: { daysLeft: 20 } }, 3), [], 'bajar de nivel no avisa ni recupera');
    assert.strictEqual(s.alerted.certExpiring, 'warn');
    assert.deepStrictEqual(ks(repetir(s, { ssl: { daysLeft: 4 } }, n)), ['alert:certExpiring@crit']);
  });

  test('RT-14 certExpiring con N=' + n + ': una oscilación crit/warn alternada no alcanza N seguidos en crit', function () {
    if (n === 1) return;
    var s = sim({ n: n });
    repetir(s, { ssl: { daysLeft: 20 } }, n); // aviso warn
    var todo = [];
    for (var i = 0; i < 4; i++) { todo = todo.concat(s.step({ ssl: { daysLeft: 5 } })); todo = todo.concat(s.step({ ssl: { daysLeft: 20 } })); }
    assert.deepStrictEqual(todo, [], 'nunca hay N resultados crit seguidos');
  });

  test('RT-14 disk con N=' + n + ': aviso warn, luego crit, sin repetición; la recuperación es una sola', function () {
    var s = sim({ n: n });
    assert.deepStrictEqual(ks(repetir(s, disks(['/var', 88]), n)), ['alert:disk:/var@warn']);
    assert.deepStrictEqual(repetir(s, disks(['/var', 89]), 3), []);
    assert.deepStrictEqual(ks(repetir(s, disks(['/var', 93]), n)), ['alert:disk:/var@crit']);
    assert.deepStrictEqual(repetir(s, disks(['/var', 97]), 3), []);
    assert.deepStrictEqual(ks(s.step(disks(['/var', 40]))), ['recovery:disk:/var@on']);
    assert.deepStrictEqual(s.keys(), []);
  });

  test('RT-14 disk con N=' + n + ': salto directo a crítico avisa solo crit', function () {
    var s = sim({ n: n });
    assert.deepStrictEqual(ks(repetir(s, disks(['/var', 95]), n)), ['alert:disk:/var@crit']);
    assert.deepStrictEqual(repetir(s, disks(['/var', 95]), 3), []);
  });

  test('RT-14 disk con N=' + n + ': bajar el nivel baja la clave en silencio y un cruce posterior al alza vuelve a avisar', function () {
    var s = sim({ n: n });
    repetir(s, disks(['/var', 95]), n);
    assert.deepStrictEqual(repetir(s, disks(['/var', 88]), 3), []);
    assert.strictEqual(s.alerted['disk|%2Fvar'], 'warn');
    assert.deepStrictEqual(ks(repetir(s, disks(['/var', 96]), n)), ['alert:disk:/var@crit']);
  });
});

test('RT-14 la persistencia de los N resultados en crit no se cuenta con los de warn (N=2: warn, crit, warn, crit no avisa crit)', function () {
  var s = sim({ n: 2 });
  repetir(s, disks(['/var', 88]), 2);
  var ev = [].concat(s.step(disks(['/var', 95])), s.step(disks(['/var', 88])), s.step(disks(['/var', 95])));
  assert.deepStrictEqual(ev, []);
});

/* =============================================================================================
 * RT-14 down: se recupera al dejar de estar CAÍDO aunque siga degradado (P2)
 * ========================================================================================== */

test('RT-14 / P2 down se recupera al dejar de estar caído aunque el objetivo siga DEGRADADO', function () {
  var s = sim({ n: 1, notify: notifyDe({ latency: false, other: false }) });
  assert.deepStrictEqual(ks(s.step({ ports: [{ port: 22, open: false }] })), ['alert:down@on']);
  var r = res({ ping: ping({ avg: 500 }) });
  assert.strictEqual(r.status, 'degraded');
  assert.deepStrictEqual(ks(s.step(r)), ['recovery:down@on'], 'no espera a que terminen las degradaciones');
});

test('RT-14 down: un resultado «unknown» no recupera ni cuenta', function () {
  var s = sim({ n: 2 });
  repetir(s, { ports: [{ port: 22, open: false }] }, 2);
  assert.deepStrictEqual(s.step({ manual: { status: 'unknown', reasons: [] } }), []);
  assert.deepStrictEqual(s.keys(), ['down']);
});

/* =============================================================================================
 * RT-02. Certificado vencido y caída
 * ========================================================================================== */

test('RT-02 solo certificado vencido, down y certExpired activos: un único aviso de certExpired y ninguno de down', function () {
  var s = sim({ n: 2 });
  var todo = repetir(s, { ssl: { daysLeft: -3 } }, 6);
  assert.deepStrictEqual(ks(todo), ['alert:certExpired@on']);
  assert.ok(!todo.some(function (e) { return e.type === 'down'; }));
  assert.deepStrictEqual(s.keys(), ['certExpired']);
});

test('RT-02 solo certificado vencido con certExpired desactivado y down activo: no se envía nada', function () {
  var s = sim({ n: 1, notify: notifyDe({ certExpired: false }) });
  assert.deepStrictEqual(repetir(s, { ssl: { daysLeft: -3 } }, 5), []);
  assert.deepStrictEqual(s.keys(), []);
});

test('RT-02 puerto cerrado y certificado vencido con ambos tipos activos: dos avisos independientes en el mismo resultado', function () {
  var s = sim({ n: 2 });
  var raw = { ports: [{ port: 443, open: false }], ssl: { daysLeft: -3 } };
  assert.deepStrictEqual(s.step(raw), []);
  var ev = s.step(raw);
  assert.deepStrictEqual(ks(ev).sort(), ['alert:certExpired@on', 'alert:down@on']);
  var down = ev.filter(function (e) { return e.type === 'down'; })[0];
  var cert = ev.filter(function (e) { return e.type === 'certExpired'; })[0];
  assert.ok(down.reasons.every(function (t) { return !/Certificado/.test(t); }), 'el motivo de down no incluye el del certificado: ' + down.reasons);
  assert.ok(down.reasons.some(function (t) { return /Puerto 443/.test(t); }));
  assert.ok(cert.reasons.every(function (t) { return /Certificado/.test(t); }), 'el motivo de certExpired es solo el del certificado');
});

test('RT-02 el estado «down» solo por certificado vencido no cuenta como caída para down', function () {
  var r = res({ ssl: { daysLeft: -1 } });
  assert.strictEqual(r.status, 'down');
  var s = sim({ n: 1, notify: notifyDe({ certExpired: false, other: true }) });
  assert.deepStrictEqual(s.step(r), []);
});

/* =============================================================================================
 * Salvaguarda «Sin respuesta»
 * ========================================================================================== */

test('Salvaguarda: status «down» sin ningún motivo down:true se trata como caída con motivo «Sin respuesta»', function () {
  [[], [{ level: 'info', text: 'Sin respuesta ICMP', down: false, code: 'icmp' }]].forEach(function (reasons) {
    var s = sim({ n: 2 });
    var r = { id: 't1', ts: 1, status: 'down', reasons: reasons };
    assert.deepStrictEqual(s.step(r), []);
    var ev = s.step(r);
    assert.deepStrictEqual(ks(ev), ['alert:down@on']);
    assert.deepStrictEqual(ev[0].reasons, ['Sin respuesta']);
    assert.deepStrictEqual(s.step({ id: 't1', ts: 2, status: 'up', reasons: [] }).map(function (e) { return e.kind + ':' + e.type; }), ['recovery:down']);
  });
});

test('Salvaguarda: no se aplica si hay algún motivo down:true (el certificado vencido solo no se convierte en «caída»)', function () {
  var s = sim({ n: 1 });
  var ev = s.step(res({ ssl: { daysLeft: -2 } }));
  assert.deepStrictEqual(ks(ev), ['alert:certExpired@on']);
  assert.ok(!ev.some(function (e) { return e.reasons.indexOf('Sin respuesta') >= 0; }));
});

test('Salvaguarda: con down desactivado no genera nada', function () {
  var s = sim({ n: 1, notify: notifyDe({ down: false }) });
  assert.deepStrictEqual(s.step({ id: 't1', ts: 1, status: 'down', reasons: [] }), []);
  assert.deepStrictEqual(s.keys(), []);
});

/* =============================================================================================
 * RT-03. Tipos independientes
 * ========================================================================================== */

test('RT-03 varios tipos en un resultado: cada uno avisa por separado y un tipo desactivado no afecta a los demás', function () {
  var raw = { ports: [{ port: 22, open: false }], ping: ping({ avg: 500 }), ssl: { daysLeft: 3, authorized: false }, agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 }, disks: [{ mount: '/', usedPct: 95 }] }) };
  var s = sim({ n: 1 });
  var tipos = s.step(raw).map(function (e) { return e.type; }).sort();
  assert.deepStrictEqual(tipos, ['certExpiring', 'certTrust', 'disk', 'down', 'latency', 'resources']);
  var s2 = sim({ n: 1, notify: notifyDe({ disk: false }) });
  var t2 = s2.step(raw).map(function (e) { return e.type; }).sort();
  assert.deepStrictEqual(t2, ['certExpiring', 'certTrust', 'down', 'latency', 'resources']);
  assert.ok(!Object.keys(s2.counters).some(function (k) { return /^disk/.test(k); }), 'el tipo desactivado no tiene contadores');
});

test('RT-03 N=1 con los tipos en conflicto a la vez: cada tipo avisa una vez por episodio (sección 5)', function () {
  var raw = { ports: [{ port: 22, open: false }], ssl: { daysLeft: -1, authorized: false }, agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 }, disks: [{ mount: '/', usedPct: 95 }] }) };
  var s = sim({ n: 1 });
  var primero = s.step(raw);
  assert.strictEqual(primero.length, 5, ks(primero).join(', '));
  assert.deepStrictEqual(repetir(s, raw, 5), [], 'ninguno se repite');
});

test('RT-03 los avisos de un tipo no interfieren con los contadores de otro (N=2, uno llega y el otro no)', function () {
  var s = sim({ n: 2 });
  var a = { ports: [{ port: 22, open: false }], ping: ping({ avg: 500 }) };
  s.step(a);
  var ev = s.step({ ports: [{ port: 22, open: false }], ping: ping() });
  assert.deepStrictEqual(ks(ev), ['alert:down@on'], 'latency solo llevaba 1 resultado y se reinició');
});

/* =============================================================================================
 * RT-04. Un tipo activo posee su familia
 * ========================================================================================== */

[1, 2].forEach(function (n) {
  test('RT-04 con N=' + n + ': latency crit avisado y luego latency warn: sin aviso other y sin recuperación falsa', function () {
    var s = sim({ n: n });
    repetir(s, { ping: ping({ avg: 500 }) }, n);
    var ev = repetir(s, { ping: ping({ avg: 200 }) }, 4);
    assert.deepStrictEqual(ev, [], 'warn de la familia con latency avisado no genera nada');
    assert.deepStrictEqual(s.keys(), ['latency|latency'], 'la clave sigue viva');
    assert.deepStrictEqual(ks(s.step({ ping: ping() })), ['recovery:latency:latency@on'], 'una única recuperación, del tipo latency');
  });

  test('RT-04 con N=' + n + ': other warn avisado y luego latency crit: el aviso crit releva en silencio la clave other', function () {
    var s = sim({ n: n });
    assert.deepStrictEqual(ks(repetir(s, { ping: ping({ avg: 200 }) }, n)), ['alert:other:latency@on']);
    var ev = repetir(s, { ping: ping({ avg: 500 }) }, n);
    assert.deepStrictEqual(ks(ev), ['alert:latency:latency@on'], 'solo el aviso específico, sin recuperación de other');
    assert.deepStrictEqual(s.keys(), ['latency|latency'], 'la clave other se eliminó en silencio');
    assert.deepStrictEqual(repetir(s, { ping: ping({ avg: 600 }) }, 3), []);
    assert.deepStrictEqual(ks(s.step({ ping: ping() })), ['recovery:latency:latency@on'], 'ni doble recuperación ni recuperación de other');
  });

  test('RT-04 con N=' + n + ': resources: other (cpu warn) -> resources (cpu crit) -> warn -> sano, sin duplicados', function () {
    var s = sim({ n: n });
    var cpu = function (p) { return { agent: agent({ cpu: { usagePct: p, ioWaitPct: 1 } }) }; };
    assert.deepStrictEqual(ks(repetir(s, cpu(90), n)), ['alert:other:cpu@on']);
    assert.deepStrictEqual(ks(repetir(s, cpu(99), n)), ['alert:resources:cpu@on']);
    assert.deepStrictEqual(s.keys(), ['resources|cpu']);
    assert.deepStrictEqual(repetir(s, cpu(90), 3), [], 'de vuelta a warn: sin aviso ni recuperación');
    assert.deepStrictEqual(ks(s.step(cpu(10))), ['recovery:resources:cpu@on']);
    assert.deepStrictEqual(s.keys(), []);
  });

  test('RT-04 con N=' + n + ': certExpiring avisado y luego certificado vencido: avisa certExpired y descarta certExpiring en silencio', function () {
    var s = sim({ n: n });
    repetir(s, { ssl: { daysLeft: 3 } }, n);
    assert.deepStrictEqual(s.keys(), ['certExpiring']);
    var ev = repetir(s, { ssl: { daysLeft: -1 } }, n);
    assert.deepStrictEqual(ks(ev), ['alert:certExpired@on'], 'sin recuperación de certExpiring ni doble aviso');
    assert.deepStrictEqual(s.keys(), ['certExpired']);
    assert.deepStrictEqual(repetir(s, { ssl: { daysLeft: -2 } }, 3), []);
  });
});

test('RT-04 el tipo específico desactivado no «posee» la familia: latency warn sigue avisando como other', function () {
  var s = sim({ n: 1, notify: notifyDe({ latency: false }) });
  assert.deepStrictEqual(ks(s.step({ ping: ping({ avg: 500 }) })), [], 'latency crit desactivado: nada');
  assert.deepStrictEqual(ks(s.step({ ping: ping({ avg: 200 }) })), ['alert:other:latency@on']);
});

test('RT-04 other warn y otro code crítico son familias distintas (ttfb crit no releva a other latency)', function () {
  var s = sim({ n: 1 });
  s.step({ ping: ping({ avg: 200 }) });
  var ev = s.step({ ping: ping({ avg: 200 }), http: { status: 200, ttfbMs: 3000 } });
  assert.deepStrictEqual(ks(ev), ['alert:latency:ttfb@on']);
  assert.deepStrictEqual(s.keys(), ['latency|ttfb', 'other|latency']);
});

/* =============================================================================================
 * RT-14 / RT-20: casos especiales por tipo
 * ========================================================================================== */

test('RT-20 certExpired se recupera con «renovado» cuando r.ssl es medible y ya no hay motivos ssl', function () {
  var s = sim({ n: 1 });
  s.step({ ssl: { daysLeft: -4 } });
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 365 } })), ['recovery:certExpired@on']);
});

test('RT-04/RT-20 certExpired renovado con validez corta (N=1): recupera certExpired y avisa certExpiring una sola vez', function () {
  var s = sim({ n: 1 });
  s.step({ ssl: { daysLeft: -2 } });
  var paso = [];
  for (var i = 0; i < 5; i++) paso.push(ks(s.step({ ssl: { daysLeft: 10 } })).sort());
  assert.deepStrictEqual(paso[0], ['alert:certExpiring@warn', 'recovery:certExpired@on']);
  for (var j = 1; j < 5; j++) assert.deepStrictEqual(paso[j], [], 'resultado ' + (j + 2) + ': nada');
  assert.deepStrictEqual(s.keys(), ['certExpiring']);
});

test('RT-04/RT-20 certExpired renovado con validez corta (N=2): recupera al primer resultado y avisa certExpiring tras N', function () {
  var s = sim({ n: 2 });
  repetir(s, { ssl: { daysLeft: -2 } }, 2);
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 10 } })), ['recovery:certExpired@on']);
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 10 } })), ['alert:certExpiring@warn']);
  assert.deepStrictEqual(repetir(s, { ssl: { daysLeft: 10 } }, 5), []);
  assert.deepStrictEqual(s.keys(), ['certExpiring']);
});

test('RT-20 certTrust: recuperación «confiable» solo con r.ssl medible', function () {
  var s = sim({ n: 1 });
  s.step({ ssl: { daysLeft: 300, authorized: false } });
  assert.deepStrictEqual(s.step({ ssl: { error: 'x' } }).map(function (e) { return e.kind + ':' + e.type; }), ['alert:other'], 'ilegible: solo other (si activo), sin recuperar certTrust');
  assert.ok(s.keys().indexOf('certTrust') >= 0);
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 300, authorized: true } })).sort(), ['recovery:certTrust@on', 'recovery:other:ssl@on']);
});

test('RT-20 disk: dos particiones simultáneas generan dos avisos independientes y se recuperan por separado', function () {
  var s = sim({ n: 1 });
  var ev = s.step(disks(['/', 88], ['/var', 95]));
  assert.deepStrictEqual(ks(ev).sort(), ['alert:disk:/@warn', 'alert:disk:/var@crit']);
  assert.deepStrictEqual(ks(s.step(disks(['/', 88], ['/var', 40]))), ['recovery:disk:/var@on']);
  assert.deepStrictEqual(s.keys(), ['disk|%2F']);
  assert.deepStrictEqual(ks(s.step(disks(['/', 40], ['/var', 40]))), ['recovery:disk:/@on']);
});

test('RT-20 disk: dos particiones con N=2 llevan contadores propios', function () {
  var s = sim({ n: 2 });
  s.step(disks(['/', 88], ['/var', 40]));
  var ev = s.step(disks(['/', 88], ['/var', 88]));
  assert.deepStrictEqual(ks(ev), ['alert:disk:/@warn'], '/var solo lleva un resultado');
});

test('RT-20 other: una clave por code (agente sin respuesta y una advertencia de cpu son dos avisos)', function () {
  var s = sim({ n: 1 });
  var r = res({ agent: { error: 'x' } });
  var extra = { id: 't1', ts: 5, status: 'degraded', reasons: r.reasons.concat([{ level: 'warn', text: 'rarito', down: false, code: 'zzz' }]), agent: { error: 'x' } };
  assert.deepStrictEqual(ks(s.step(extra)).sort(), ['alert:other:agent@on', 'alert:other:zzz@on']);
  assert.deepStrictEqual(s.keys(), ['other|agent', 'other|zzz']);
});

test('RT-20 disk: dos agentes (dos objetivos) con la misma ruta «/» usan claves por objetivo (clave con id)', function () {
  assert.notStrictEqual(AT.encodeKey('a1', 'disk', '/'), AT.encodeKey('a2', 'disk', '/'));
});

/* =============================================================================================
 * RT-15. Resultado «medible»
 * ========================================================================================== */

test('RT-15 pérdida del 100 % con latency avisado: no hay «Latencia normal» y la clave se mantiene', function () {
  var s = sim({ n: 1 });
  s.step({ ping: ping({ avg: 500 }) });
  var perdido = { ports: [{ port: 22, open: false }], ping: { sent: 4, received: 0, lossPct: 100 } };
  var ev = s.step(perdido);
  assert.ok(!recoveriesOf(ev).length, 'sin recuperaciones: ' + ks(ev).join(', '));
  assert.ok(s.keys().indexOf('latency|latency') >= 0);
  assert.deepStrictEqual(ks(s.step({ ping: ping() })).sort(), ['recovery:down@on', 'recovery:latency:latency@on'], 'vuelve a medirse y se recupera (y la caída también)');
});

test('RT-15 pérdida del 100 % con latency avisado y down desactivado: no sale ningún mensaje', function () {
  var s = sim({ n: 1, notify: notifyDe({ down: false }) });
  s.step({ ping: ping({ avg: 500 }) });
  assert.deepStrictEqual(s.step({ ports: [{ port: 22, open: false }], ping: { sent: 4, received: 0, lossPct: 100 } }), []);
});

test('RT-15 un resultado no medible no cuenta como limpio: el contador se conserva (N=2: problema, no medible, problema avisa)', function () {
  var s = sim({ n: 2, notify: notifyDe({ down: false }) });
  s.step({ ping: ping({ avg: 500 }) });
  s.step({ ports: [{ port: 22, open: false }], ping: { sent: 4, received: 0, lossPct: 100 } });
  assert.deepStrictEqual(ks(s.step({ ping: ping({ avg: 500 }) })), ['alert:latency:latency@on']);
});

test('RT-15 un resultado medible y sano sí reinicia el contador (N=2: problema, sano, problema no avisa)', function () {
  var s = sim({ n: 2 });
  s.step({ ping: ping({ avg: 500 }) });
  s.step({ ping: ping() });
  assert.deepStrictEqual(s.step({ ping: ping({ avg: 500 }) }), []);
});

test('RT-15 agente caído con resources y disk avisados: no hay recuperaciones y las claves se mantienen (RT-16)', function () {
  var s = sim({ n: 1, notify: notifyDe({ other: false }) });
  s.step({ agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 }, disks: [{ mount: '/var', usedPct: 88 }] }) });
  assert.deepStrictEqual(s.keys(), ['disk|%2Fvar', 'resources|cpu']);
  var ev = repetir(s, { agent: { error: 'sin respuesta' } }, 4);
  assert.deepStrictEqual(ev, [], 'sin recuperaciones');
  assert.deepStrictEqual(s.keys(), ['disk|%2Fvar', 'resources|cpu']);
});

test('RT-16 con el agente caído solo el tipo other avisa «Agente sin respuesta», una sola vez', function () {
  var s = sim({ n: 1 });
  s.step({ agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 }, disks: [{ mount: '/var', usedPct: 88 }] }) });
  var ev = repetir(s, { agent: { error: 'sin respuesta' } }, 4);
  assert.deepStrictEqual(ks(ev), ['alert:other:agent@on']);
  assert.ok(ev[0].reasons[0].indexOf('Agente sin respuesta') === 0, ev[0].reasons[0]);
});

test('RT-16 cuando el agente vuelve y la condición sigue, no se repite el aviso; solo recupera other', function () {
  var s = sim({ n: 1 });
  var malo = { agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 }, disks: [{ mount: '/var', usedPct: 88 }] }) };
  s.step(malo);
  s.step({ agent: { error: 'x' } });
  var ev = s.step(malo);
  assert.deepStrictEqual(ks(ev), ['recovery:other:agent@on'], 'solo vuelve el agente; resources y disk siguen sin repetir');
  assert.deepStrictEqual(repetir(s, malo, 3), []);
});

test('RT-16 cuando el agente vuelve y la condición ya no existe, se avisan las recuperaciones de resources y disk', function () {
  var s = sim({ n: 1 });
  s.step({ agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 }, disks: [{ mount: '/var', usedPct: 88 }] }) });
  s.step({ agent: { error: 'x' } });
  var ev = s.step({ agent: agent({ disks: [{ mount: '/var', usedPct: 40 }] }) });
  assert.deepStrictEqual(ks(ev).sort(), ['recovery:disk:/var@on', 'recovery:other:agent@on', 'recovery:resources:cpu@on']);
});

test('RT-15 certificado ilegible con certExpiring/certExpired avisados: no recupera y mantiene las claves', function () {
  [['certExpiring', { ssl: { daysLeft: 3 } }], ['certExpired', { ssl: { daysLeft: -3 } }], ['certTrust', { ssl: { daysLeft: 300, authorized: false } }]].forEach(function (c) {
    var s = sim({ n: 1, notify: notifyDe({ other: false }) });
    s.step(c[1]);
    assert.deepStrictEqual(s.keys(), [c[0]]);
    assert.deepStrictEqual(repetir(s, { ssl: { error: 'ECONNRESET' } }, 3), [], c[0]);
    assert.deepStrictEqual(s.keys(), [c[0]], c[0]);
  });
});

test('RT-15 ttfb: una respuesta HTTP con error o sin ttfbMs numérico no es medible; con ttfbMs normal sí recupera', function () {
  var s = sim({ n: 1, notify: notifyDe({ down: false }) });
  s.step({ http: { status: 200, ttfbMs: 3000 } });
  assert.deepStrictEqual(s.step({ http: { error: 'refused' } }), [], 'con error');
  assert.deepStrictEqual(s.step({ http: { status: 500, ttfbMs: 20 } }), [], 'con motivo http');
  assert.deepStrictEqual(s.step({ manual: { status: 'up', reasons: [], http: { status: 200 } } }), [], 'sin ttfbMs numérico');
  assert.deepStrictEqual(s.keys(), ['latency|ttfb']);
  assert.deepStrictEqual(ks(s.step({ http: { status: 200, ttfbMs: 100 } })), ['recovery:latency:ttfb@on']);
});

test('RT-15 latency: un ping con received 0 no es medible aunque no haya otro motivo (ICMP bloqueado)', function () {
  var s = sim({ n: 1 });
  s.step({ ping: ping({ avg: 500 }) });
  var ev = s.step({ ports: [{ port: 80, open: true }], ping: { sent: 4, received: 0, lossPct: 100 } });
  assert.deepStrictEqual(ev, [], 'ping bloqueado: ni recupera ni avisa caída');
  assert.deepStrictEqual(s.keys(), ['latency|latency']);
});

test('RT-15 other con code no listado: se recupera con cualquier resultado que no sea unknown', function () {
  var s = sim({ n: 1 });
  s.step({ manual: { status: 'degraded', reasons: [{ level: 'warn', text: 'x', down: false, code: 'inventado' }] } });
  assert.deepStrictEqual(s.step({ manual: { status: 'unknown', reasons: [] } }), []);
  assert.deepStrictEqual(ks(s.step({ manual: { status: 'up', reasons: [] } })), ['recovery:other:inventado@on']);
});

/* =============================================================================================
 * RT-13. Limpieza silenciosa
 * ========================================================================================== */

var FUENTES = [
  ['agent (resources)', { agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 } }) }, 'resources|cpu', { ping: ping() }],
  ['agent (disk)', disks(['/var', 88]), 'disk|%2Fvar', { ping: ping() }],
  ['agent (other agent)', { agent: { error: 'x' } }, 'other|agent', { ping: ping() }],
  ['ssl (certExpiring)', { ssl: { daysLeft: 3 } }, 'certExpiring', { ping: ping() }],
  ['ssl (certExpired)', { ssl: { daysLeft: -3 } }, 'certExpired', { ping: ping() }],
  ['ssl (certTrust)', { ssl: { daysLeft: 300, authorized: false } }, 'certTrust', { ping: ping() }],
  ['http (ttfb)', { http: { status: 200, ttfbMs: 3000 } }, 'latency|ttfb', { ping: ping() }],
  ['ping (latency)', { ping: ping({ avg: 500 }) }, 'latency|latency', { http: { status: 200, ttfbMs: 10 } }],
  ['ping no disponible (latency)', { ping: ping({ avg: 500 }) }, 'latency|latency', { ping: { unavailable: true }, http: { status: 200, ttfbMs: 10 } }]
];

FUENTES.forEach(function (f) {
  [1, 2].forEach(function (n) {
    test('RT-13 fuente ausente (' + f[0] + ', N=' + n + '): la clave se elimina en silencio, sin recuperación', function () {
      var s = sim({ n: n });
      repetir(s, f[1], n);
      assert.deepStrictEqual(s.keys(), [f[2]]);
      var ev = s.step(f[3]);
      assert.deepStrictEqual(ev, [], 'sin mensajes de recuperación');
      assert.deepStrictEqual(s.keys(), [], 'clave eliminada');
    });
  });
});

[1, 2].forEach(function (n) {
  test('RT-13 partición que desaparece con N=' + n + ': se elimina en silencio tras N resultados consecutivos del agente sin ella', function () {
    var s = sim({ n: n });
    repetir(s, disks(['/var', 88], ['/', 10]), n);
    assert.deepStrictEqual(s.keys(), ['disk|%2Fvar']);
    var todo = [];
    for (var i = 1; i < n; i++) { todo = todo.concat(s.step(disks(['/', 10]))); assert.deepStrictEqual(s.keys(), ['disk|%2Fvar'], 'aún se conserva (paso ' + i + ')'); }
    todo = todo.concat(s.step(disks(['/', 10])));
    assert.deepStrictEqual(todo, [], 'sin mensajes de recuperación');
    assert.deepStrictEqual(s.keys(), [], 'eliminada tras N');
  });
});

test('RT-13 partición que desaparece: si reaparece antes de N resultados la cuenta se reinicia (consecutivos)', function () {
  var s = sim({ n: 2 });
  repetir(s, disks(['/var', 88]), 2);
  s.step(disks(['/', 10]));
  assert.deepStrictEqual(s.step(disks(['/var', 88], ['/', 10])), []);
  assert.deepStrictEqual(s.step(disks(['/', 10])), []);
  assert.deepStrictEqual(s.keys(), ['disk|%2Fvar'], 'solo 1 resultado seguido sin la partición');
});

test('RT-13 partición que desaparece con el agente caído: no cuenta como ausencia (no medible)', function () {
  var s = sim({ n: 1, notify: notifyDe({ other: false }) });
  s.step(disks(['/var', 88]));
  repetir(s, { agent: { error: 'x' } }, 3);
  assert.deepStrictEqual(s.keys(), ['disk|%2Fvar']);
});

test('RT-13 tipo desactivado: sus claves y contadores se eliminan en silencio y las de otros tipos se conservan', function () {
  var s = sim({ n: 1 });
  s.step({ ping: ping({ avg: 500 }), agent: agent({ disks: [{ mount: '/var', usedPct: 88 }] }) });
  assert.deepStrictEqual(s.keys(), ['disk|%2Fvar', 'latency|latency']);
  s.notify = notifyDe({ disk: false });
  var ev = s.step({ ping: ping({ avg: 500 }), agent: agent({ disks: [{ mount: '/var', usedPct: 88 }] }) });
  assert.deepStrictEqual(ev, [], 'sin recuperación falsa');
  assert.deepStrictEqual(s.keys(), ['latency|latency']);
  assert.ok(!Object.keys(s.counters).some(function (k) { return /^disk/.test(k); }));
});

test('RT-13 tipo desactivado con el problema resuelto a la vez: tampoco hay recuperación (el tipo ya no avisa)', function () {
  var s = sim({ n: 1 });
  s.step(disks(['/var', 88]));
  s.notify = notifyDe({ disk: false });
  assert.deepStrictEqual(s.step(disks(['/var', 10])), []);
  assert.deepStrictEqual(s.keys(), []);
});

test('RT-17 reactivar un tipo parte de contadores a cero: el problema ya existente se avisa de nuevo tras N resultados', function () {
  var s = sim({ n: 2 });
  repetir(s, disks(['/var', 88]), 2);
  s.notify = notifyDe({ disk: false });
  repetir(s, disks(['/var', 88]), 3);
  assert.deepStrictEqual(s.keys(), []);
  s.notify = notifyDe();
  assert.deepStrictEqual(s.step(disks(['/var', 88])), [], 'primer resultado tras activar: aún no');
  assert.deepStrictEqual(ks(s.step(disks(['/var', 88]))), ['alert:disk:/var@warn'], 'al llegar a N avisa aunque se hubiera avisado antes');
});

test('RT-17 los cambios de «recovery» aplican a los resultados siguientes', function () {
  var s = sim({ n: 1 });
  s.step({ ping: ping({ avg: 500 }) });
  s.notify = notifyDe({ recovery: false });
  assert.deepStrictEqual(s.step({ ping: ping() }), [], 'recovery apagado: silencio');
  assert.deepStrictEqual(s.keys(), []);
  s.notify = notifyDe();
  s.step({ ping: ping({ avg: 500 }) });
  assert.deepStrictEqual(ks(s.step({ ping: ping() })), ['recovery:latency:latency@on']);
});

/* =============================================================================================
 * RT-18 y RT-19. Umbrales e histéresis de disco
 * ========================================================================================== */

test('RT-18 un umbral más alto que hace desaparecer el motivo produce la recuperación en el resultado siguiente', function () {
  var s = sim({ n: 1 });
  s.step(disks(['/var', 88]));
  var th2 = Object.assign({}, TH, { diskWarnPct: 95, diskCritPct: 98 });
  s.th = th2;
  assert.deepStrictEqual(ks(s.step(disks(['/var', 88]))), ['recovery:disk:/var@on']);
});

test('RT-18 un umbral que baja el nivel (crit -> warn) baja la clave en silencio', function () {
  var s = sim({ n: 1 });
  s.step(disks(['/var', 92]));
  assert.strictEqual(s.alerted['disk|%2Fvar'], 'crit');
  s.th = Object.assign({}, TH, { diskCritPct: 97 });
  assert.deepStrictEqual(s.step(disks(['/var', 92])), []);
  assert.strictEqual(s.alerted['disk|%2Fvar'], 'warn');
});

test('RT-18 sin cambios de resultado, cambiar los umbrales no genera mensajes por sí mismo', function () {
  var s = sim({ n: 1 });
  s.step({ ssl: { daysLeft: 20 } });
  s.th = Object.assign({}, TH, { sslWarnDays: 45 });
  assert.deepStrictEqual(s.step({ ssl: { daysLeft: 20 } }), []);
});

test('RT-19 histéresis: entre warn-2 y warn la partición se mantiene sin avisar; por debajo recupera (umbral 85)', function () {
  var s = sim({ n: 1 });
  s.step(disks(['/var', 88]));
  assert.deepStrictEqual(s.step(disks(['/var', 84])), [], '84 %: aún dentro de la banda de histéresis');
  assert.deepStrictEqual(s.step(disks(['/var', 83])), [], '83 % = warn - 2: se mantiene');
  assert.deepStrictEqual(s.keys(), ['disk|%2Fvar']);
  assert.deepStrictEqual(ks(s.step(disks(['/var', 82]))), ['recovery:disk:/var@on'], '82 % < 83: recupera');
});

test('RT-19 histéresis con un umbral de advertencia personalizado (70): se mantiene en 68 y recupera en 67', function () {
  var th = Object.assign({}, TH, { diskWarnPct: 70, diskCritPct: 90 });
  var s = sim({ n: 1, th: th });
  s.step(disks(['/var', 75]));
  assert.deepStrictEqual(s.step(disks(['/var', 68])), []);
  assert.deepStrictEqual(ks(s.step(disks(['/var', 67]))), ['recovery:disk:/var@on']);
});

test('RT-19 al volver a subir dentro de la banda no se repite el aviso (la clave sigue viva)', function () {
  var s = sim({ n: 1 });
  s.step(disks(['/var', 88]));
  s.step(disks(['/var', 84]));
  assert.deepStrictEqual(s.step(disks(['/var', 88])), []);
});

test('RT-19 / sección 5 warn -> crit -> warn: un aviso crit, baja en silencio y no hay recuperación hasta bajar de 83 %', function () {
  var s = sim({ n: 1 });
  assert.deepStrictEqual(ks(s.step(disks(['/var', 88]))), ['alert:disk:/var@warn']);
  assert.deepStrictEqual(ks(s.step(disks(['/var', 92]))), ['alert:disk:/var@crit']);
  assert.deepStrictEqual(s.step(disks(['/var', 88])), []);
  assert.strictEqual(s.alerted['disk|%2Fvar'], 'warn');
  assert.deepStrictEqual(s.step(disks(['/var', 84])), []);
  assert.deepStrictEqual(ks(s.step(disks(['/var', 82]))), ['recovery:disk:/var@on']);
});

test('RT-19 la histéresis es solo del disco: cpu en 84 % (bajo el umbral 85) recupera de inmediato', function () {
  var s = sim({ n: 1 });
  s.step({ agent: agent({ cpu: { usagePct: 99, ioWaitPct: 1 } }) });
  assert.deepStrictEqual(ks(s.step({ agent: agent({ cpu: { usagePct: 84, ioWaitPct: 1 } }) })), ['recovery:resources:cpu@on']);
});

test('RT-19 en la banda de histéresis, un nuevo cruce crítico escala a crit', function () {
  var s = sim({ n: 1 });
  s.step(disks(['/var', 88]));
  s.step(disks(['/var', 84]));
  assert.deepStrictEqual(ks(s.step(disks(['/var', 95]))), ['alert:disk:/var@crit']);
});

/* =============================================================================================
 * RT-23. Migración desde 2.4.0 en la decisión («legacy» y nivel «m»)
 * ========================================================================================== */

test('RT-23 (a) legacy con el objetivo «up» y recovery activo: se avisa «RECUPERADO» una vez y se borra la clave', function () {
  var s = sim({ n: 2, alerted: { legacy: 'on' } });
  var ev = s.step({ ping: ping() });
  assert.deepStrictEqual(ev.map(function (e) { return e.kind + ':' + e.type; }), ['recovery:legacy']);
  assert.deepStrictEqual(s.keys(), []);
  assert.deepStrictEqual(s.step({ ping: ping() }), []);
});

test('RT-23 (a) legacy con el objetivo «up» y recovery apagado: se borra en silencio', function () {
  var s = sim({ n: 2, alerted: { legacy: 'on' }, notify: notifyDe({ recovery: false }) });
  assert.deepStrictEqual(s.step({ ping: ping() }), []);
  assert.deepStrictEqual(s.keys(), []);
});

test('RT-23 (b) legacy con el objetivo aún degradado: las condiciones de tipos activos se adoptan sin enviar nada', function () {
  var s = sim({ n: 2, alerted: { legacy: 'on' } });
  var raw = { ping: ping({ avg: 500 }), agent: agent({ disks: [{ mount: '/var', usedPct: 88 }] }) };
  assert.deepStrictEqual(s.step(raw), []);
  assert.deepStrictEqual(s.keys(), ['disk|%2Fvar', 'latency|latency'], 'adoptadas y legacy eliminado');
  assert.deepStrictEqual(repetir(s, raw, 4), [], 'y no se avisan después');
  var ev = s.step({ ping: ping(), agent: agent({ disks: [{ mount: '/var', usedPct: 40 }] }) });
  assert.deepStrictEqual(ks(ev).sort(), ['recovery:disk:/var@on', 'recovery:latency:latency@on'], 'su recuperación sí se avisará');
});

test('RT-23 (b) legacy degradado: las condiciones de tipos desactivados no se adoptan', function () {
  var s = sim({ n: 1, alerted: { legacy: 'on' }, notify: notifyDe({ latency: false, other: false, disk: false }) });
  assert.deepStrictEqual(s.step({ ping: ping({ avg: 500 }), agent: agent({ disks: [{ mount: '/var', usedPct: 88 }] }) }), []);
  assert.deepStrictEqual(s.keys(), []);
});

test('RT-23 (b) legacy degradado adopta también las advertencias (other)', function () {
  var s = sim({ n: 2, alerted: { legacy: 'on' } });
  assert.deepStrictEqual(s.step({ ping: ping({ avg: 200 }) }), []);
  assert.deepStrictEqual(s.keys(), ['other|latency']);
});

test('RT-23 (c) legacy que pasa a «down»: se elimina en silencio y se aplica el ciclo normal de down (aviso tras N)', function () {
  var s = sim({ n: 2, alerted: { legacy: 'on' } });
  var raw = { ports: [{ port: 22, open: false }] };
  assert.deepStrictEqual(s.step(raw), []);
  assert.ok(s.keys().indexOf('legacy') < 0, 'legacy eliminado');
  assert.deepStrictEqual(ks(s.step(raw)), ['alert:down@on']);
});

test('RT-23 legacy con un resultado «unknown»: no se toca (espera al primer resultado útil)', function () {
  var s = sim({ n: 2, alerted: { legacy: 'on' } });
  assert.deepStrictEqual(s.step({ manual: { status: 'unknown', reasons: [] } }), []);
  assert.deepStrictEqual(s.keys(), ['legacy']);
});

test('RT-23 clave «down» migrada (nivel m) con el objetivo todavía caído por otros motivos: sin avisar y pasa a «on»', function () {
  var s = sim({ n: 2, alerted: { down: 'm' } });
  var raw = { ports: [{ port: 22, open: false }] };
  assert.deepStrictEqual(repetir(s, raw, 5), []);
  assert.strictEqual(s.alerted.down, 'on');
  assert.deepStrictEqual(ks(s.step({ ping: ping() })), ['recovery:down@on'], 'su recuperación se avisa normalmente');
});

test('RT-23 clave «down» migrada y ahora solo certificado vencido con certExpired activo: transferencia silenciosa a certExpired', function () {
  [1, 2].forEach(function (n) {
    var s = sim({ n: n, alerted: { down: 'm' } });
    var todo = repetir(s, { ssl: { daysLeft: -5 } }, 4);
    assert.deepStrictEqual(todo, [], 'N=' + n + ': ni «RECUPERADO» ni «VENCIDO» espurios: ' + ks(todo).join(', '));
    assert.deepStrictEqual(s.keys(), ['certExpired']);
    assert.strictEqual(s.alerted.certExpired, 'on');
  });
});

test('RT-23 transferencia silenciosa: luego, al renovar el certificado, se avisa la recuperación de certExpired', function () {
  var s = sim({ n: 2, alerted: { down: 'm' } });
  s.step({ ssl: { daysLeft: -5 } });
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 400 } })), ['recovery:certExpired@on']);
});

test('RT-23/QA-T3 clave «down» migrada y solo certificado vencido con certExpired DESACTIVADO: no se recupera mientras el estado sea «down»; sí cuando deja de serlo', function () {
  var s = sim({ n: 1, alerted: { down: 'm' }, notify: notifyDe({ certExpired: false }) });
  assert.deepStrictEqual(repetir(s, { ssl: { daysLeft: -5 } }, 3), [], 'sigue siendo down por el certificado: sin RECUPERADO');
  assert.deepStrictEqual(s.keys(), ['down']);
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: 300 } })), ['recovery:down@on'], 'al dejar de estar down se recupera');
  assert.deepStrictEqual(s.keys(), []);
});

test('RT-23 clave «down» migrada que se recupera (objetivo «up»): recuperación normal', function () {
  var s = sim({ n: 2, alerted: { down: 'm' } });
  assert.deepStrictEqual(ks(s.step({ ping: ping() })), ['recovery:down@on']);
});

test('RT-23 clave «down» migrada con resultado «unknown»: sin efecto', function () {
  var s = sim({ n: 2, alerted: { down: 'm' } });
  assert.deepStrictEqual(s.step({ manual: { status: 'unknown', reasons: [] } }), []);
  assert.strictEqual(s.alerted.down, 'm');
});

test('RT-23 la transferencia solo vale para claves migradas: un down real «on» que se recupera con el certificado vencido avisa RECUPERADO y luego VENCIDO', function () {
  var s = sim({ n: 2, alerted: { down: 'on' } });
  var ev1 = s.step({ ssl: { daysLeft: -5 } });
  assert.deepStrictEqual(ks(ev1), ['recovery:down@on'], 'recuperación de la caída real');
  var ev2 = s.step({ ssl: { daysLeft: -5 } });
  assert.deepStrictEqual(ks(ev2), ['alert:certExpired@on'], 'y tras N, el certificado vencido');
  assert.deepStrictEqual(s.keys(), ['certExpired']);
});

test('RT-23 down real «on» recuperado con el certificado vencido y N=1: RECUPERADO y VENCIDO en el mismo resultado', function () {
  var s = sim({ n: 1, alerted: { down: 'on' } });
  assert.deepStrictEqual(ks(s.step({ ssl: { daysLeft: -5 } })).sort(), ['alert:certExpired@on', 'recovery:down@on']);
});

test('RT-23 caída migrada (m) con puerto cerrado y certificado vencido a la vez: no hay aviso de down y certExpired sigue el ciclo normal', function () {
  var s = sim({ n: 2, alerted: { down: 'm' } });
  var raw = { ports: [{ port: 443, open: false }], ssl: { daysLeft: -5 } };
  assert.deepStrictEqual(s.step(raw), []);
  assert.deepStrictEqual(ks(s.step(raw)), ['alert:certExpired@on']);
  assert.strictEqual(s.alerted.down, 'on');
});

/* =============================================================================================
 * RT-24. Equivalencia con 2.4.0 (migración con notifyDegraded falso)
 * ========================================================================================== */

test('RT-24 secuencia grabada de 2.4.0 (N=2, notifyDegraded falso): mismos avisos que antes', function () {
  var migrada = { down: true, recovery: true, certExpired: true, certExpiring: false, certTrust: false, latency: false, resources: false, disk: false, other: false };
  var s = sim({ n: 2, notify: migrada });
  var DOWN = { ports: [{ port: 22, open: false }] }, UP = { ping: ping() }, DEGR = { ping: ping({ avg: 500 }), agent: agent({ disks: [{ mount: '/', usedPct: 95 }] }) };
  // [resultado, mensajes esperados de 2.4.0]
  var secuencia = [[DOWN, []], [DOWN, ['CAIDO']], [DOWN, []], [UP, ['RECUPERADO']], [DEGR, []], [DEGR, []], [UP, []], [DOWN, []], [UP, []], [DOWN, []], [DOWN, ['CAIDO']], [DEGR, ['RECUPERADO']], [UP, []]];
  secuencia.forEach(function (p, i) {
    var ev = s.step(p[0]).map(function (e) { return e.kind === 'recovery' ? 'RECUPERADO' : 'CAIDO'; });
    assert.deepStrictEqual(ev, p[1], 'paso ' + (i + 1));
  });
});

test('RT-24 con notifyDegraded verdadero, una degradación se avisa por tipo (diferencia (c): solo los motivos de su tipo)', function () {
  var migrada = Object.assign({}, AT.DEFAULT_NOTIFY);
  AT.DEGRADE_TYPES.forEach(function (k) { migrada[k] = true; });
  var s = sim({ n: 2, notify: migrada });
  var raw = { ping: ping({ avg: 500 }), agent: agent({ disks: [{ mount: '/', usedPct: 95 }] }) };
  s.step(raw);
  var ev = s.step(raw);
  assert.deepStrictEqual(ks(ev).sort(), ['alert:disk:/@crit', 'alert:latency:latency@on']);
  ev.forEach(function (e) { assert.strictEqual(e.reasons.length, 1, 'cada evento lleva solo los motivos de su tipo'); });
});

/* =============================================================================================
 * Unknown y no mutación
 * ========================================================================================== */

test('Un resultado «unknown» no tiene efecto: ni eventos, ni cambios de estado, ni de contadores', function () {
  var alerted = { 'latency|latency': 'on', 'disk|%2Fvar': 'warn', down: 'on' };
  var counters = { 'latency|latency': { level: 'on', count: 1, missing: 0 } };
  var s = sim({ n: 1, alerted: alerted, counters: counters });
  var ev = s.step({ id: 't1', ts: 1, status: 'unknown', reasons: [{ level: 'crit', text: 'x', down: true, code: 'port' }] });
  assert.deepStrictEqual(ev, []);
  assert.deepStrictEqual(s.alerted, { 'latency|latency': 'on', 'disk|%2Fvar': 'warn', down: 'on' });
  assert.strictEqual(s.counters['latency|latency'].count, 1);
  assert.strictEqual(s.counters['latency|latency'].level, 'on');
  assert.deepStrictEqual(Object.keys(s.counters), ['latency|latency']);
});

test('Los motivos de nivel «info» (icmp) nunca generan avisos ni cuentan (S6)', function () {
  var s = sim({ n: 1 });
  var r = res({ ports: [{ port: 80, open: true }], ping: { sent: 4, received: 0, lossPct: 100 } });
  assert.ok(r.reasons.some(function (x) { return x.level === 'info'; }));
  assert.deepStrictEqual(repetir(s, r, 3), []);
  assert.deepStrictEqual(s.keys(), []);
});

function congelar(o) {
  if (o && typeof o === 'object') { Object.freeze(o); Object.keys(o).forEach(function (k) { congelar(o[k]); }); }
  return o;
}

test('decideTarget no muta sus entradas y devuelve copias (arquitectura sección 2)', function () {
  var alerted = { 'latency|latency': 'on', 'disk|%2Fvar': 'warn' };
  var counters = { 'disk|%2Fvar': { level: 'warn', count: 3, missing: 0 }, 'cpu': { level: 'on', count: 1, missing: 0 } };
  var notify = notifyDe();
  var r = res({ ping: ping(), agent: agent({ disks: [{ mount: '/var', usedPct: 99 }] }) });
  var th = Object.assign({}, TH);
  var snapshot = JSON.stringify([alerted, counters, notify, r, th]);
  congelar(alerted); congelar(counters); congelar(notify); congelar(r); congelar(th);
  var d;
  assert.doesNotThrow(function () { d = AT.decideTarget({ id: 't1', r: r, alerted: alerted, counters: counters, notify: notify, n: 1, thresholds: th }); });
  assert.strictEqual(JSON.stringify([alerted, counters, notify, r, th]), snapshot);
  assert.notStrictEqual(d.alerted, alerted);
  assert.notStrictEqual(d.counters, counters);
  assert.ok(Array.isArray(d.events));
});

test('decideTarget con un resultado «unknown» tampoco devuelve las mismas referencias', function () {
  var alerted = { down: 'on' }, counters = {};
  var d = AT.decideTarget({ id: 't1', r: { status: 'unknown', reasons: [] }, alerted: alerted, counters: counters, notify: notifyDe(), n: 1, thresholds: TH });
  assert.notStrictEqual(d.alerted, alerted);
  assert.deepStrictEqual(d.alerted, alerted);
});

test('decideTarget tolera entradas incompletas (sin alerted, sin contadores, sin umbrales) y notify parcial usa los valores por defecto', function () {
  var d;
  assert.doesNotThrow(function () { d = AT.decideTarget({ id: 't1', r: res({ ports: [{ port: 1, open: false }] }), n: 1, notify: { disk: true } }); });
  assert.deepStrictEqual(d.events.map(function (e) { return e.type; }), ['down'], 'down activo por defecto');
  assert.doesNotThrow(function () { AT.decideTarget({}); });
});

test('sin __proto__: un alerted con clave «__proto__» no contamina ni rompe la decisión', function () {
  var alerted = JSON.parse('{"__proto__":"on","down":"on"}');
  var d = AT.decideTarget({ id: 't1', r: res({ ping: ping() }), alerted: alerted, counters: {}, notify: notifyDe(), n: 1, thresholds: TH });
  assert.deepStrictEqual(d.events.map(function (e) { return e.type; }), ['down']);
  assert.strictEqual({}.polluted, undefined);
});
