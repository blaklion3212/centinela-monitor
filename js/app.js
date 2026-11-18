/* Arranque de la aplicación: navegación, tema, barra superior y avisos de modo. */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui, store = NOC.store, bus = NOC.bus;
  var VIEWS = { panel: 'dashboard', objetivos: 'targets', usuarios: 'users', ajustes: 'settings' };
  var current = null, mounted = {};

  var app = NOC.app = {
    applyTheme: function (theme) {
      theme = theme === 'light' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', theme);
      try { localStorage.setItem('centinela.theme', theme); } catch (e) { /* sin almacenamiento */ }
      var b = document.getElementById('btn-theme');
      if (b) b.innerHTML = ui.icon(theme === 'light' ? 'moon' : 'sun');
      if (b) b.title = theme === 'light' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro';
    },

    changePassword: changePassword,

    route: function () {
      var name = (location.hash.replace(/^#\/?/, '') || 'panel');
      if (!VIEWS[name] || (name === 'usuarios' && !(NOC.auth.authEnabled && NOC.auth.can('users')))) name = 'panel';
      Object.keys(VIEWS).forEach(function (n) {
        var v = document.getElementById('view-' + n);
        v.hidden = n !== name;
      });
      document.querySelectorAll('.nav button').forEach(function (b) {
        if (b.getAttribute('data-nav') === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
      current = name;
      if (name === 'ajustes') NOC.views.settings.refresh(document.getElementById('view-ajustes'));
      if (name === 'usuarios') NOC.views.users.refresh();
      if (name === 'panel' && NOC.views.dashboard.grid) { NOC.views.dashboard.grid.relayout(); NOC.views.dashboard.grid.renderAll(); }
    }
  };

  function topbar() {
    // Indicador global: cuenta los objetivos de TODAS las organizaciones.
    var s = store.orgSummary(null), st = store.state;
    var pill = document.getElementById('global-pill');
    var worst = s.down ? 'down' : s.degraded ? 'degraded' : s.total ? 'up' : 'unknown';
    pill.innerHTML = ui.status(worst, { word: true }) + '<span class="muted" style="margin-left:6px">' + (s.total ? s.up + '/' + s.total + ' arriba' : 'sin objetivos') + '</span>';
    pill.title = st.orgs.length > 1 ? 'Estado de todas las organizaciones' : '';
    var mb = document.getElementById('mode-badge');
    var paused = st.mode !== 'demo' && st.paused;
    var kind = st.mode === 'demo' ? 'demo' : paused ? 'paused' : (st.connected ? 'live' : 'off');
    mb.className = 'mode-badge ' + kind;
    mb.innerHTML = '<i></i>' + (st.mode === 'demo' ? 'Demostración' : paused ? 'En vivo en otra pestaña' : st.connected ? 'En vivo' : 'Sin conexión con el servidor');
    // En pausa la insignia es un botón: clic o Enter/Espacio reconecta.
    if (paused) { mb.setAttribute('data-resume', ''); mb.setAttribute('role', 'button'); mb.tabIndex = 0; mb.title = 'Este panel está en vivo en otra pestaña. Clic para reconectar aquí.'; }
    else { mb.removeAttribute('data-resume'); mb.removeAttribute('role'); mb.removeAttribute('tabindex'); mb.removeAttribute('title'); }
    document.title = (s.down ? '(' + s.down + ' DOWN) ' : s.degraded ? '(' + s.degraded + ' degradado) ' : '') + 'Centinela · Monitoreo';
    var banner = document.getElementById('demo-banner');
    if (banner) banner.hidden = !(st.mode === 'demo') || banner.getAttribute('data-dismissed') === '1';
  }
  // Usuario conectado: nombre, rol, cambiar contraseña y cerrar sesión (solo con servidor real).
  var ROLE_TEXT = { admin: 'Administrador', operator: 'Operador', viewer: 'Lector' };
  function userBox() {
    var box = document.getElementById('user-box'), a = NOC.auth, u = a.user;
    var show = store.state.mode === 'live' && a.authEnabled && u;
    box.hidden = !show;
    document.getElementById('nav-users').hidden = !(show && a.can('users'));
    var pb = document.getElementById('pw-banner'); if (pb) pb.hidden = !(show && u.mustChange);
    if (!show) { box.innerHTML = ''; return; }
    box.innerHTML = '<span class="user-chip" title="' + U.esc(ROLE_TEXT[u.role] || u.role) + '">' + ui.icon('user') + '<span class="user-name">' + U.esc(u.username) + '</span><small>' + U.esc(ROLE_TEXT[u.role] || u.role) + '</small></span>' +
      '<button type="button" class="icon-btn" data-change-pw title="Cambiar contraseña" aria-label="Cambiar contraseña">' + ui.icon('key') + '</button>' +
      '<button type="button" class="icon-btn" data-logout title="Cerrar sesión" aria-label="Cerrar sesión">' + ui.icon('logout') + '</button>';
  }
  // Modal de cambio de contraseña. Con opts.forced (contraseña por defecto) no se puede cancelar: solo cambiarla o cerrar sesión.
  // Devuelve una promesa que resuelve cuando la contraseña se cambió.
  function changePassword(opts) {
    var forced = !!(opts && opts.forced), done;
    var finished = new Promise(function (resolve) { done = resolve; });
    var m = ui.modal({ title: forced ? 'Debes cambiar tu contraseña' : 'Cambiar contraseña', persistent: forced, body:
      (forced ? '<p class="muted" style="margin:0 0 10px">Tu cuenta usa la contraseña por defecto. Por seguridad debes definir una nueva antes de continuar.</p>' : '') +
      '<form id="pf" novalidate autocomplete="off"><div data-errors></div>' +
      '<div class="field"><label for="pw-cur">Contraseña actual</label><input id="pw-cur" type="password" autocomplete="current-password" maxlength="200"></div>' +
      '<div class="field"><label for="pw-new">Contraseña nueva</label><input id="pw-new" type="password" autocomplete="new-password" maxlength="200"><span class="hint">Mínimo 8 caracteres. Se cerrarán tus otras sesiones abiertas.</span></div>' +
      '<div class="field"><label for="pw-rep">Repite la contraseña nueva</label><input id="pw-rep" type="password" autocomplete="new-password" maxlength="200"></div></form>',
      actions: [forced ? { label: 'Cerrar sesión', onClick: function () { NOC.auth.logout(); } } : { label: 'Cancelar' }, { label: 'Cambiar contraseña', kind: 'primary', onClick: function (close, back) {
        var cur = back.querySelector('#pw-cur').value, nw = back.querySelector('#pw-new').value, rep = back.querySelector('#pw-rep').value;
        var box = back.querySelector('[data-errors]');
        function err(list) { box.innerHTML = '<div class="errors" role="alert"><ul>' + list.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul></div>'; }
        if (nw !== rep) return err(['La contraseña nueva y su repetición no coinciden.']);
        NOC.auth.changePassword(cur, nw).then(function () { close(); ui.toast('Contraseña cambiada', 'ok'); userBox(); done(); }, function (e) { err(e.errors || [e.message]); });
      } }] });
    m.root.querySelector('#pf').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); m.root.querySelector('.modal__foot .btn--primary').click(); } });
    return finished;
  }

  function clock() { document.getElementById('clock').textContent = F.clock(Date.now()); }

  function boot() {
    var saved = null; try { saved = localStorage.getItem('centinela.theme'); } catch (e) { /* ignorar */ }
    app.applyTheme(saved || 'dark');

    document.querySelector('.nav').addEventListener('click', function (e) {
      var b = e.target.closest('[data-nav]'); if (b) location.hash = '#/' + b.getAttribute('data-nav');
    });
    document.getElementById('btn-theme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      app.applyTheme(next);
      NOC.data.saveSettings({ theme: next }).catch(function () { /* queda local */ });
    });
    document.getElementById('demo-banner').addEventListener('click', function (e) {
      if (e.target.closest('[data-dismiss]')) { this.setAttribute('data-dismissed', '1'); this.hidden = true; }
    });
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-change-pw]')) changePassword();
      if (e.target.closest('[data-logout]')) NOC.auth.logout();
      if (e.target.closest('[data-resume]') && NOC.sources && NOC.sources.live) NOC.sources.live.resume();
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('[data-resume]')) { e.preventDefault(); NOC.sources.live.resume(); }
    });
    window.addEventListener('hashchange', app.route);
    ['data', 'conn', 'mode', 'targets', 'orgs', 'org'].forEach(function (ev) { bus.on(ev, topbar); });
    bus.on('settings', function (s) { if (s && s.theme) app.applyTheme(s.theme); });
    setInterval(clock, 1000); clock();

    start();
  }

  // Carga de datos (con "Reintentar" si el servidor real falla) y montaje de las vistas.
  function start() {
    var boot = document.getElementById('boot');
    boot.hidden = false;
    boot.innerHTML = '<span class="spin"></span><span>Cargando panel…</span>';
    NOC.data.init().then(function () {
      return mountViews().catch(function (e) {
        console.error(e);
        boot.innerHTML = '<div class="empty"><b>No se pudo iniciar el panel</b><span>' + U.esc(e.message || e) + '</span></div>';
      });
    }, function (e) {
      if (e && e.status === 401) return; // el inicio de sesión se encarga y recarga la página
      console.error(e);
      boot.hidden = false;
      boot.innerHTML = '<div class="empty" role="alert"><b>No se pudo cargar el panel</b><span>' + U.esc((e && e.message) || e) + '</span>' +
        '<button type="button" class="btn btn--primary" data-retry>Reintentar</button></div>';
      boot.querySelector('[data-retry]').addEventListener('click', start);
    });
  }

  function mountViews() {
    return Promise.resolve().then(function () {
      if (store.state.settings.theme) app.applyTheme(store.state.settings.theme);
      return NOC.views.dashboard.mount(document.getElementById('view-panel'));
    }).then(function () {
      NOC.views.orgs.mount(document.getElementById('orgbar'));
      NOC.views.users.mount(document.getElementById('view-usuarios'));
      userBox();
      NOC.views.targets.mount(document.getElementById('view-objetivos'));
      topbar(); app.route();
      document.getElementById('boot').remove();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window.NOC = window.NOC || {});
