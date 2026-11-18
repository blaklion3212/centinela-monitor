/* Capa 7: HTTP/HTTPS (código y TTFB), caducidad SSL/TLS y puertos TCP. */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui, store = NOC.store, W = NOC.W;
  function isUrl(t) { return t.kind === 'url' && t.checks && t.checks.http; }

  var HTTP_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
    403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Error', 502: 'Bad Gateway', 503: 'Unavailable', 504: 'Gateway Timeout' };

  /* ---------- HTTP / HTTPS ---------- */
  NOC.widgets.register({
    type: 'http-monitor', title: 'HTTP/HTTPS: código y TTFB', icon: 'globe', target: 'optional', accepts: isUrl,
    desc: 'Código de estado (200, 404, 500…), tiempo hasta el primer byte (TTFB), tiempo total e IP resuelta de cada URL.',
    w: 7, h: 8, minW: 4, minH: 5,
    init: function (ctx) { W.bindFocus(ctx); W.bindRange(ctx); },
    render: function (ctx) {
      var th = W.th(), list = store.targets(function (t) { return t.enabled && isUrl(t); }), t = ctx.target;
      if (!list.length) { ctx.body.innerHTML = W.note('globe', 'No hay URLs monitoreadas', 'Agrega una URL (https://…) en la vista Objetivos.'); return; }
      var rows = list.map(function (u) {
        var r = store.result(u.id), h = r && r.http, d = r && r.dns, exp = (u.checks.http && u.checks.http.expectedStatus) || '200-399';
        var ok = h && U.isNum(h.status) && NOC.Evaluate.statusMatches(h.status, exp);
        var lv = h && W.level(h.ttfbMs, th.ttfbWarnMs, th.ttfbCritMs);
        return '<tr data-id="' + U.esc(u.id) + '" class="' + (t && t.id === u.id ? 'sel' : '') + '"><td>' + ui.status(store.statusOf(u)) + '</td><td><div class="tname">' + U.esc(u.name) + '</div><div class="taddr">' + U.esc(u.address) + '</div></td>' +
          '<td class="num">' + (!h ? '<span class="muted">…</span>' : h.error ? '<span class="c-down">' + ui.icon('x-circle') + ' ' + U.esc(h.error) + '</span>' :
            '<b class="' + (ok ? 'c-up' : 'c-down') + '">' + U.esc(h.status) + '</b> <span class="muted">' + U.esc(h.statusText || HTTP_TEXT[h.status] || '') + '</span>' + (h.redirects ? ' <span class="chip" title="' + U.esc((h.chain || []).map(function (c) { return c.status + ' ' + c.url; }).join('\n') || h.finalUrl || '') + '">' + U.esc(h.redirects) + ' redir.</span>' : '') + (h.keywordFound === false ? ' <span class="chip c-down">sin texto esperado</span>' : '')) + '</td>' +
          '<td class="r num ' + W.levelColor(lv) + '">' + (h && U.isNum(h.ttfbMs) ? F.ms(h.ttfbMs) : '—') + '</td><td class="r num">' + (h && U.isNum(h.totalMs) ? F.ms(h.totalMs) : '—') + '</td>' +
          '<td class="r num">' + (h && U.isNum(h.bytes) ? F.bytes(h.bytes) : '—') + '</td><td class="mono">' + (d && d.resolved ? U.esc(d.resolved) : '—') + '</td></tr>';
      }).join('');
      ctx.body.innerHTML = '<div style="display:flex;flex-direction:column;height:100%;gap:8px"><div style="flex:1 1 55%;min-height:70px;overflow:auto;margin:-10px -12px 0" data-keep-scroll>' +
        '<table class="tbl"><thead><tr><th>Estado</th><th>URL</th><th>Respuesta HTTP</th><th class="r">TTFB</th><th class="r">Total</th><th class="r">Tamaño</th><th>IP resuelta</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (t ? '<div class="pp-head"><span class="tn">TTFB · ' + U.esc(t.name) + '</span><span class="win__sp"></span>' + W.rangeButtons(ctx.state) + '</div><div class="chart" data-chart style="flex:1 1 40%;min-height:70px;height:auto"></div>' : '') + '</div>';
      var ch = ctx.body.querySelector('[data-chart]');
      if (ch) NOC.charts.line(ch, { points: store.series(t.id, W.range(ctx.state)), label: 'TTFB de ' + t.name, downBg: true,
        series: [{ key: 'ttfb', name: 'TTFB', color: 'var(--s2)', area: true }], lines: [{ v: th.ttfbWarnMs, color: 'var(--degraded)', label: 'aviso' }],
        extra: function (p) { return U.isNum(p.http) ? '<div class="t-row"><span>HTTP</span><span class="num">' + p.http + '</span></div>' : ''; }, empty: 'Sin datos HTTP' });
    }
  });

  /* ---------- Caducidad SSL ---------- */
  NOC.widgets.register({
    type: 'ssl-expiry', title: 'Certificados SSL/TLS', icon: 'lock',
    desc: 'Días restantes de cada certificado de seguridad, con alerta visual antes de que venzan.',
    w: 5, h: 8, minW: 3, minH: 4, flush: true,
    init: function (ctx) { W.bindFocus(ctx); },
    render: function (ctx) {
      var th = W.th(), list = store.targets(function (t) { return t.enabled && t.checks.ssl; });
      if (!list.length) { ctx.body.innerHTML = W.note('lock', 'Sin certificados que vigilar', 'Activa “Certificado SSL” en una URL https.'); return; }
      var data = list.map(function (t) { var r = store.result(t.id); return { t: t, s: r && r.ssl }; })
        .sort(function (a, b) { return (a.s && U.isNum(a.s.daysLeft) ? a.s.daysLeft : 9999) - (b.s && U.isNum(b.s.daysLeft) ? b.s.daysLeft : 9999); });
      ctx.body.innerHTML = '<table class="tbl"><thead><tr><th>Servicio</th><th>Emisor</th><th>Vence</th><th class="r">Días</th><th>Alerta</th></tr></thead><tbody>' + data.map(function (x) {
        var s = x.s, t = x.t;
        if (!s) return '<tr data-id="' + U.esc(t.id) + '"><td class="tname">' + U.esc(t.name) + '</td><td colspan="4" class="muted">esperando…</td></tr>';
        if (s.error) return '<tr data-id="' + U.esc(t.id) + '"><td class="tname">' + U.esc(t.name) + '</td><td colspan="3" class="c-degraded">' + U.esc(s.error) + '</td><td>' + W.badge('degraded', 'SIN LECTURA', 'alert') + '</td></tr>';
        var d = s.daysLeft, kind = d < 0 ? 'down' : d <= th.sslCritDays ? 'down' : d <= th.sslWarnDays ? 'degraded' : 'up';
        var label = d < 0 ? 'VENCIDO' : d <= th.sslCritDays ? 'CRÍTICO' : d <= th.sslWarnDays ? 'POR VENCER' : 'VIGENTE';
        return '<tr data-id="' + U.esc(t.id) + '"><td><div class="tname">' + U.esc(t.name) + '</div><div class="taddr">' + U.esc(s.subject || '') + '</div></td><td>' + U.esc(s.issuer || '—') + '</td>' +
          '<td class="num">' + (s.validTo ? F.date(Date.parse(s.validTo)) : '—') + '</td><td class="r"><span class="ssl-days c-' + kind + '">' + U.esc(d) + '</span></td>' +
          '<td>' + W.badge(kind, label, kind === 'up' ? 'check-circle' : kind === 'down' ? 'x-circle' : 'alert') + (s.authorized === false ? '<div class="c-degraded" style="font-size:11px">no confiable</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
  });

  /* ---------- Puertos ---------- */
  NOC.widgets.register({
    type: 'ports', title: 'Puertos TCP', icon: 'network',
    desc: 'Valida que los puertos clave (80/443, 3306 MySQL, 5432 PostgreSQL…) estén abiertos y escuchando.',
    w: 6, h: 8, minW: 3, minH: 4,
    init: function (ctx) { W.bindFocus(ctx); },
    render: function (ctx) {
      var list = store.targets(function (t) { return t.enabled && t.checks.ports && t.checks.ports.length; });
      if (!list.length) { ctx.body.innerHTML = W.note('network', 'Sin puertos configurados', 'Agrega puertos (ej. 443, 3306) a un objetivo.'); return; }
      ctx.body.innerHTML = list.map(function (t) {
        var r = store.result(t.id), ports = (r && r.ports) || [];
        return '<div class="group-title" data-id="' + U.esc(t.id) + '">' + U.esc(t.name) + ' <span class="taddr">' + U.esc(t.address) + '</span></div><div class="port-grid" style="margin-bottom:10px">' +
          t.checks.ports.map(function (pn) {
            var p = ports.filter(function (x) { return x.port === pn; })[0];
            var cls = !p ? '' : p.open ? 'open' : 'closed';
            return '<div class="port ' + cls + '"><span class="' + (!p ? 'c-unknown' : p.open ? 'c-up' : 'c-down') + '">' + ui.icon(!p ? 'help' : p.open ? 'check-circle' : 'x-circle') + '</span><div><div><span class="pn">' + U.esc(pn) + '</span> <span class="muted">' + U.esc(W.portName(pn)) + '</span></div>' +
              '<div class="pd">' + (!p ? 'esperando…' : p.open ? 'ABIERTO · ' + F.ms(p.ms) : 'CERRADO · ' + U.esc(p.error || 'sin respuesta')) + '</div></div></div>';
          }).join('') + '</div>';
      }).join('');
    }
  });
})(window.NOC = window.NOC || {});
