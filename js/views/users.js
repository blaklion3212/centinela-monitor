/* Vista Usuarios (solo administradores): alta, edición de rol, cambio de contraseña, deshabilitar y eliminar. */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui;
  var root, list = [];

  var ROLE_TEXT = { admin: 'Administrador', operator: 'Operador', viewer: 'Lector' };
  var ROLE_DESC = {
    admin: 'Todo, incluida la gestión de usuarios.',
    operator: 'Agrega y edita objetivos, organizaciones, ajustes y ventanas. No gestiona usuarios.',
    viewer: 'Solo consulta el panel. No puede modificar nada.'
  };

  function call(method, url, body) {
    var opts = { method: method, cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET') opts.body = JSON.stringify(body || {});
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (r.status === 401) { NOC.auth.onUnauthorized(); }
        if (!r.ok) { var e = new Error((j && (j.error || (j.errors && j.errors[0]))) || 'Error HTTP ' + r.status); e.errors = (j && j.errors) || [e.message]; throw e; }
        return j;
      });
    });
  }

  function load() {
    return call('GET', '/api/users').then(function (j) { list = j.users; render(); }, function (e) { ui.toast(e.message, 'err'); });
  }

  function render() {
    if (!root) return;
    var me = NOC.auth.user;
    root.querySelector('[data-body]').innerHTML = '<table class="tbl"><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Creado</th><th>Último acceso</th><th></th></tr></thead><tbody>' +
      list.map(function (u) {
        var self = me && u.id === me.id;
        return '<tr data-id="' + U.esc(u.id) + '"><td><div class="tname">' + U.esc(u.username) + (self ? ' <span class="chip chip--kind">tú</span>' : '') + '</div></td>' +
          '<td><span class="chip">' + U.esc(ROLE_TEXT[u.role] || u.role) + '</span></td>' +
          '<td>' + (u.disabled ? ui.status('paused').replace('PAUSADO', 'DESHABILITADO') : ui.status('up').replace('UP', 'ACTIVO')) + (u.mustChange ? ' <span class="chip c-degraded" title="Debe cambiar su contraseña en el próximo inicio de sesión">debe cambiar la contraseña</span>' : '') + '</td>' +
          '<td class="muted">' + F.dateTime(u.createdAt) + '</td><td class="muted">' + (u.lastLogin ? F.dateTime(u.lastLogin) : 'nunca') + '</td>' +
          '<td style="white-space:nowrap"><button type="button" class="icon-btn" data-edit title="Editar" aria-label="Editar ' + U.esc(u.username) + '">' + ui.icon('edit') + '</button>' +
          (self ? '' : '<button type="button" class="icon-btn danger" data-del title="Eliminar" aria-label="Eliminar ' + U.esc(u.username) + '">' + ui.icon('trash') + '</button>') + '</td></tr>';
      }).join('') + '</tbody></table>';
    root.querySelector('[data-count]').textContent = list.length + (list.length === 1 ? ' usuario' : ' usuarios');
  }

  function roleOptions(sel) {
    return ['admin', 'operator', 'viewer'].map(function (r) { return '<option value="' + r + '"' + (r === sel ? ' selected' : '') + '>' + ROLE_TEXT[r] + '</option>'; }).join('');
  }

  function form(u) {
    var isNew = !u;
    var me = NOC.auth.user, self = !isNew && me && u.id === me.id;
    return '<form id="uf" novalidate autocomplete="off"><div data-errors></div>' +
      '<div class="field"><label for="u-name">Usuario</label><input id="u-name" type="text" maxlength="32" autocapitalize="off" spellcheck="false" value="' + U.esc(u ? u.username : '') + '" required><span class="hint">3 a 32 caracteres: letras, números y . _ @ -</span></div>' +
      '<div class="field"><label for="u-role">Rol</label><select id="u-role">' + roleOptions(u ? u.role : 'viewer') + '</select><span class="hint" data-role-hint></span></div>' +
      '<div class="field"><label for="u-pass">' + (isNew ? 'Contraseña' : 'Nueva contraseña (opcional)') + '</label><input id="u-pass" type="password" maxlength="200" autocomplete="new-password"><span class="hint">' + (isNew ? 'Mínimo 8 caracteres.' : 'Déjala vacía para conservar la actual. Mínimo 8 caracteres; al cambiarla se cierran sus sesiones abiertas.') + '</span></div>' +
      // En la cuenta propia no se ofrece el cambio forzado (cambiaría la contraseña de quien está editando).
      (self ? '' : '<div class="field"><label class="check"><input id="u-fc" type="checkbox"' + (isNew ? '' : ' checked') + '> Obligar a cambiar la contraseña al entrar</label>' + (isNew ? '' : '<span class="hint">Se aplica solo si escribes una nueva contraseña.</span>') + '</div>') +
      (isNew ? '' : '<div class="field"><label class="check"><input id="u-dis" type="checkbox"' + (u.disabled ? ' checked' : '') + '> Deshabilitar usuario (no puede iniciar sesión)</label></div>') +
      '</form>';
  }
  function showErrors(m, e) {
    m.querySelector('[data-errors]').innerHTML = '<div class="errors" role="alert"><ul>' + (e.errors || [e.message]).map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul></div>';
  }

  function openForm(u) {
    var isNew = !u;
    var m = ui.modal({ title: isNew ? 'Nuevo usuario' : 'Editar usuario', body: form(u), actions: [{ label: 'Cancelar' },
      { label: isNew ? 'Crear usuario' : 'Guardar', kind: 'primary', onClick: function (close, back) {
        var body = { username: back.querySelector('#u-name').value.trim(), role: back.querySelector('#u-role').value };
        var pw = back.querySelector('#u-pass').value;
        if (pw || isNew) body.password = pw;
        var fc = back.querySelector('#u-fc'); // no existe al editarse a uno mismo
        if ((pw || isNew) && fc) body.forceChange = fc.checked;
        if (!isNew) body.disabled = back.querySelector('#u-dis').checked;
        var p = isNew ? call('POST', '/api/users', body) : call('PUT', '/api/users/' + encodeURIComponent(u.id), body);
        p.then(function () { close(); ui.toast(isNew ? 'Usuario creado' : 'Usuario guardado', 'ok'); load(); }, function (e) { showErrors(back, e); });
      } }] });
    var sel = m.root.querySelector('#u-role'), hint = m.root.querySelector('[data-role-hint]');
    function sync() { hint.textContent = ROLE_DESC[sel.value] || ''; }
    sel.addEventListener('change', sync); sync();
    m.root.querySelector('#uf').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); m.root.querySelector('.modal__foot .btn--primary').click(); } });
  }

  NOC.views = NOC.views || {};
  NOC.views.users = {
    mount: function (el) {
      root = el;
      el.innerHTML = '<div class="toolbar"><div><h1 class="page-title">Usuarios</h1><div class="page-sub">Quién puede entrar al panel y qué puede hacer. <span data-count></span></div></div><span class="sp"></span>' +
        '<button type="button" class="btn btn--primary" data-add>' + ui.icon('plus') + ' Nuevo usuario</button></div>' +
        '<div class="panel"><div class="table-scroll" data-body></div></div>' +
        '<div class="panel" style="margin-top:14px"><div class="panel-head"><h2>Roles</h2></div><div class="panel-body"><ul class="help-list">' +
        ['admin', 'operator', 'viewer'].map(function (r) { return '<li><b>' + ROLE_TEXT[r] + ':</b> ' + ROLE_DESC[r] + '</li>'; }).join('') + '</ul></div></div>';
      el.addEventListener('click', function (e) {
        if (e.target.closest('[data-add]')) return openForm(null);
        var row = e.target.closest('tr[data-id]'); if (!row) return;
        var u = list.filter(function (x) { return x.id === row.getAttribute('data-id'); })[0]; if (!u) return;
        if (e.target.closest('[data-edit]')) openForm(u);
        if (e.target.closest('[data-del]')) ui.confirm('Eliminar usuario', '¿Eliminar a <b>' + U.esc(u.username) + '</b>? Sus sesiones abiertas se cierran y no podrá volver a entrar.', 'Eliminar', function () {
          call('DELETE', '/api/users/' + encodeURIComponent(u.id)).then(function () { ui.toast('Usuario eliminado', 'ok'); load(); }, function (er) { ui.toast(er.message, 'err'); });
        }, true);
      });
    },
    refresh: load
  };
})(window.NOC = window.NOC || {});
