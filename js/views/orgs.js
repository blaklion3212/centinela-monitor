/*
 * Barra de organizaciones: una pestaña por organización con su resumen de estado, y alta / edición / baja.
 * El host (organización "default") siempre existe y es la primera pestaña. Cada organización tiene sus propios
 * objetivos y su propia disposición de ventanas; las alertas de todas llegan a la bitácora global.
 */
(function (NOC) {
  'use strict';
  var U = NOC.util, ui = NOC.ui, store = NOC.store, bus = NOC.bus;
  var bar;

  function badge(kind, n, label) {
    return '<span class="org-st org-st--' + kind + '" title="' + n + ' ' + U.esc(label) + '">' + ui.statusIcon(kind) + '<b class="num">' + n + '</b></span>';
  }

  function render() {
    if (!bar) return;
    var st = store.state, one = st.orgs.length < 2;
    bar.innerHTML = '<div class="org-tabs" role="tablist" aria-label="Organizaciones">' +
      st.orgs.map(function (o) {
        var c = store.orgSummary(o.id), sel = o.id === st.orgId, parts = '';
        if (c.down) parts += badge('down', c.down, 'DOWN');
        if (c.degraded) parts += badge('degraded', c.degraded, 'degradado');
        if (!c.down && !c.degraded) parts += c.total ? badge('up', c.up, 'arriba') : '<span class="org-st org-st--empty muted" title="Sin objetivos">0</span>';
        return '<button type="button" role="tab" class="org-tab" aria-selected="' + sel + '" data-org="' + U.esc(o.id) + '" style="--oc:' + U.esc(o.color) + '" title="' + U.esc(o.note || o.name) + '">' +
          '<i class="org-dot"></i><span class="org-name">' + U.esc(o.name) + '</span>' + parts + '</button>';
      }).join('') + '</div>' +
      '<button type="button" class="btn btn--sm btn--ghost" data-org-add>' + ui.icon('plus') + '<span class="org-add-lbl"> Organización</span></button>' +
      '<button type="button" class="icon-btn" data-org-edit title="Editar organización activa" aria-label="Editar organización activa">' + ui.icon('edit') + '</button>';
    bar.classList.toggle('org-bar--single', one);
  }

  function form(o) {
    function v(x) { return U.esc(x == null ? '' : x); }
    return '<form id="of" novalidate><div data-errors></div>' +
      '<div class="field"><label for="o-name">Nombre de la organización</label><input id="o-name" type="text" maxlength="60" value="' + v(o && o.name) + '" placeholder="Ej. Cliente ACME, Sucursal Norte" required></div>' +
      '<div class="row c2"><div class="field"><label for="o-color">Color de identificación</label><input id="o-color" type="color" value="' + v(o ? o.color : '#2cc9b5') + '"></div>' +
      '<div class="field"><label for="o-note">Nota (opcional)</label><input id="o-note" type="text" maxlength="200" value="' + v(o && o.note) + '" placeholder="Contacto, ubicación…"></div></div></form>';
  }

  function read(root) {
    return { name: root.querySelector('#o-name').value, color: root.querySelector('#o-color').value, note: root.querySelector('#o-note').value };
  }

  function showErrors(root, e) {
    var box = root.querySelector('[data-errors]');
    box.innerHTML = '<div class="errors" role="alert"><ul>' + (e.errors || [e.message]).map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul></div>';
  }

  function openForm(org) {
    var isNew = !org, isDefault = org && org.id === 'default';
    var actions = [{ label: 'Cancelar' }];
    if (!isNew && !isDefault) actions.unshift({ label: 'Eliminar', kind: 'danger', onClick: function (close) { close(); remove(org); } });
    actions.push({ label: isNew ? 'Crear organización' : 'Guardar', kind: 'primary', onClick: function (close, root) {
      var data = read(root);
      var p = isNew ? NOC.data.createOrg(data) : NOC.data.updateOrg(org.id, data);
      p.then(function (saved) {
        close();
        ui.toast(isNew ? 'Organización creada' : 'Organización guardada', 'ok');
        if (isNew) NOC.data.switchOrg(saved.id);
      }, function (e) { showErrors(root, e); });
    } });
    var m = ui.modal({ title: isNew ? 'Nueva organización' : 'Editar organización', body: form(org), actions: actions });
    m.root.querySelector('#of').addEventListener('submit', function (e) { e.preventDefault(); });
    m.root.querySelector('#of').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); m.root.querySelector('.modal__foot .btn--primary').click(); }
    });
    if (isNew) m.root.querySelector('.modal__body').insertAdjacentHTML('beforeend', '<p class="muted" style="margin-top:12px">Tendrá su propio panel con las mismas ventanas. Después agrega sus IPs y URLs en la sección Objetivos.</p>');
  }

  function remove(org) {
    var n = org.targets != null ? org.targets : 0;
    ui.confirm('Eliminar organización', 'Se elimina <b>' + U.esc(org.name) + '</b> con sus ' + n + ' objetivos y su disposición de ventanas. Esta acción no se puede deshacer.', 'Eliminar', function () {
      var wasActive = org.id === store.state.orgId;
      NOC.data.removeOrg(org.id).then(function () {
        ui.toast('Organización eliminada', 'ok');
        if (wasActive) NOC.data.switchOrg('default');
      }, function (e) { ui.toast(e.message, 'err'); });
    }, true);
  }

  NOC.views = NOC.views || {};
  NOC.views.orgs = {
    mount: function (el) {
      bar = el;
      bar.addEventListener('click', function (e) {
        var t = e.target.closest('[data-org]');
        if (t) { NOC.data.switchOrg(t.getAttribute('data-org')).catch(function (er) { ui.toast(er.message, 'err'); }); return; }
        if (e.target.closest('[data-org-add]')) return openForm(null);
        if (e.target.closest('[data-org-edit]')) { var o = store.org(store.state.orgId); if (o) openForm(o); }
      });
      ['orgs', 'org', 'data', 'targets'].forEach(function (ev) { bus.on(ev, render); });
      render();
    },
    render: render
  };
})(window.NOC = window.NOC || {});
