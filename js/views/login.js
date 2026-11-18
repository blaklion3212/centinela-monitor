/* Pantalla de inicio de sesión (cubre toda la ventana hasta que el servidor acepte las credenciales). */
(function (NOC) {
  'use strict';
  var U = NOC.util, ui = NOC.ui;

  NOC.views = NOC.views || {};
  NOC.views.login = {
    // Resuelve cuando el usuario inicia sesión correctamente.
    show: function (notice) {
      return new Promise(function (resolve) {
        var old = document.getElementById('login'); if (old) old.remove();
        var el = document.createElement('div');
        el.id = 'login'; el.className = 'login-back';
        el.innerHTML =
          '<form class="login-card" novalidate autocomplete="on">' +
            '<div class="login-brand"><img src="assets/img/logo.svg" alt="" width="34" height="34"><div>Centinela<small>Monitoreo de servicios</small></div></div>' +
            (notice ? '<div class="login-note" role="status">' + U.esc(notice) + '</div>' : '') +
            '<div class="field"><label for="lg-user">Usuario</label><input id="lg-user" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="32" required></div>' +
            '<div class="field"><label for="lg-pass">Contraseña</label><input id="lg-pass" name="password" type="password" autocomplete="current-password" maxlength="200" required></div>' +
            '<div class="login-err" role="alert" aria-live="assertive" hidden></div>' +
            '<button type="submit" class="btn btn--primary login-go">Entrar</button>' +
          '</form>';
        document.body.appendChild(el);
        var boot = document.getElementById('boot'); if (boot) boot.hidden = true;
        var form = el.querySelector('form'), err = el.querySelector('.login-err'), btn = el.querySelector('.login-go');
        el.querySelector('#lg-user').focus();
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var u = el.querySelector('#lg-user').value, p = el.querySelector('#lg-pass').value;
          if (!u || !p) { err.hidden = false; err.textContent = 'Escribe tu usuario y contraseña.'; return; }
          btn.disabled = true; err.hidden = true;
          NOC.auth.login(u, p).then(function () {
            // Confirma la sesión antes de cerrar el formulario; si falla, se muestra el error en lugar de quedarse colgado.
            return NOC.auth.check().then(function (ok) {
              if (!ok) throw new Error('No se pudo verificar la sesión. Intenta iniciar sesión de nuevo.');
              el.remove();
              if (boot) boot.hidden = false;
              resolve();
            });
          }).catch(function (ex) {
            btn.disabled = false; err.hidden = false; err.textContent = ex.message;
            el.querySelector('#lg-pass').value = ''; el.querySelector('#lg-pass').focus();
          });
        });
      });
    }
  };
})(window.NOC = window.NOC || {});
