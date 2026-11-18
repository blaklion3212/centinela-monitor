/* Widgets de red: ping estilo PingPlotter, tabla de red, jitter y traceroute. */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui, store = NOC.store, W = NOC.W;
  function hasPing(t) { return !!(t.checks && t.checks.ping); }

  /* Línea "resolución de nombres": para URLs qué IP resuelve; para IPs el nombre inverso (PTR). */
  function dnsLine(t, r) {
    var d = r && r.dns; if (!d) return '';
    var parts = [];
    if (d.error) return '<div class="dns-box"><span class="c-down">' + ui.icon('x-circle') + ' No se resuelve: <b>' + U.esc(d.input) + '</b> (' + U.esc(d.error) + ')</span></div>';
    if (d.literal) {
      parts.push('<span>IP: <b class="mono">' + U.esc(d.resolved) + '</b></span>');
      parts.push('<span>Nombre inverso (PTR): <b>' + (d.ptr ? U.esc(d.ptr) : 'sin registro') + '</b></span>');
    } else {
      parts.push('<span>Nombre: <b class="mono">' + U.esc(d.input) + '</b></span>');
      parts.push('<span>Resuelve a: <b class="mono">' + U.esc(d.resolved || '—') + '</b>' + (d.ips && d.ips.length > 1 ? ' <span class="muted">(+' + (d.ips.length - 1) + ' más: ' + U.esc(d.ips.slice(1, 4).join(', ')) + ')</span>' : '') + '</span>');
      if (U.isNum(d.ms)) parts.push('<span>Consulta DNS: <b>' + F.ms(d.ms) + '</b></span>');
    }
    return '<div class="dns-box">' + parts.join('') + '</div>';
  }
  NOC.dnsLine = dnsLine;

  /* ---------- Ping estilo PingPlotter ---------- */
  NOC.widgets.register({
    type: 'ping-plotter', title: 'Ping (PingPlotter)', icon: 'activity', target: 'required', accepts: hasPing,
    desc: 'Latencia en el tiempo con banda mín–máx, pérdida de paquetes, TTL, jitter y resolución de nombres.',
    w: 8, h: 11, minW: 4, minH: 7,
    init: function (ctx) { W.bindRange(ctx); },
    render: function (ctx) {
      var t = ctx.target, r = store.result(t.id), th = W.th();
      if (!r) { ctx.body.innerHTML = W.waiting(); return; }
      var p = r.ping || {};
      var pts = store.series(t.id, W.range(ctx.state));
      var head = '<div class="pp-head">' + W.head(t) + '<span class="win__sp"></span><span class="muted">Últimos puntos:</span>' + W.rangeButtons(ctx.state) + '</div>';
      var mid;
      if (p.unavailable) {
        mid = '<div class="chart">' + W.note('alert', 'Ping no disponible', p.error || 'El servidor no puede enviar ICMP.') + '</div>';
      } else {
        mid = '<div class="chart" data-chart></div>';
      }
      var strip = p.unavailable ? '' : '<div class="stat-strip">' +
        W.stat('Latencia', U.isNum(p.avg) ? F.ms(p.avg) : '—', '', W.level(p.avg, th.latencyWarnMs, th.latencyCritMs)) +
        W.stat('Mín / Máx', (U.isNum(p.min) ? F.ms(p.min) : '—') + ' / ' + (U.isNum(p.max) ? F.ms(p.max) : '—')) +
        W.stat('Pérdida', U.isNum(p.lossPct) ? F.pct(p.lossPct, p.lossPct % 1 ? 1 : 0) : '—', p.sent ? '(' + (p.sent - p.received) + '/' + p.sent + ')' : '', W.level(p.lossPct, th.lossWarnPct, th.lossCritPct)) +
        W.stat('Jitter', U.isNum(p.jitter) ? F.ms(p.jitter) : '—', '', W.level(p.jitter, th.jitterWarnMs, th.jitterCritMs)) +
        W.stat('TTL', U.isNum(p.ttl) ? p.ttl : '—', '', '') +
        W.stat('Actualizado', F.clock(r.ts), '', '') + '</div>';
      var reasons = r.reasons.filter(function (x) { return x.level !== 'info' || x.code === 'icmp'; });
      var rs = reasons.length ? '<ul class="reasons">' + reasons.slice(0, 3).map(function (x) {
        return '<li class="' + (x.level === 'crit' ? 'c-down' : x.level === 'warn' ? 'c-degraded' : 'muted') + '">' + ui.icon(x.level === 'info' ? 'help' : 'alert') + '<span style="color:var(--text-2)">' + U.esc(x.text) + '</span></li>';
      }).join('') + '</ul>' : '';
      ctx.body.innerHTML = '<div class="pp">' + head + dnsLine(t, r) + mid + strip + rs + '</div>';
      var ch = ctx.body.querySelector('[data-chart]');
      if (ch) {
        NOC.charts.line(ch, { points: pts, label: 'Latencia de ' + t.name,
          series: [{ key: 'lat', name: 'Latencia prom.', color: 'var(--s1)' }], band: { lo: 'min', hi: 'max' }, loss: true, downBg: true,
          lines: [{ v: th.latencyWarnMs, color: 'var(--degraded)', label: 'aviso ' + th.latencyWarnMs + ' ms' }],
          extra: function (p2) { return '<div class="t-row"><span>estado</span><span>' + U.esc(ui.statusText(p2.s)) + '</span></div>' + (U.isNum(p2.jit) ? '<div class="t-row"><span>jitter</span><span class="num">' + F.ms(p2.jit) + '</span></div>' : '') + (U.isNum(p2.ttl) ? '<div class="t-row"><span>TTL</span><span class="num">' + p2.ttl + '</span></div>' : ''); },
          empty: 'Sin respuestas de ping todavía' });
      }
    }
  });

  /* ---------- Tabla de red (todos los objetivos) ---------- */
  NOC.widgets.register({
    type: 'net-table', title: 'Latencia, pérdida, TTL y DNS', icon: 'network',
    desc: 'Una fila por objetivo: IP resuelta, nombre inverso, tiempo de DNS, latencia mín/prom/máx, jitter, pérdida y TTL.',
    w: 12, h: 8, minW: 5, minH: 4, flush: true,
    init: function (ctx) { W.bindFocus(ctx); },
    render: function (ctx) {
      var th = W.th(), list = store.targets(function (t) { return t.enabled; });
      if (!list.length) { ctx.body.innerHTML = W.note('server', 'Sin objetivos', 'Agrega IPs o URLs en la vista Objetivos.'); return; }
      ctx.body.innerHTML = '<table class="tbl"><thead><tr><th>Estado</th><th>Servicio</th><th>IP resuelta</th><th>Nombre (DNS / PTR)</th><th class="r">DNS</th><th class="r">Mín</th><th class="r">Prom.</th><th class="r">Máx</th><th class="r">Jitter</th><th class="r">Pérdida</th><th class="r">TTL</th></tr></thead><tbody>' +
        list.map(function (t) {
          var r = store.result(t.id), p = r && r.ping, d = r && r.dns, s = store.statusOf(t);
          var name = !d ? '' : d.literal ? (d.ptr || '—') : d.input;
          function c(v, w, cr) { return W.levelColor(W.level(v, w, cr)); }
          return '<tr data-id="' + U.esc(t.id) + '" class="' + (store.state.focusId === t.id ? 'sel' : '') + '"><td>' + ui.status(s) + '</td><td class="tname">' + U.esc(t.name) + '</td>' +
            '<td class="mono">' + (d && d.resolved ? U.esc(d.resolved) : (d && d.error ? '<span class="c-down">' + U.esc(d.error) + '</span>' : '—')) + '</td>' +
            '<td>' + U.esc(name) + '</td><td class="r num">' + (d && U.isNum(d.ms) ? F.ms(d.ms) : '—') + '</td>' +
            (p && !p.unavailable ? '<td class="r num">' + F.ms(p.min) + '</td><td class="r num ' + c(p.avg, th.latencyWarnMs, th.latencyCritMs) + '">' + F.ms(p.avg) + '</td><td class="r num">' + F.ms(p.max) + '</td>' +
              '<td class="r num ' + c(p.jitter, th.jitterWarnMs, th.jitterCritMs) + '">' + F.ms(p.jitter) + '</td><td class="r num ' + c(p.lossPct, th.lossWarnPct, th.lossCritPct) + '">' + F.pct(p.lossPct, p.lossPct % 1 ? 1 : 0) + '</td><td class="r num">' + (U.isNum(p.ttl) ? p.ttl : '—') + '</td>'
              : '<td class="r muted" colspan="6">' + (p && p.unavailable ? 'ping no disponible' : (t.checks.ping ? 'esperando…' : 'ping desactivado')) + '</td>') + '</tr>';
        }).join('') + '</tbody></table>';
    }
  });

  /* ---------- Jitter ---------- */
  NOC.widgets.register({
    type: 'jitter', title: 'Jitter (variación de latencia)', icon: 'zap', target: 'required', accepts: hasPing,
    desc: 'Variación de la latencia: crítico para VoIP, streaming y videollamadas.',
    w: 6, h: 8, minW: 3, minH: 5,
    init: function (ctx) { W.bindRange(ctx); },
    render: function (ctx) {
      var t = ctx.target, r = store.result(t.id), th = W.th();
      if (!r) { ctx.body.innerHTML = W.waiting(); return; }
      var j = r.ping && r.ping.jitter, lv = W.level(j, th.jitterWarnMs, th.jitterCritMs);
      var verdict = !U.isNum(j) ? 'Sin dato' : lv === 'crit' ? 'Malo para voz y video' : lv === 'warn' ? 'Marginal para voz y video' : 'Bueno para voz y video';
      var pts = store.series(t.id, W.range(ctx.state));
      ctx.body.innerHTML = '<div class="pp"><div class="pp-head">' + W.head(t) + '<span class="win__sp"></span>' + W.rangeButtons(ctx.state) + '</div>' +
        '<div class="stat-strip">' + W.stat('Jitter actual', U.isNum(j) ? F.ms(j) : '—', '', lv) + W.stat('Evaluación', U.esc(verdict), '', lv) + W.stat('Umbral aviso', th.jitterWarnMs, 'ms') + '</div>' +
        '<div class="chart" data-chart></div></div>';
      NOC.charts.line(ctx.body.querySelector('[data-chart]'), { points: pts, label: 'Jitter de ' + t.name,
        series: [{ key: 'jit', name: 'Jitter', color: 'var(--s3)', area: true }], downBg: true,
        lines: [{ v: th.jitterWarnMs, color: 'var(--degraded)', label: 'aviso' }], empty: 'Sin datos de jitter' });
    }
  });

  /* ---------- Traceroute por saltos ---------- */
  NOC.widgets.register({
    type: 'traceroute', title: 'Análisis de ruta (traceroute)', icon: 'route', target: 'required',
    desc: 'Salto por salto: latencia y pérdida de cada hop para ubicar dónde se degrada la ruta. Acumula varias corridas.',
    w: 4, h: 11, minW: 4, minH: 6, flush: true,
    init: function (ctx) {
      var st = ctx.state; st.acc = {}; st.runs = 0; st.busy = false; st.err = null; st.repeat = false; st.key = null;
      ctx.body.style.cssText = 'display:flex;flex-direction:column;overflow:hidden';
      ctx.body.addEventListener('click', function (e) {
        if (e.target.closest('[data-run]')) run(ctx);
        if (e.target.closest('[data-clear]')) { reset(st); ctx.grid.queueRender(ctx.id); }
      });
      ctx.body.addEventListener('change', function (e) {
        if (!e.target.matches('[data-repeat]')) return;
        st.repeat = e.target.checked;
        clearInterval(st.timer);
        if (st.repeat) st.timer = setInterval(function () { if (!st.busy && document.body.contains(ctx.body)) run(ctx); }, 15000);
      });
    },
    destroy: function (ctx) { clearInterval(ctx.state.timer); },
    render: function (ctx) {
      var st = ctx.state, t = ctx.target;
      if (st.key !== t.id) { reset(st); st.key = t.id; }
      var hops = Object.keys(st.acc).map(Number).sort(function (a, b) { return a - b; }).map(function (k) {
        var h = st.acc[k], s = U.stats(h.samples); return { hop: k, ip: h.ip, name: h.name, st: s };
      });
      var maxAvg = 1; hops.forEach(function (h) { if (U.isNum(h.st.max) && h.st.max > maxAvg) maxAvg = h.st.max; });
      // Primer salto "sospechoso": pérdida sostenida hasta el final, o salto brusco de latencia.
      var bad = -1;
      hops.forEach(function (h, i) {
        if (bad >= 0) return;
        var prev = hops[i - 1], jump = prev && U.isNum(prev.st.avg) && U.isNum(h.st.avg) && h.st.avg - prev.st.avg >= 80;
        var lossToEnd = h.st.lossPct >= 30 && hops.slice(i).every(function (x) { return x.st.lossPct >= 30; });
        if (jump || lossToEnd) bad = i;
      });
      var head = '<div class="tr-head"><button type="button" class="btn btn--primary btn--sm" data-run' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? '<span class="spin"></span> Rastreando…' : ui.icon('route') + ' Ejecutar') + '</button>' +
        '<label class="check"><input type="checkbox" data-repeat' + (st.repeat ? ' checked' : '') + '> Repetir cada 15 s</label>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-clear>Limpiar</button><span class="win__sp"></span>' +
        '<span class="muted">' + U.esc(t.name) + (st.runs ? ' · ' + F.plural(st.runs, 'corrida', 'corridas') : '') + '</span></div>';
      var body;
      if (st.err) body = W.note('alert', 'No se pudo trazar la ruta', st.err);
      else if (!hops.length) body = W.note('route', st.busy ? 'Trazando la ruta…' : 'Sin datos de ruta', st.busy ? 'Puede tardar hasta un minuto.' : 'Pulsa “Ejecutar” para ver cada salto hasta el destino.');
      else body = '<table class="tbl"><thead><tr><th>#</th><th>Salto</th><th class="r">Pérd.</th><th class="r">Prom.</th><th class="r">Máx</th><th>Latencia</th></tr></thead><tbody>' +
        hops.map(function (h, i) {
          var lv = W.level(h.st.avg, 100, 250), cls = h.st.lossPct >= 30 ? 'crit' : lv;
          return '<tr class="' + (i === bad ? 'hop-bad' : '') + '"><td class="num">' + h.hop + '</td><td>' + (h.ip ? '<span class="mono">' + U.esc(h.ip) + '</span>' + (h.name ? '<div class="muted" style="font-size:11px">' + U.esc(h.name) + '</div>' : '') : '<span class="muted">sin respuesta</span>') +
            (i === bad ? '<div class="c-down" style="font-size:11px;font-weight:650">' + ui.icon('alert') + ' posible origen del problema</div>' : '') + '</td>' +
            '<td class="r num ' + (h.st.lossPct >= 30 ? 'c-down' : h.st.lossPct > 0 ? 'c-degraded' : '') + '">' + F.pct(h.st.lossPct, 0) + '</td><td class="r num">' + (U.isNum(h.st.avg) ? F.ms(h.st.avg) : '—') + '</td><td class="r num">' + (U.isNum(h.st.max) ? F.ms(h.st.max) : '—') + '</td>' +
            '<td><div class="hop-bar ' + cls + '"><i style="width:' + (U.isNum(h.st.avg) ? Math.max(3, h.st.avg / maxAvg * 100) : 0) + '%"></i></div></td></tr>';
        }).join('') + '</tbody></table>';
      ctx.body.innerHTML = head + '<div style="flex:1;min-height:0;overflow:auto" data-keep-scroll>' + body + '</div>';
    }
  });

  function reset(st) { st.acc = {}; st.runs = 0; st.err = null; }

  function run(ctx) {
    var st = ctx.state, t = ctx.target;
    if (!t || st.busy) return;
    st.busy = true; st.err = null; ctx.grid.queueRender(ctx.id);
    NOC.data.traceroute({ targetId: t.id }).then(function (res) {
      if (st.key !== t.id) return;
      if (res.error && !(res.hops && res.hops.length)) { st.err = res.error; return; }
      st.runs++;
      res.hops.forEach(function (h) {
        var cur = st.acc[h.hop] || { samples: [], ip: null, name: null };
        cur.samples = cur.samples.concat(h.samples || []).slice(-90);
        if (h.ip) { cur.ip = h.ip; cur.name = h.name || cur.name; }
        st.acc[h.hop] = cur;
      });
    }).catch(function (e) { st.err = e.message; }).then(function () { st.busy = false; ctx.grid.queueRender(ctx.id); });
  }
})(window.NOC = window.NOC || {});
