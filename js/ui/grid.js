/*
 * Gestor de ventanas del dashboard (rejilla de 12 columnas con gravedad vertical).
 *  - Arrastrar desde la barra de título, redimensionar desde borde/esquina, ampliar a pantalla casi completa.
 *  - Al mover o cambiar el tamaño, las demás ventanas se apartan y se compactan hacia arriba.
 *  - En pantallas angostas las ventanas se apilan y no se arrastran.
 * La ventana solo conoce su definición (NOC.widgets); aquí no hay lógica de monitoreo.
 */
(function (NOC) {
  'use strict';
  var U = NOC.util, ui = NOC.ui, store = NOC.store, bus = NOC.bus;
  var COLS = 12, ROW = 34, GAP = 10, MOBILE_W = 760;

  function collides(a, b) { return a !== b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
  function byPos(a, b) { return a.y - b.y || a.x - b.x; }

  // Aparta hacia abajo todo lo que choque con "fixed" (y en cascada).
  function resolve(items, fixed) {
    var queue = [fixed], guard = 0;
    while (queue.length && guard++ < 4000) {
      var a = queue.shift();
      items.slice().sort(byPos).forEach(function (b) {
        if (collides(a, b)) { b.y = a.y + a.h; queue.push(b); }
      });
    }
  }
  // Sube cada ventana lo más posible sin chocar (el elemento "fixed" no se mueve).
  function compact(items, fixed) {
    var placed = fixed ? [fixed] : [];
    items.slice().sort(byPos).forEach(function (it) {
      if (it === fixed) return;
      while (it.y > 0) {
        it.y--;
        if (placed.some(function (p) { return collides(it, p); })) { it.y++; break; }
      }
      while (placed.some(function (p) { return collides(it, p); })) it.y++;
      placed.push(it);
    });
  }
  function tidy(items, fixed) { if (fixed) resolve(items, fixed); compact(items, fixed); }

  function Grid(el, opts) {
    var self = this;
    this.el = el; this.opts = opts;
    this.items = []; this.wins = {}; this.states = {};
    this.locked = false; this.maxId = null; this.maxBack = null; this.mobile = false;
    this.dirtyRender = false;
    el.classList.add('grid');
    this.ghost = document.createElement('div'); this.ghost.className = 'grid-ghost'; this.ghost.style.display = 'none';
    el.appendChild(this.ghost);
    this.ro = new ResizeObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.target === el) { self.relayout(); return; }
        var id = en.target.getAttribute('data-win');
        var s = self.states[id];
        if (s && (s.lastW !== en.contentRect.width || s.lastH !== en.contentRect.height)) self.queueRender(id);
      });
    });
    this.ro.observe(el);
  }

  Grid.prototype.metrics = function () {
    var W = this.el.clientWidth || 1000;
    this.mobile = W < MOBILE_W;
    var colW = (W - GAP * (COLS - 1)) / COLS;
    return { W: W, colW: colW, px: colW + GAP, py: ROW + GAP };
  };

  Grid.prototype.def = function (type) { return NOC.widgets.get(type); };

  Grid.prototype.load = function (layout) {
    var self = this;
    Object.keys(this.wins).forEach(function (id) { self.destroyWin(id); });
    this.clearMaxBack(); this.maxId = null;
    this.items = [];
    this.locked = !!(layout && layout.locked);
    ((layout && layout.widgets) || []).forEach(function (w) {
      var d = self.def(w.type);
      if (!d) return; // tipo desconocido (por ejemplo de una versión anterior): se omite
      self.items.push({ id: w.id, type: w.type, x: U.clamp(w.x | 0, 0, COLS - 1), y: Math.max(0, w.y | 0),
        w: U.clamp(w.w | 0 || d.w, 1, COLS), h: Math.max(2, w.h | 0 || d.h), config: w.config || {} });
    });
    this.items.forEach(function (it) { it.x = Math.min(it.x, COLS - it.w); });
    // Si dos ventanas guardadas se solapan, tidy las separa.
    this.items.slice().sort(byPos).forEach(function (it, i, arr) { resolve(arr.slice(0, i + 1), it); });
    tidy(this.items, null);
    this.items.forEach(function (it) { self.createWin(it); });
    this.applyLock();
    this.relayout();
    this.renderAll();
  };

  Grid.prototype.toLayout = function () {
    return { version: 1, locked: this.locked, widgets: this.items.map(function (it) {
      return { id: it.id, type: it.type, x: it.x, y: it.y, w: it.w, h: it.h, config: it.config || {} };
    }) };
  };
  Grid.prototype.changed = function () { if (this.opts.onChange) this.opts.onChange(this.toLayout()); };

  Grid.prototype.applyLock = function () {
    this.el.classList.toggle('locked', this.locked);
    var self = this;
    Object.keys(this.wins).forEach(function (id) { self.syncControls(id); });
  };
  Grid.prototype.setLocked = function (v) { this.locked = !!v; this.applyLock(); this.changed(); };

  /* ---------- creación de ventanas ---------- */
  Grid.prototype.createWin = function (it) {
    var self = this, d = this.def(it.type);
    var win = document.createElement('section');
    win.className = 'win'; win.setAttribute('data-win', it.id);
    win.innerHTML =
      '<header class="win__head"><div class="win__title">' + ui.icon(d.icon) + '<span>' + U.esc(d.title) + '</span></div>' +
      '<select class="win__target" aria-label="Objetivo de la ventana" hidden></select><div class="win__sp"></div>' +
      '<div class="win__ctl"><button type="button" class="icon-btn" data-a="max" title="Ampliar" aria-label="Ampliar ventana">' + ui.icon('max') + '</button>' +
      '<button type="button" class="icon-btn danger" data-a="close" title="Quitar ventana" aria-label="Quitar ventana">' + ui.icon('x') + '</button></div></header>' +
      '<div class="win__body' + (d.flush ? ' flush' : '') + '" data-win="' + U.esc(it.id) + '"></div>' +
      '<div class="win__resize e" data-r="e"></div><div class="win__resize s" data-r="s"></div><div class="win__resize se" data-r="se"></div>';
    this.el.appendChild(win);
    var body = win.querySelector('.win__body');
    var st = this.states[it.id] = { win: win, body: body, state: {}, inited: false, lastW: 0, lastH: 0, def: d };
    this.wins[it.id] = win;
    this.ro.observe(body);

    win.querySelector('.win__target').addEventListener('change', function (e) {
      it.config = Object.assign({}, it.config, { targetId: e.target.value }); self.changed(); self.queueRender(it.id);
    });
    win.addEventListener('click', function (e) {
      var b = e.target.closest('[data-a]'); if (!b) return;
      if (b.getAttribute('data-a') === 'max') self.toggleMax(it.id);
      if (b.getAttribute('data-a') === 'close' && !self.locked) self.remove(it.id);
    });
    win.querySelector('.win__head').addEventListener('pointerdown', function (e) {
      if (e.target.closest('button, select, input') || self.locked || self.mobile || self.maxId || e.button !== 0) return;
      self.startDrag(e, it);
    });
    win.addEventListener('pointerdown', function (e) {
      var h = e.target.closest('[data-r]');
      if (h && !self.locked && !self.mobile && e.button === 0) self.startResize(e, it, h.getAttribute('data-r'));
    });
    this.syncControls(it.id);
  };

  Grid.prototype.syncControls = function (id) {
    var st = this.states[id]; if (!st) return;
    var close = st.win.querySelector('[data-a="close"]');
    close.hidden = this.locked;
  };

  Grid.prototype.destroyWin = function (id) {
    var st = this.states[id]; if (!st) return;
    if (st.def.destroy && st.inited) { try { st.def.destroy(st.ctx); } catch (e) { /* ignorar */ } }
    this.ro.unobserve(st.body);
    st.win.remove();
    delete this.wins[id]; delete this.states[id];
    if (this.maxId === id) { this.maxId = null; this.clearMaxBack(); }
  };

  // Quita el fondo de la ventana ampliada (si lo hay).
  Grid.prototype.clearMaxBack = function () {
    if (this.maxBack) { this.maxBack.remove(); this.maxBack = null; }
  };

  /* ---------- posición ---------- */
  Grid.prototype.place = function (it, m, override) {
    var win = this.wins[it.id]; if (!win) return;
    var o = override || {};
    if (this.mobile) {
      win.style.height = (it.h * ROW + (it.h - 1) * GAP) + 'px';
      return;
    }
    var left = o.left != null ? o.left : it.x * m.px, top = o.top != null ? o.top : it.y * m.py;
    var w = o.w != null ? o.w : it.w * m.colW + (it.w - 1) * GAP, h = o.h != null ? o.h : it.h * ROW + (it.h - 1) * GAP;
    win.style.transform = 'translate(' + left.toFixed(1) + 'px,' + top.toFixed(1) + 'px)';
    win.style.width = w.toFixed(1) + 'px'; win.style.height = h.toFixed(1) + 'px';
  };

  Grid.prototype.relayout = function () {
    var m = this.metrics(), self = this;
    this.el.classList.toggle('is-mobile', this.mobile);
    if (this.mobile) {
      this.el.style.height = '';
      this.items.slice().sort(byPos).forEach(function (it, i) { self.wins[it.id].style.order = i; self.place(it, m); self.wins[it.id].style.transform = ''; });
    } else {
      var bottom = 0;
      this.items.forEach(function (it) { self.wins[it.id].style.order = ''; self.place(it, m); bottom = Math.max(bottom, it.y + it.h); });
      this.el.style.height = Math.max(bottom * m.py - GAP, 120) + 'px';
    }
    this.updateEmpty();
  };

  Grid.prototype.updateEmpty = function () {
    var e = this.el.querySelector('.grid-empty');
    if (!this.items.length && !e) {
      e = document.createElement('div'); e.className = 'grid-empty';
      e.innerHTML = '<div><b>El dashboard está vacío</b><p>Usa “Agregar ventana” para empezar.</p></div>';
      this.el.appendChild(e);
    } else if (this.items.length && e) e.remove();
  };

  /* ---------- arrastrar ---------- */
  Grid.prototype.startDrag = function (e, it) {
    var self = this, win = this.wins[it.id], m = this.metrics();
    var startX = e.clientX, startY = e.clientY, left0 = it.x * m.px, top0 = it.y * m.py;
    var moved = false;
    win.setPointerCapture(e.pointerId);
    function move(ev) {
      var dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) { moved = true; win.classList.add('is-active'); self.ghost.style.display = ''; }
      var left = left0 + dx, top = Math.max(0, top0 + dy);
      var gx = U.clamp(Math.round(left / m.px), 0, COLS - it.w), gy = Math.max(0, Math.round(top / m.py));
      if (gx !== it.x || gy !== it.y) {
        it.x = gx; it.y = gy;
        tidy(self.items, it);
        self.items.forEach(function (o) { if (o !== it) self.place(o, m); });
        self.syncHeight(m);
      }
      self.place(it, m, { left: left, top: top });
      self.showGhost(it, m);
      self.autoScroll(ev);
    }
    function up() {
      win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', up);
      win.classList.remove('is-active'); self.ghost.style.display = 'none';
      if (moved) { self.relayout(); self.changed(); }
    }
    win.addEventListener('pointermove', move); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', up);
  };

  Grid.prototype.syncHeight = function (m) {
    var bottom = 0; this.items.forEach(function (it) { bottom = Math.max(bottom, it.y + it.h); });
    this.el.style.height = Math.max(bottom * m.py - GAP, 120) + 'px';
  };
  Grid.prototype.showGhost = function (it, m) {
    var g = this.ghost;
    g.style.transform = 'translate(' + (it.x * m.px) + 'px,' + (it.y * m.py) + 'px)';
    g.style.width = (it.w * m.colW + (it.w - 1) * GAP) + 'px'; g.style.height = (it.h * ROW + (it.h - 1) * GAP) + 'px';
  };
  Grid.prototype.autoScroll = function (ev) {
    if (ev.clientY > innerHeight - 50) scrollBy(0, 16); else if (ev.clientY < 110) scrollBy(0, -16);
  };

  /* ---------- redimensionar ---------- */
  Grid.prototype.startResize = function (e, it, edge) {
    e.preventDefault(); e.stopPropagation();
    var self = this, win = this.wins[it.id], m = this.metrics(), d = this.def(it.type);
    var startX = e.clientX, startY = e.clientY;
    var w0 = it.w * m.colW + (it.w - 1) * GAP, h0 = it.h * ROW + (it.h - 1) * GAP;
    var minW = d.minW || 2, minH = d.minH || 3, resized = false;
    win.setPointerCapture(e.pointerId);
    win.classList.add('is-active'); this.ghost.style.display = '';
    function move(ev) {
      resized = true;
      var pw = w0 + (edge.indexOf('e') >= 0 ? ev.clientX - startX : 0);
      var ph = h0 + (edge.indexOf('s') >= 0 ? ev.clientY - startY : 0);
      var gw = U.clamp(Math.round((pw + GAP) / m.px), minW, COLS - it.x);
      var gh = Math.max(minH, Math.round((ph + GAP) / (ROW + GAP)));
      if (gw !== it.w || gh !== it.h) {
        it.w = gw; it.h = gh;
        tidy(self.items, it);
        self.items.forEach(function (o) { if (o !== it) self.place(o, m); });
        self.syncHeight(m);
      }
      self.place(it, m, { w: Math.max(m.colW * minW, pw), h: Math.max(minH * ROW, ph) });
      self.showGhost(it, m);
      self.autoScroll(ev);
    }
    function up() {
      win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', up);
      win.classList.remove('is-active'); self.ghost.style.display = 'none';
      self.relayout();
      if (resized) self.changed();
    }
    win.addEventListener('pointermove', move); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', up);
  };

  /* ---------- ampliar ---------- */
  Grid.prototype.toggleMax = function (id) {
    var self = this;
    if (!this.wins[id]) return; // ventana inexistente (ya destruida)
    if (this.maxId) {
      var prev = this.maxId; this.maxId = null;
      this.clearMaxBack();
      if (this.wins[prev]) {
        this.wins[prev].classList.remove('win--max');
        this.wins[prev].querySelector('[data-a="max"]').innerHTML = ui.icon('max');
        this.queueRender(prev);
      }
      if (prev === id) return;
    }
    this.maxId = id;
    var back = this.maxBack = document.createElement('div'); back.className = 'max-back';
    back.addEventListener('click', function () { self.toggleMax(id); });
    document.body.appendChild(back);
    this.wins[id].classList.add('win--max');
    this.wins[id].querySelector('[data-a="max"]').innerHTML = ui.icon('min');
    this.queueRender(id);
  };

  /* ---------- agregar / quitar ---------- */
  Grid.prototype.add = function (type, config) {
    var d = this.def(type); if (!d) return null;
    var it = { id: U.uid('w'), type: type, x: 0, y: 9999, w: d.w, h: d.h, config: config || {} };
    this.items.push(it);
    tidy(this.items, null);
    this.createWin(it);
    this.relayout();
    this.queueRender(it.id);
    this.changed();
    var win = this.wins[it.id];
    setTimeout(function () { win.scrollIntoView({ behavior: 'smooth', block: 'center' }); win.classList.add('is-active'); setTimeout(function () { win.classList.remove('is-active'); }, 900); }, 60);
    return it;
  };
  Grid.prototype.remove = function (id) {
    this.items = this.items.filter(function (it) { return it.id !== id; });
    this.destroyWin(id);
    tidy(this.items, null);
    this.relayout();
    this.changed();
  };
  Grid.prototype.count = function (type) { return this.items.filter(function (i) { return i.type === type; }).length; };

  /* ---------- render de contenidos ---------- */
  Grid.prototype.queueRender = function (id) {
    var self = this;
    (this.pending = this.pending || {})[id] = true;
    if (this.raf) return;
    this.raf = requestAnimationFrame(function () {
      var ids = Object.keys(self.pending); self.pending = {}; self.raf = 0;
      ids.forEach(function (i) { self.renderOne(i); });
    });
  };
  Grid.prototype.renderAll = function () { var self = this; this.items.forEach(function (it) { self.queueRender(it.id); }); };

  // Objetivo que usa la ventana: el elegido, o el enfocado, o el primero compatible.
  Grid.prototype.resolveTarget = function (it, d) {
    if (d.target === 'none') return null;
    var all = store.targets(function (t) { return !d.accepts || d.accepts(t); });
    var chosen = it.config && it.config.targetId ? store.getTarget(it.config.targetId) : null;
    if (chosen && (!d.accepts || d.accepts(chosen))) return chosen;
    var f = store.state.focusId ? store.getTarget(store.state.focusId) : null;
    if (f && (!d.accepts || d.accepts(f))) return f;
    return all.filter(function (t) { return t.enabled; })[0] || all[0] || null;
  };

  Grid.prototype.syncTargetSelect = function (it, st, d) {
    var sel = st.win.querySelector('.win__target');
    if (d.target === 'none') { sel.hidden = true; return; }
    var list = store.targets(function (t) { return !d.accepts || d.accepts(t); });
    var sig = list.map(function (t) { return t.id + t.name; }).join('|') + '#' + ((it.config && it.config.targetId) || '');
    if (st.selSig === sig) return;
    st.selSig = sig;
    sel.hidden = false;
    sel.innerHTML = '<option value="">Automático (selección actual)</option>' + list.map(function (t) {
      return '<option value="' + U.esc(t.id) + '">' + U.esc(t.name) + '</option>';
    }).join('');
    sel.value = (it.config && it.config.targetId) || '';
  };

  Grid.prototype.renderOne = function (id) {
    var it = this.items.filter(function (i) { return i.id === id; })[0], st = this.states[id];
    if (!it || !st) return;
    var d = st.def;
    st.lastW = st.body.clientWidth; st.lastH = st.body.clientHeight;
    var target = this.resolveTarget(it, d);
    this.syncTargetSelect(it, st, d);
    var ctx = st.ctx = { id: id, body: st.body, state: st.state, config: it.config || {}, target: target,
      width: st.lastW, height: st.lastH, grid: this,
      setConfig: function (patch) { it.config = Object.assign({}, it.config, patch); ctx.config = it.config; this.grid.changed(); } };
    var scrolls = Array.prototype.map.call(st.body.querySelectorAll('[data-keep-scroll]'), function (n) { return n.scrollTop; });
    var bodyScroll = st.body.scrollTop;
    try {
      if (d.init && !st.inited) { d.init(ctx); }
      st.inited = true;
      if (d.target === 'required' && !target) {
        st.body.innerHTML = '<div class="empty">' + ui.icon('server', 'ico--lg') + '<b>No hay objetivos compatibles</b><span>Agrega uno en la vista “Objetivos”.</span></div>';
      } else d.render(ctx);
    } catch (e) {
      console.error('[widget ' + it.type + ']', e);
      st.body.innerHTML = '<div class="empty">' + ui.icon('alert', 'ico--lg') + '<b>Esta ventana tuvo un error</b><span>' + U.esc(e.message) + '</span></div>';
    }
    st.body.scrollTop = bodyScroll;
    Array.prototype.forEach.call(st.body.querySelectorAll('[data-keep-scroll]'), function (n, i) { if (scrolls[i] != null) n.scrollTop = scrolls[i]; });
  };

  NOC.Grid = Grid;
  NOC.gridConst = { COLS: COLS };
})(window.NOC = window.NOC || {});
