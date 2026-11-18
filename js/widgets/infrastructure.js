/* Infraestructura: CPU/RAM, disco e I/O wait, ancho de banda y servicios del sistema (datos del agente). */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui, store = NOC.store, W = NOC.W;
  var agentOk = function (t) { return W.withAgent(t); };
  function agentOf(t) { var r = store.result(t.id); return r && r.agent; }
  function agentError(a) {
    return W.note('alert', 'El agente no responde', a.error + '. Revisa que el agente esté corriendo, el puerto y el token.');
  }

  // Advertencias del agente (p. ej. 'TLS sin huella fijada'): lectura defensiva, siempre escapadas.
  function agentWarn(a) {
    // El servidor envía `agent.warning` (texto, p. ej. 'TLS sin huella fijada'); también se acepta `warnings` (lista).
    var w = [], out = [];
    if (a && typeof a.warning === 'string') w.push(a.warning);
    if (a && Array.isArray(a.warnings)) w = w.concat(a.warnings);
    w.forEach(function (x) { if (typeof x === 'string' && x) out.push(U.esc(x)); });
    return out.length ? '<div class="hint" role="status" style="color:var(--degraded);margin:6px 0">' + out.join(' · ') + '</div>' : '';
  }

  /* ---------- CPU y RAM ---------- */
  NOC.widgets.register({
    type: 'cpu-ram', title: 'CPU y memoria RAM', icon: 'cpu', target: 'required', accepts: agentOk,
    desc: 'Uso de CPU y RAM en el tiempo para detectar picos de consumo o fugas de memoria; incluye carga y I/O wait.',
    w: 6, h: 9, minW: 4, minH: 6,
    init: function (ctx) { W.bindRange(ctx); },
    render: function (ctx) {
      var t = ctx.target, th = W.th(), a = agentOf(t);
      if (!a) { ctx.body.innerHTML = W.waiting(); return; }
      if (a.error) { ctx.body.innerHTML = agentError(a); return; }
      var cpu = a.cpu.usagePct, mem = a.mem.usedPct, io = a.cpu.ioWaitPct;
      ctx.body.innerHTML = '<div class="pp"><div class="pp-head">' + W.head(t) + '<span class="win__sp"></span>' + W.rangeButtons(ctx.state) + '</div>' +
        '<div class="stat-strip">' + W.stat('CPU', F.num(cpu, 0), '%', W.level(cpu, th.cpuWarnPct, th.cpuCritPct)) +
        W.stat('RAM', F.num(mem, 0), '% · ' + F.mb(a.mem.usedMb) + ' / ' + F.mb(a.mem.totalMb), W.level(mem, th.memWarnPct, th.memCritPct)) +
        W.stat('I/O wait', U.isNum(io) ? F.num(io, 1) : 'n/d', U.isNum(io) ? '%' : '', W.level(io, th.ioWaitWarnPct, th.ioWaitCritPct)) +
        W.stat('Carga (1 min)', a.cpu.load && U.isNum(a.cpu.load[0]) ? a.cpu.load[0].toFixed(2) : 'n/d', U.isNum(a.cpu.cores) && a.cpu.cores > 0 ? '/ ' + U.esc(a.cpu.cores) + ' núcleos' : '') +
        W.stat('Encendido', F.dur(a.uptimeSec), '') + '</div>' + agentWarn(a) +
        '<div class="chart" data-chart></div><div class="legend"><span><i style="background:var(--s1)"></i>CPU</span><span><i style="background:var(--s2)"></i>RAM</span></div></div>';
      NOC.charts.line(ctx.body.querySelector('[data-chart]'), { points: store.series(t.id, W.range(ctx.state)), label: 'CPU y RAM de ' + t.name, yMax: 100,
        yFmt: function (v) { return Math.round(v) + '%'; },
        series: [{ key: 'cpu', name: 'CPU', color: 'var(--s1)', fmt: function (v) { return v.toFixed(1) + ' %'; } }, { key: 'mem', name: 'RAM', color: 'var(--s2)', fmt: function (v) { return v.toFixed(1) + ' %'; } }],
        lines: [{ v: th.cpuWarnPct, color: 'var(--degraded)', label: 'aviso ' + th.cpuWarnPct + '%' }], empty: 'Sin datos del agente' });
    }
  });

  /* ---------- Disco + I/O wait ---------- */
  NOC.widgets.register({
    type: 'disk', title: 'Disco e I/O wait', icon: 'disk', target: 'required', accepts: agentOk,
    desc: 'Porcentaje de llenado de cada disco con alerta al 85–90 % y espera de entrada/salida (I/O wait).',
    w: 6, h: 9, minW: 3, minH: 5,
    render: function (ctx) {
      var t = ctx.target, th = W.th(), a = agentOf(t);
      if (!a) { ctx.body.innerHTML = W.waiting(); return; }
      if (a.error) { ctx.body.innerHTML = agentError(a); return; }
      var disks = (a.disks || []).slice().sort(function (x, y) { return y.usedPct - x.usedPct; });
      var hasIo = store.series(t.id, 120).some(function (p) { return U.isNum(p.io); });
      ctx.body.innerHTML = '<div style="display:flex;flex-direction:column;height:100%;gap:6px"><div class="pp-head">' + W.head(t) + '</div><div style="flex:1 1 55%;min-height:60px;overflow:auto" data-keep-scroll>' +
        (disks.length ? disks.map(function (d) {
          var lv = W.level(d.usedPct, th.diskWarnPct, th.diskCritPct), kind = lv === 'crit' ? 'down' : lv === 'warn' ? 'degraded' : 'up';
          return '<div class="disk"><div class="disk-top"><span class="mount">' + U.esc(d.mount) + ' <span class="muted">' + U.esc(d.fs || '') + '</span></span><span class="num ' + W.levelColor(lv) + '"><b>' + F.num(d.usedPct, 0) + ' %</b> <span class="muted">' + F.gb(d.usedGb) + ' de ' + F.gb(d.totalGb) + '</span> ' +
            (lv ? W.badge(kind, lv === 'crit' ? 'CRÍTICO' : 'ALTO', lv === 'crit' ? 'x-circle' : 'alert') : '') + '</span></div>' +
            '<div class="meter ' + lv + '" role="img" aria-label="' + U.esc(d.mount) + ' al ' + Math.round(d.usedPct) + ' por ciento"><i style="width:' + Math.min(100, d.usedPct) + '%"></i><span class="mark" style="left:' + th.diskWarnPct + '%"></span><span class="mark" style="left:' + th.diskCritPct + '%"></span></div></div>';
        }).join('') : W.note('disk', 'El agente no reportó discos')) + '</div>' +
        '<div class="sec-title">I/O wait (espera de disco)</div><div class="chart" data-chart style="flex:1 1 35%;min-height:60px;height:auto"></div></div>';
      var ch = ctx.body.querySelector('[data-chart]');
      if (!hasIo) ch.innerHTML = '<div class="empty"><span>' + (a.cpu && a.cpu.ioWaitPct == null ? 'Este sistema operativo no reporta I/O wait (solo Linux).' : 'Sin datos') + '</span></div>';
      else NOC.charts.line(ch, { points: store.series(t.id, 120), label: 'I/O wait de ' + t.name, series: [{ key: 'io', name: 'I/O wait', color: 'var(--s3)', area: true, fmt: function (v) { return v.toFixed(1) + ' %'; } }],
        yFmt: function (v) { return Math.round(v) + '%'; }, lines: [{ v: th.ioWaitWarnPct, color: 'var(--degraded)', label: 'aviso' }], empty: 'Sin datos' });
    }
  });

  /* ---------- Ancho de banda ---------- */
  NOC.widgets.register({
    type: 'bandwidth', title: 'Ancho de banda (bps)', icon: 'wifi', target: 'required', accepts: agentOk,
    desc: 'Tráfico entrante y saliente de las interfaces de red en bits por segundo para detectar saturación.',
    w: 6, h: 8, minW: 4, minH: 5,
    init: function (ctx) { W.bindRange(ctx); },
    render: function (ctx) {
      var t = ctx.target, a = agentOf(t);
      if (!a) { ctx.body.innerHTML = W.waiting(); return; }
      if (a.error) { ctx.body.innerHTML = agentError(a); return; }
      if (!a.net) { ctx.body.innerHTML = W.note('wifi', 'Sin datos de tráfico', 'El ancho de banda lo reportan los agentes Linux.'); return; }
      ctx.body.innerHTML = '<div class="pp"><div class="pp-head">' + W.head(t) + '<span class="win__sp"></span>' + W.rangeButtons(ctx.state) + '</div>' +
        '<div class="stat-strip">' + W.stat('Entrante ↓', F.bps(a.net.rxBps)) + W.stat('Saliente ↑', F.bps(a.net.txBps)) + '</div>' +
        '<div class="chart" data-chart></div><div class="legend"><span><i style="background:var(--s1)"></i>Entrante (RX)</span><span><i style="background:var(--s2)"></i>Saliente (TX)</span></div></div>';
      NOC.charts.line(ctx.body.querySelector('[data-chart]'), { points: store.series(t.id, W.range(ctx.state)), label: 'Ancho de banda de ' + t.name, yFmt: F.bps,
        series: [{ key: 'rx', name: 'Entrante', color: 'var(--s1)', area: true, fmt: F.bps }, { key: 'tx', name: 'Saliente', color: 'var(--s2)', area: true, fmt: F.bps }], empty: 'Sin datos de tráfico' });
    }
  });

  /* ---------- Servicios / procesos ---------- */
  NOC.widgets.register({
    type: 'services', title: 'Servicios del sistema', icon: 'layers', target: 'required', accepts: function (t) { return W.withAgent(t); },
    desc: 'Indicador Encendido / Apagado de servicios críticos: Apache, Nginx, Docker, MySQL, spooler de impresión…',
    w: 6, h: 8, minW: 3, minH: 4,
    render: function (ctx) {
      var t = ctx.target, a = agentOf(t);
      if (!a) { ctx.body.innerHTML = W.waiting(); return; }
      if (a.error) { ctx.body.innerHTML = agentError(a); return; }
      var svcs = a.services || [];
      ctx.body.innerHTML = '<div class="pp-head" style="margin-bottom:8px">' + W.head(t) + '</div>' + (svcs.length ?
        '<div class="svc-grid">' + svcs.map(function (s) {
          return '<div class="port ' + (s.active ? 'open' : 'closed') + '"><span class="' + (s.active ? 'c-up' : 'c-down') + '">' + ui.icon(s.active ? 'check-circle' : 'x-circle') + '</span><div><div class="pn" style="font-size:13px">' + U.esc(s.name) + '</div><div class="pd">' + (s.active ? 'ENCENDIDO' : 'APAGADO') + '</div></div></div>';
        }).join('') + '</div>' : W.note('layers', 'No hay servicios configurados', 'Edita el objetivo y escribe los servicios a vigilar (nginx, docker, mysql…).'));
    }
  });
})(window.NOC = window.NOC || {});
