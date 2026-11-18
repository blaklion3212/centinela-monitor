/* Widgets de estado general: resumen, tablero de servicios y eventos. */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui, store = NOC.store, W = NOC.W;

  /* ---------- Resumen ---------- */
  NOC.widgets.register({
    type: 'overview', title: 'Resumen general', icon: 'gauge', desc: 'Estado global, conteo UP / DEGRADADO / DOWN, latencia promedio y disponibilidad.',
    w: 12, h: 5, minW: 4, minH: 3,
    render: function (ctx) {
      var s = store.summary();
      var worst = s.down ? 'down' : s.degraded ? 'degraded' : s.total ? 'up' : 'unknown';
      var title = !s.total ? 'Sin objetivos activos' : s.down ? F.plural(s.down, 'servicio caído', 'servicios caídos') :
        s.degraded ? F.plural(s.degraded, 'servicio con degradación', 'servicios con degradación') : 'Todos los servicios operan con normalidad';
      var sub = s.total ? s.up + ' de ' + s.total + ' arriba' + (s.paused ? ' · ' + s.paused + ' en pausa' : '') : 'Agrega IPs o URLs en la vista Objetivos';
      function k(cls, label, val, sub2, icon) {
        return '<div class="kpi ' + cls + '"><div class="k-label">' + (icon ? ui.icon(icon) : '') + label + '</div><div class="k-val">' + val + '</div><div class="k-sub">' + sub2 + '</div></div>';
      }
      var lat = s.avgLatency;
      ctx.body.innerHTML = '<div class="kpis">' +
        '<div class="kpi kpi--hero is-' + worst + '"><span class="c-' + worst + '">' + ui.statusIcon(worst, 'big-ico') + '</span><div><div class="k-label">Estado global</div><div class="k-val c-' + worst + '">' + U.esc(title) + '</div><div class="k-sub">' + U.esc(sub) + '</div></div></div>' +
        k('kpi--up', 'UP', s.up, 'Arriba', 'check-circle') +
        k('kpi--degraded', 'Degradado', s.degraded, 'Con alertas', 'alert') +
        k('kpi--down', 'DOWN', s.down, 'Abajo', 'x-circle') +
        k('', 'Latencia prom.', U.isNum(lat) ? Math.round(lat) + '<small class="muted"> ms</small>' : '—', 'Ping, todos los objetivos', 'activity') +
        k('', 'Disponibilidad', s.availability == null ? '—' : s.availability.toFixed(s.availability >= 99.95 ? 0 : 1) + '<small class="muted"> %</small>', 'Según historial en pantalla', 'shield') +
        '</div>';
    }
  });

  /* ---------- Tablero de servicios ---------- */
  var STATUS_ORDER = { down: 0, degraded: 1, unknown: 2, up: 3, paused: 4 };
  NOC.widgets.register({
    type: 'status-board', title: 'Estado de servicios', icon: 'list', desc: 'Todos los servicios con su estado, latencia, pérdida, código HTTP, historial y motivo.',
    w: 8, h: 10, minW: 4, minH: 4, flush: true,
    init: function (ctx) {
      var st = ctx.state; st.filter = 'all'; st.q = '';
      ctx.body.style.cssText = 'display:flex;flex-direction:column;overflow:hidden';
      ctx.body.innerHTML = '<div class="board-filters"></div><div class="table-scroll" data-keep-scroll style="flex:1;min-height:0"></div>';
      var bar = ctx.body.firstChild, list = ctx.body.lastChild;
      st.bar = bar; st.list = list;
      bar.addEventListener('click', function (e) {
        var b = e.target.closest('[data-f]'); if (!b) return;
        st.filter = b.getAttribute('data-f'); ctx.grid.queueRender(ctx.id);
      });
      bar.addEventListener('input', function (e) { if (e.target.matches('input')) { st.q = e.target.value.toLowerCase(); ctx.grid.queueRender(ctx.id); } });
      list.addEventListener('click', function (e) {
        var chk = e.target.closest('[data-check]');
        if (chk) { NOC.data.checkNow(chk.getAttribute('data-check')).catch(function (er) { ui.toast(er.message, 'err'); }); return; }
        var r = e.target.closest('[data-id]'); if (r) store.setFocus(r.getAttribute('data-id'));
      });
    },
    render: function (ctx) {
      var st = ctx.state, all = store.targets();
      var counts = { all: all.length, down: 0, degraded: 0, up: 0, unknown: 0, paused: 0 };
      all.forEach(function (t) { counts[store.statusOf(t)]++; });
      if (!st.bar.querySelector('input')) {
        st.bar.innerHTML = '<span class="filters"></span><input type="search" placeholder="Buscar nombre, IP, etiqueta…" aria-label="Buscar servicio">';
      }
      st.bar.firstChild.innerHTML = [['all', 'Todos'], ['down', 'DOWN'], ['degraded', 'Degradado'], ['up', 'UP']].map(function (f) {
        return '<button type="button" class="pill-btn" data-f="' + f[0] + '" aria-pressed="' + (st.filter === f[0]) + '">' + f[1] + ' ' + counts[f[0]] + '</button>';
      }).join(' ');
      var rows = all.filter(function (t) {
        var s = store.statusOf(t);
        if (st.filter !== 'all' && s !== st.filter) return false;
        var hay = (t.name + ' ' + t.address + ' ' + (t.group || '') + ' ' + (t.tags || []).join(' ')).toLowerCase();
        return !st.q || hay.indexOf(st.q) >= 0;
      }).sort(function (a, b) {
        return (STATUS_ORDER[store.statusOf(a)] - STATUS_ORDER[store.statusOf(b)]) || a.name.localeCompare(b.name);
      });
      if (!all.length) { st.list.innerHTML = W.note('server', 'Aún no monitoreas nada', 'Ve a “Objetivos” y agrega una IP o URL.'); return; }
      if (!rows.length) { st.list.innerHTML = W.note('search', 'Sin resultados', 'Cambia el filtro o la búsqueda.'); return; }
      var th = W.th();
      st.list.innerHTML = '<table class="tbl"><thead><tr><th>Estado</th><th>Servicio</th><th class="r">Latencia</th><th class="r">Pérdida</th><th>HTTP</th><th>Historial</th><th class="r">Disp.</th><th>Motivo</th><th></th></tr></thead><tbody>' +
        rows.map(function (t) {
          var s = store.statusOf(t), r = store.result(t.id), p = r && r.ping, h = r && r.http;
          var series = store.series(t.id, 60), av = store.availability(t.id);
          var reasons = r && r.status !== 'up' ? r.reasons.filter(function (x) { return x.level !== 'info'; }).map(function (x) { return x.text; }) : [];
          var lv = p && W.level(p.avg, th.latencyWarnMs, th.latencyCritMs), ll = p && W.level(p.lossPct, th.lossWarnPct, th.lossCritPct);
          return '<tr data-id="' + U.esc(t.id) + '" class="' + (store.state.focusId === t.id ? 'sel' : '') + '">' +
            '<td>' + ui.status(s) + '<div class="muted" style="font-size:11px;margin-top:2px">' + (store.state.since[t.id] && s !== 'paused' ? F.ago(store.state.since[t.id]) : '') + '</div></td>' +
            '<td><div class="tname">' + U.esc(t.name) + '</div><div class="taddr">' + U.esc(t.address) + '</div>' +
              '<div class="tags-line" style="margin-top:3px">' + (t.group ? '<span class="chip chip--kind">' + U.esc(t.group) + '</span>' : '') + (t.tags || []).map(function (g) { return '<span class="chip">' + U.esc(g) + '</span>'; }).join('') + '</div></td>' +
            '<td class="r num ' + W.levelColor(lv) + '">' + (p && U.isNum(p.avg) ? F.ms(p.avg) : '—') + '<div>' + NOC.charts.spark(series, 'lat', 70, 18) + '</div></td>' +
            '<td class="r num ' + W.levelColor(ll) + '">' + (p && U.isNum(p.lossPct) ? F.pct(p.lossPct, p.lossPct % 1 ? 1 : 0) : '—') + '</td>' +
            '<td class="num">' + (h ? (U.isNum(h.status) ? '<span class="' + (NOC.Evaluate.statusMatches(h.status, (t.checks.http && t.checks.http.expectedStatus) || '200-399') ? 'c-up' : 'c-down') + '">' + h.status + '</span>' : '<span class="c-down">error</span>') + '<div class="muted" style="font-size:11px">' + (U.isNum(h.ttfbMs) ? F.ms(h.ttfbMs) : '') + '</div>' : '<span class="muted">—</span>') + '</td>' +
            '<td>' + NOC.charts.strip(store.series(t.id, 40), 120, 16, 40) + '</td>' +
            '<td class="r num avail">' + (av == null ? '—' : av.toFixed(av >= 99.95 ? 0 : 1) + ' %') + '</td>' +
            '<td class="reason">' + U.esc(reasons.slice(0, 2).join(' · ')) + '</td>' +
            '<td><button type="button" class="icon-btn" data-check="' + U.esc(t.id) + '" title="Verificar ahora" aria-label="Verificar ahora">' + ui.icon('refresh') + '</button></td></tr>';
        }).join('') + '</tbody></table>';
    }
  });

  /* ---------- Eventos ---------- */
  NOC.widgets.register({
    type: 'events', title: 'Eventos y alertas', icon: 'bell', desc: 'Bitácora de cambios de estado: cuándo cayó, se degradó o se recuperó cada servicio.',
    w: 4, h: 10, minW: 3, minH: 4, flush: true,
    init: function (ctx) {
      // Las alertas son de todas las organizaciones: al pulsar una de otra organización se cambia a ella y se enfoca el servicio.
      ctx.body.addEventListener('click', function (e) {
        if (e.target.closest('button, a, input, select')) return;
        var r = e.target.closest('[data-id]'); if (!r) return;
        var id = r.getAttribute('data-id'), org = r.getAttribute('data-org');
        if (org && org !== store.state.orgId) NOC.data.switchOrg(org).then(function () { store.setFocus(id); });
        else store.setFocus(id);
      });
    },
    render: function (ctx) {
      var ev = store.state.events.slice(0, 80), multi = store.state.orgs.length > 1;
      if (!ev.length) { ctx.body.innerHTML = W.note('check-circle', 'Sin eventos', 'Aquí verás las caídas y recuperaciones.'); return; }
      ctx.body.innerHTML = '<ul class="ev-list" data-keep-scroll>' + ev.map(function (e) {
        var txt = e.to === 'up' ? (e.from ? 'Se recuperó (antes ' + ui.statusText(e.from) + ')' : 'Servicio recuperado') : e.text;
        var tag = multi && e.orgName ? '<span class="org-chip" style="--oc:' + U.esc(e.orgColor || '#4f8cff') + '" title="Organización"><i></i>' + U.esc(e.orgName) + '</span> ' : '';
        return '<li data-id="' + U.esc(e.targetId) + '" data-org="' + U.esc(e.org || '') + '"><span>' + ui.status(e.to) + '</span><span class="ev-time">' + F.dateTime(e.ts) + '</span>' +
          '<span class="ev-name" style="grid-column:1/3">' + tag + U.esc(e.name) + '</span><span class="ev-text">' + U.esc(txt) + '</span></li>';
      }).join('') + '</ul>';
    }
  });
})(window.NOC = window.NOC || {});
