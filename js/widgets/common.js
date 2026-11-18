/* Helpers compartidos por los widgets. */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui, store = NOC.store;

  var PORT_NAMES = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 143: 'IMAP', 389: 'LDAP', 443: 'HTTPS',
    445: 'SMB', 587: 'SMTP', 993: 'IMAPS', 1433: 'SQL Server', 1521: 'Oracle', 3306: 'MySQL', 3389: 'RDP', 5060: 'SIP', 5432: 'PostgreSQL',
    5672: 'RabbitMQ', 6379: 'Redis', 8080: 'HTTP alterno', 8443: 'HTTPS alterno', 9100: 'Agente', 9200: 'Elasticsearch', 27017: 'MongoDB' };

  NOC.W = {
    th: function () { return store.state.settings.thresholds; },
    portName: function (p) { return PORT_NAMES[p] || ''; },
    // '' | 'warn' | 'crit' según umbrales (mayor es peor)
    level: function (v, warn, crit) { return !U.isNum(v) ? '' : v >= crit ? 'crit' : v >= warn ? 'warn' : ''; },
    levelColor: function (lv) { return lv === 'crit' ? 'c-down' : lv === 'warn' ? 'c-degraded' : ''; },
    waiting: function () { return '<div class="empty"><span class="spin"></span><span>Esperando la primera medición…</span></div>'; },
    note: function (icon, title, text) { return '<div class="empty">' + ui.icon(icon, 'ico--lg') + '<b>' + U.esc(title) + '</b>' + (text ? '<span>' + U.esc(text) + '</span>' : '') + '</div>'; },
    badge: function (kind, text, icon) {
      return '<span class="status status--' + kind + '">' + ui.icon(icon || 'check-circle') + U.esc(text) + '</span>';
    },
    stat: function (label, value, unit, lv) {
      return '<div class="stat ' + (lv || '') + '"><div class="s-l">' + U.esc(label) + '</div><div class="s-v">' + value + (unit ? ' <small>' + unit + '</small>' : '') + '</div></div>';
    },
    // Rango de puntos de historial según el selector de la ventana.
    range: function (state) { return state.range || 120; },
    rangeButtons: function (state) {
      return [[30, '30'], [120, '120'], [360, 'Todo']].map(function (r) {
        return '<button type="button" class="pill-btn" data-range="' + r[0] + '" aria-pressed="' + (W().range(state) === r[0]) + '">' + r[1] + '</button>';
      }).join('');
    },
    bindRange: function (ctx) {
      ctx.body.addEventListener('click', function (e) {
        var b = e.target.closest('[data-range]'); if (!b) return;
        ctx.state.range = +b.getAttribute('data-range'); ctx.grid.queueRender(ctx.id);
      });
    },
    // Clic en una fila/tarjeta con data-id → enfoca ese objetivo.
    bindFocus: function (ctx) {
      ctx.body.addEventListener('click', function (e) {
        if (e.target.closest('button, a, input, select')) return;
        var r = e.target.closest('[data-id]'); if (r) store.setFocus(r.getAttribute('data-id'));
      });
    },
    head: function (t) {
      var st = store.statusOf(t);
      return '<span class="tn">' + U.esc(t.name) + '</span>' + ui.status(st) + '<span class="taddr">' + U.esc(t.address) + '</span>';
    },
    withAgent: function (t) { return !!(t.checks && t.checks.agent && t.checks.agent.enabled); }
  };
  function W() { return NOC.W; }
})(window.NOC = window.NOC || {});
