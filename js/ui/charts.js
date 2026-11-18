/*
 * Gráficas de línea en SVG sin dependencias.
 * NOC.charts.line(contenedor, opciones) dibuja al tamaño actual del contenedor y activa
 * cruz + tooltip al pasar el ratón. Los huecos (null) cortan la línea; no se interpolan.
 */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui;

  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    var m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return m * p;
  }
  function esc(s) { return U.esc(s); }

  /*
   * o.points   : historial (cada punto con .t)
   * o.series   : [{ key, name, color, fmt, area }]
   * o.band     : { lo:'min', hi:'max' }  banda mín–máx (PingPlotter)
   * o.loss     : true -> marcas rojas donde hubo pérdida de paquetes (p.loss)
   * o.downBg   : true -> sombrea los puntos con estado down
   * o.yMax     : máximo fijo (p. ej. 100 para %), si no se calcula "bonito"
   * o.yFmt     : formato del eje y
   * o.lines    : [{ v, color, label }]  líneas de umbral
   * o.empty    : texto cuando no hay datos
   */
  function line(el, o) {
    var W = el.clientWidth, H = el.clientHeight;
    var pts = o.points || [];
    var has = pts.some(function (p) { return o.series.some(function (s) { return U.isNum(p[s.key]); }); });
    if (W < 40 || H < 40) { el.innerHTML = ''; return; }
    // Serie toda nula pero con caídas registradas: se dibuja el sombreado rojo en vez del aviso vacío.
    var onlyDown = !has && o.downBg && pts.some(function (p) { return p.s === 'down'; });
    if (!pts.length || (!has && !onlyDown)) {
      el.innerHTML = '<div class="empty"><span>' + esc(o.empty || 'Aún no hay mediciones') + '</span></div>';
      return;
    }
    var yFmt = o.yFmt || F.ms;
    var m = { l: 46, r: 8, t: 8, b: 20 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var max = 0;
    pts.forEach(function (p) {
      o.series.forEach(function (s) { if (U.isNum(p[s.key]) && p[s.key] > max) max = p[s.key]; });
      if (o.band && U.isNum(p[o.band.hi]) && p[o.band.hi] > max) max = p[o.band.hi];
    });
    (o.lines || []).forEach(function (l) { if (l.v > max && l.v < max * 3) max = l.v * 1.05; });
    var yMax = o.yMax || niceMax(max * 1.08);
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t, span = Math.max(1, t1 - t0);
    function X(t) { return m.l + (pts.length === 1 ? iw / 2 : (t - t0) / span * iw); }
    function Y(v) { return m.t + ih - Math.min(1, Math.max(0, v / yMax)) * ih; }

    var g = '';
    // rejilla y eje y
    for (var i = 0; i <= 4; i++) {
      var v = yMax * i / 4, y = Y(v);
      g += '<line class="gl" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y + '" y2="' + y + '"/>' +
           '<text class="ax" x="' + (m.l - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + esc(yFmt(v)) + '</text>';
    }
    // eje x
    var nx = Math.max(2, Math.min(6, Math.floor(iw / 90)));
    for (var j = 0; j <= nx; j++) {
      var tx = t0 + span * j / nx;
      g += '<text class="ax" x="' + X(tx) + '" y="' + (H - 5) + '" text-anchor="' + (j === 0 ? 'start' : j === nx ? 'end' : 'middle') + '">' + F.clock(tx) + '</text>';
    }
    // sombreado de caídas
    if (o.downBg) {
      var run = null;
      pts.forEach(function (p, k) {
        if (p.s === 'down') { if (run == null) run = k; }
        if ((p.s !== 'down' || k === pts.length - 1) && run != null) {
          var a = X(pts[run].t), b = X(pts[k].t);
          g += '<rect x="' + (a - 2) + '" y="' + m.t + '" width="' + Math.max(4, b - a + 4) + '" height="' + ih + '" style="fill:var(--down);opacity:.13"/>';
          run = null;
        }
      });
    }
    // umbrales
    (o.lines || []).forEach(function (l) {
      if (l.v > yMax) return;
      g += '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(l.v) + '" y2="' + Y(l.v) + '" style="stroke:' + l.color + ';stroke-width:1;stroke-dasharray:4 4;opacity:.7"/>' +
           '<text class="ax" x="' + (W - m.r - 3) + '" y="' + (Y(l.v) - 3) + '" text-anchor="end" style="fill:' + l.color + '">' + esc(l.label) + '</text>';
    });
    // banda mín–máx
    if (o.band) {
      var top = [], bot = [];
      pts.forEach(function (p) {
        if (U.isNum(p[o.band.lo]) && U.isNum(p[o.band.hi])) { top.push(X(p.t) + ',' + Y(p[o.band.hi])); bot.unshift(X(p.t) + ',' + Y(p[o.band.lo])); }
      });
      if (top.length > 1) g += '<polygon points="' + top.join(' ') + ' ' + bot.join(' ') + '" style="fill:var(--s1);opacity:.16"/>';
    }
    // series (cortadas en huecos)
    o.series.forEach(function (s) {
      var segs = [], cur = [];
      pts.forEach(function (p) {
        if (U.isNum(p[s.key])) cur.push([X(p.t), Y(p[s.key])]);
        else if (cur.length) { segs.push(cur); cur = []; }
      });
      if (cur.length) segs.push(cur);
      segs.forEach(function (sg) {
        var d = sg.map(function (q, k) { return (k ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('');
        if (s.area && sg.length > 1) g += '<path d="' + d + 'L' + sg[sg.length - 1][0].toFixed(1) + ' ' + Y(0) + 'L' + sg[0][0].toFixed(1) + ' ' + Y(0) + 'Z" style="fill:' + s.color + ';opacity:.12"/>';
        if (sg.length === 1) g += '<circle cx="' + sg[0][0] + '" cy="' + sg[0][1] + '" r="2.5" style="fill:' + s.color + '"/>';
        else g += '<path class="ln" d="' + d + '" style="stroke:' + s.color + '"/>';
      });
    });
    // pérdida de paquetes: marca roja al pie de cada muestra con pérdida
    if (o.loss) {
      pts.forEach(function (p) {
        if (U.isNum(p.loss) && p.loss > 0) {
          var h = Math.max(4, Math.min(ih * 0.35, ih * 0.35 * p.loss / 100 + 4));
          g += '<rect x="' + (X(p.t) - 1.5) + '" y="' + (m.t + ih - h) + '" width="3" height="' + h + '" rx="1" style="fill:var(--down)"/>';
        }
      });
    }
    g += '<line class="xh" x1="0" x2="0" y1="' + m.t + '" y2="' + (m.t + ih) + '" style="display:none"/>';
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(o.label || 'Gráfica') + '">' + g + '</svg>';

    var svg = el.firstChild, xh = svg.querySelector('.xh');
    function nearest(px) {
      var best = 0, bd = Infinity;
      for (var k = 0; k < pts.length; k++) { var d = Math.abs(X(pts[k].t) - px); if (d < bd) { bd = d; best = k; } }
      return best;
    }
    svg.addEventListener('mousemove', function (ev) {
      var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
      if (px < m.l || px > W - m.r) { xh.style.display = 'none'; ui.tip.hide(); return; }
      var p = pts[nearest(px)];
      xh.setAttribute('x1', X(p.t)); xh.setAttribute('x2', X(p.t)); xh.style.display = '';
      var html = '<b>' + F.clock(p.t) + '</b>';
      o.series.forEach(function (s) {
        var val = p[s.key], f = s.fmt || yFmt;
        html += '<div class="t-row"><span><i style="display:inline-block;width:8px;height:3px;border-radius:2px;background:' + s.color + ';margin-right:6px"></i>' + esc(s.name) + '</span><span class="num">' + (U.isNum(val) ? esc(f(val)) : 'sin respuesta') + '</span></div>';
      });
      if (o.band && U.isNum(p[o.band.lo])) html += '<div class="t-row"><span>mín / máx</span><span class="num">' + F.ms(p[o.band.lo]) + ' / ' + F.ms(p[o.band.hi]) + '</span></div>';
      if (o.loss && U.isNum(p.loss)) html += '<div class="t-row"><span>pérdida</span><span class="num">' + F.pct(p.loss, 0) + '</span></div>';
      if (o.extra) html += o.extra(p);
      ui.tip.show(html, ev);
    });
    svg.addEventListener('mouseleave', function () { xh.style.display = 'none'; ui.tip.hide(); });
  }

  /* Mini gráfica de tendencia para tablas (sin ejes). */
  function spark(points, key, w, h, color) {
    var vals = points.filter(function (p) { return U.isNum(p[key]); });
    if (vals.length < 2) return '<svg class="spark" width="' + w + '" height="' + h + '"></svg>';
    var max = 0; vals.forEach(function (p) { if (p[key] > max) max = p[key]; });
    max = max || 1;
    var t0 = points[0].t, span = Math.max(1, points[points.length - 1].t - t0), d = '', pen = false;
    points.forEach(function (p) {
      if (!U.isNum(p[key])) { pen = false; return; }
      d += (pen ? 'L' : 'M') + ((p.t - t0) / span * (w - 2) + 1).toFixed(1) + ' ' + (h - 2 - p[key] / max * (h - 4)).toFixed(1);
      pen = true;
    });
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path d="' + d + '" style="fill:none;stroke:' + (color || 'var(--s1)') + ';stroke-width:1.6;stroke-linejoin:round"/></svg>';
  }

  /* Tira de estado: una celda por muestra (historial UP/DEGRADADO/DOWN de un vistazo). */
  function strip(points, w, h, n) {
    var list = points.slice(-n), cw = w / n, g = '';
    list.forEach(function (p, i) {
      g += '<rect x="' + ((n - list.length + i) * cw + .5).toFixed(1) + '" y="0" width="' + Math.max(1, cw - 1).toFixed(1) + '" height="' + h + '" rx="1" style="fill:' + ui.colorOf(p.s) + ';opacity:' + (p.s === 'unknown' ? .35 : .9) + '"/>';
    });
    return '<svg class="spark" width="' + w + '" height="' + h + '" aria-hidden="true">' + g + '</svg>';
  }

  NOC.charts = { line: line, spark: spark, strip: strip, niceMax: niceMax };
})(window.NOC = window.NOC || {});
