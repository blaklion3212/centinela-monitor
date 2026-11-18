/*
 * Sesión del usuario (solo con servidor real; en modo demostración no hay inicio de sesión).
 * La cookie de sesión es HttpOnly: el navegador la envía solo; aquí solo se consulta quién es el usuario y su rol.
 */
(function (NOC) {
  'use strict';
  var store = NOC.store;
  var asking = false, pwPending = null;
  var HTTP_TEXT = { 421: 'Host no permitido por el servidor.', 429: 'Demasiados intentos o peticiones. Espera un momento.' };

  function call(method, url, body) {
    var opts = { method: method, cache: 'no-store', credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) {
          var err = new Error((j && (j.error || (j.errors && j.errors[0]))) || HTTP_TEXT[r.status] || ('Error HTTP ' + r.status));
          err.status = r.status; err.errors = (j && j.errors) || [err.message];
          // 403 con mustChange: contraseña temporal, hay que cambiarla (excepto en las propias rutas de sesión).
          if (r.status === 403 && j && j.mustChange) {
            err.mustChange = true;
            if (!/^\/api\/auth\/(password|logout|login)$/.test(url)) A.requireChange();
          }
          throw err;
        }
        return j;
      });
    });
  }

  var A = NOC.auth = {
    user: null,
    authEnabled: false,

    // Roles: admin (todo) · operator (edita) · viewer (solo lectura). Sin servidor (demostración) se permite todo.
    role: function () { return A.user ? A.user.role : 'admin'; },
    can: function (what) {
      var r = A.role();
      if (what === 'users') return r === 'admin';
      if (what === 'write') return r === 'admin' || r === 'operator';
      return true;
    },

    // Consulta la sesión. Resuelve true si hay sesión (o la autenticación está desactivada) y false si hay que iniciar sesión.
    check: function () {
      return call('GET', '/api/auth/me').then(function (j) {
        A.user = j.user; A.authEnabled = !!j.authEnabled;
        store.setServer(Object.assign({}, store.state.server || {}, j.server || {}));
        A.applyRole();
        return true;
      }, function (e) { if (e.status === 401) return false; throw e; });
    },

    // Garantiza una sesión antes de cargar datos: si no la hay, muestra el inicio de sesión.
    ensure: function () {
      return A.check().then(function (ok) { return ok ? null : NOC.views.login.show(); }).then(function () {
        return A.user && A.user.mustChange ? A.requireChange() : null;
      });
    },

    // Modal NO descartable para cambiar la contraseña temporal. Resuelve al lograrlo; comparte una sola ventana si se pide varias veces.
    requireChange: function () {
      if (pwPending) return pwPending;
      pwPending = NOC.app.changePassword({ forced: true }).then(function () {
        pwPending = null;
        if (A.user) A.user.mustChange = false;
      });
      return pwPending;
    },

    login: function (username, password) {
      return call('POST', '/api/auth/login', { username: username, password: password }).then(function (j) { A.user = j.user; return j.user; });
    },
    logout: function () {
      return call('POST', '/api/auth/logout', {}).catch(function () { /* ya sin sesión */ }).then(function () { location.reload(); });
    },
    changePassword: function (current, next) { return call('POST', '/api/auth/password', { current: current, next: next }).then(function (j) { A.user = j.user; return j.user; }); },

    // Ventanas y controles de edición se ocultan para el rol de solo lectura (el servidor también lo impide).
    applyRole: function () {
      var cl = document.body.classList;
      cl.toggle('role-viewer', A.user != null && A.user.role === 'viewer');
      cl.toggle('role-admin', A.can('users') && A.authEnabled);
    },

    // El servidor respondió 401 (sesión vencida, cerrada desde otro lugar o usuario deshabilitado).
    onUnauthorized: function () {
      if (asking) return;
      asking = true;
      NOC.views.login.show('Tu sesión terminó. Inicia sesión de nuevo.').then(function () { location.reload(); });
    },
    // Tras caerse el flujo en vivo: ¿sigue vigente la sesión?
    // Si la sesión exige cambiar la contraseña (mustChange), abre el modal obligatorio y resuelve true solo al completarlo (H-1).
    verify: function () {
      return call('GET', '/api/auth/me').then(function (j) {
        if (j && j.user) { A.user = j.user; if (typeof j.authEnabled === 'boolean') A.authEnabled = j.authEnabled; A.applyRole(); }
        if (j && j.user && j.user.mustChange) return A.requireChange().then(function () { return true; });
        return true;
      }, function (e) { return e.status === 401 ? false : true; });
    }
  };
})(window.NOC = window.NOC || {});
