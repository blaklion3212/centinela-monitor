/* Vista Panel: barra de herramientas + rejilla de ventanas con guardado automático de la disposición. */
(function (NOC) {
  'use strict';
  var U = NOC.util, ui = NOC.ui, bus = NOC.bus, store = NOC.store;

  NOC.views = NOC.views || {};
  NOC.views.dashboard = {
    grid: null,

    mount: function (root) {
      var self = this;
      root.innerHTML =
        '<div class="toolbar"><div><h1 class="page-title">Panel de monitoreo</h1><div class="page-sub">Arrastra el título de una ventana para moverla, el borde para cambiar su tamaño o ' + 'ampliarla con ' + ui.icon('max') + '.</div></div>' +
        '<span class="sp"></span>' +
        '<button type="button" class="btn" id="btn-add">' + ui.icon('plus') + ' Agregar ventana</button>' +
        '<button type="button" class="btn" id="btn-lock" aria-pressed="false">' + ui.icon('unlock') + ' <span>Disposición libre</span></button>' +
        '<button type="button" class="btn btn--ghost" id="btn-reset">' + ui.icon('reset') + ' Restablecer</button></div>' +
        '<div id="grid"></div>';
      // Cada organización guarda su propia disposición; se fija la organización al momento del cambio por si se cambia de pestaña antes de guardar.
      var saveLayout = U.debounce(function (org, l) { NOC.data.saveLayout(l, org); }, 500);
      this.grid = new NOC.Grid(root.querySelector('#grid'), { onChange: function (l) { self.syncLock(); saveLayout(store.state.orgId, l); } });
      this.root = root;

      root.querySelector('#btn-add').addEventListener('click', function () { self.gallery(); });
      root.querySelector('#btn-lock').addEventListener('click', function () { self.grid.setLocked(!self.grid.locked); });
      root.querySelector('#btn-reset').addEventListener('click', function () {
        ui.confirm('Restablecer disposición', 'Se restaurarán las ventanas y posiciones originales. Tus objetivos y ajustes no cambian.', 'Restablecer', function () {
          self.grid.load(U.clone(NOC.Defaults.LAYOUT)); self.grid.changed(); ui.toast('Disposición restablecida', 'ok');
        });
      });
      ['data', 'focus', 'targets', 'settings', 'mode'].forEach(function (ev) { bus.on(ev, function () { self.grid.renderAll(); }); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && self.grid.maxId && !document.querySelector('.modal-back')) self.grid.toggleMax(self.grid.maxId); });

      bus.on('org', function () { self.reloadLayout(); });
      return this.reloadLayout();
    },

    // Carga la disposición de ventanas de la organización activa (o la predeterminada si aún no tiene).
    reloadLayout: function () {
      var self = this, org = store.state.orgId;
      return NOC.data.loadLayout(org).then(function (l) {
        if (org !== store.state.orgId) return; // se cambió de organización mientras cargaba
        self.grid.load(l && l.widgets && l.widgets.length ? l : U.clone(NOC.Defaults.LAYOUT));
        if (!NOC.auth.can('write')) { self.grid.locked = true; self.grid.applyLock(); } // lector: no puede mover ni quitar ventanas
        self.syncLock();
      });
    },

    syncLock: function () {
      var b = this.root.querySelector('#btn-lock'), locked = this.grid.locked;
      b.setAttribute('aria-pressed', String(locked));
      b.innerHTML = ui.icon(locked ? 'lock' : 'unlock') + ' <span>' + (locked ? 'Disposición bloqueada' : 'Disposición libre') + '</span>';
      b.title = locked ? 'Desbloquear para mover, redimensionar y quitar ventanas' : 'Bloquear para evitar cambios accidentales';
    },

    // Galería de tipos de ventana disponibles (se puede repetir el mismo tipo con distinto objetivo).
    gallery: function () {
      var self = this;
      var body = '<p class="muted" style="margin-bottom:12px">Elige qué quieres ver. Puedes agregar la misma ventana varias veces, cada una con su propio objetivo.</p><div class="gallery">' +
        NOC.widgets.list().map(function (d) {
          var n = self.grid.count(d.type);
          return '<button type="button" class="gal-item" data-type="' + U.esc(d.type) + '">' + ui.icon(d.icon) + '<div><b>' + U.esc(d.title) + (n ? ' <span class="chip">' + n + ' en el panel</span>' : '') + '</b><span>' + U.esc(d.desc) + '</span></div></button>';
        }).join('') + '</div>';
      ui.modal({ title: 'Agregar ventana', body: body, wide: true, onOpen: function (root, close) {
        root.addEventListener('click', function (e) {
          var b = e.target.closest('[data-type]'); if (!b) return;
          if (self.grid.locked) self.grid.setLocked(false);
          self.grid.add(b.getAttribute('data-type')); close();
        });
      } });
    }
  };
})(window.NOC = window.NOC || {});
