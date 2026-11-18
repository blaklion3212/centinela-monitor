/* Vista Ajustes: tema, intervalos, umbrales de alerta, datos y ayuda de instalación. */
(function (NOC) {
  'use strict';
  var U = NOC.util, ui = NOC.ui, store = NOC.store;

  var T = NOC.Thresholds; // pares aviso/crítico y su orden, compartidos con el servidor (js/shared/thresholds.js)
  // Filas del formulario: [id del campo, etiqueta con unidad, clave de aviso, clave crítica, par de umbrales (objeto de PAIRS)].
  // Las claves y el orden salen del módulo compartido; aquí solo viven los textos con unidad y el id del campo en el DOM.
  var UI_LABELS = { latency: ['latency', 'Latencia (ms)'], loss: ['loss', 'Pérdida de paquetes (%)'], jitter: ['jitter', 'Jitter (ms)'],
                    ttfb: ['ttfb', 'TTFB HTTP (ms)'], ssl: ['ssl', 'SSL: días restantes (menor = peor)'], disk: ['disk', 'Disco usado (%)'],
                    cpu: ['cpu', 'CPU (%)'], mem: ['mem', 'Memoria RAM (%)'], ioWait: ['io', 'I/O wait (%)'] };
  // Si a PAIRS le falta una etiqueta aquí, se usa p.label de respaldo en vez de fallar.
  var TH = T.PAIRS.map(function (p) { var l = UI_LABELS[p.id]; return [l ? l[0] : p.id, l ? l[1] : (p.label || p.id), p.warn, p.crit, p]; });

  function render(root) {
    var s = store.state.settings, th = s.thresholds, live = store.state.mode === 'live', sv = store.state.server;
    root.innerHTML = '<div class="toolbar"><div><h1 class="page-title">Ajustes</h1><div class="page-sub">Umbrales que deciden cuándo un servicio pasa a DEGRADADO o DOWN.</div></div></div>' +
      '<div class="settings-grid">' +
      '<div class="panel"><div class="panel-head"><h2>General</h2></div><div class="panel-body"><form id="sf" novalidate><div data-errors></div>' +
        '<div class="field"><span class="lbl">Tema</span><div class="seg" role="group" aria-label="Tema"><button type="button" data-theme="dark" aria-pressed="' + (s.theme !== 'light') + '">Oscuro</button><button type="button" data-theme="light" aria-pressed="' + (s.theme === 'light') + '">Claro</button></div></div>' +
        '<div class="row c2"><div class="field"><label for="s-int">Intervalo por defecto (s)</label><input id="s-int" type="number" min="2" max="3600" value="' + s.intervalSec + '"><span class="hint">Para objetivos nuevos.</span></div>' +
        '<div class="field"><label for="s-hist">Puntos de historial</label><input id="s-hist" type="number" min="30" max="2000" value="' + s.historyPoints + '"><span class="hint">Por objetivo, en memoria.</span></div></div>' +
        '<h3 class="sec-title">Umbrales de alerta</h3><div class="th-grid"><span class="h">Métrica</span><span class="h">Degradado</span><span class="h">Crítico</span>' +
        TH.map(function (r) { return '<label for="th-' + r[0] + 'w">' + r[1] + '</label><input id="th-' + r[0] + 'w" type="number" min="0" step="any" data-k="' + r[2] + '" value="' + th[r[2]] + '"><input id="th-' + r[0] + 'c" type="number" min="0" step="any" data-k="' + r[3] + '" value="' + th[r[3]] + '" aria-label="' + r[1] + ' crítico">'; }).join('') + '</div>' +
        '<div class="toolbar" style="margin:16px 0 0"><button type="submit" class="btn btn--primary">Guardar ajustes</button></div></form></div></div>' +
      '<div style="display:grid;gap:14px;align-content:start">' +
      '<div class="panel"><div class="panel-head"><h2>Conexión</h2></div><div class="panel-body">' + (live
        ? '<p>' + ui.status('up', { word: true }).replace('Arriba', 'En vivo') + '</p><p class="muted" style="margin-top:8px">Servidor de monitoreo en <b>' + U.esc(sv && sv.host || '') + '</b> (' + U.esc(sv && sv.platform || '') + ', Node ' + U.esc(sv && sv.node || '') + '). Las mediciones son reales y los datos se guardan en la carpeta <code>data/</code>.</p>'
        : '<p>' + W2('degraded', 'DEMOSTRACIÓN') + '</p><p class="muted" style="margin-top:8px">Estás viendo datos <b>simulados</b> guardados en este navegador. Para medir de verdad, inicia el servidor y abre la dirección que muestra:</p><p style="margin-top:8px"><code>node server/server.js</code></p><button type="button" class="btn btn--sm" data-reset-demo style="margin-top:10px">Borrar datos de demostración</button>') + '</div></div>' +
      '<div class="panel"><div class="panel-head"><h2>Cómo medir servidores remotos</h2></div><div class="panel-body"><ol class="help-list">' +
        '<li>Copia la carpeta <code>agent/</code> al servidor (solo necesita Node 18+).</li><li>Ejecuta <code>CENTINELA_AGENT_TOKEN=UN_SECRETO_LARGO node agent.js --port 9100 --host IP_DEL_SERVIDOR</code>.</li>' +
        '<li>Opcional, recomendado fuera de la red local: cifra con TLS añadiendo <code>--tls-cert</code> y <code>--tls-key</code>; el agente imprime la huella SHA-256 del certificado al arrancar y, con TLS, esa huella es obligatoria en el objetivo.</li>' +
        '<li>Abre el puerto solo para la IP de este panel.</li><li>Edita el objetivo, activa “Salud del servidor” y pon el mismo puerto y token. Con TLS, marca “Conexión cifrada” y pega la huella (obligatoria); si la cambias después, hay que volver a escribir el token.</li></ol></div></div>' +
      '</div></div>';

    var form = root.querySelector('#sf');
    root.onclick = function (e) {
      var tb = e.target.closest('[data-theme]');
      if (tb) { root.querySelectorAll('[data-theme]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === tb)); }); NOC.app.applyTheme(tb.getAttribute('data-theme')); }
      if (e.target.closest('[data-reset-demo]')) ui.confirm('Borrar datos de demostración', 'Se borran objetivos, ajustes y disposición guardados en este navegador y se recarga la página.', 'Borrar', function () {
        try { Object.keys(localStorage).filter(function (k) { return k.indexOf('centinela.') === 0; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (er) { /* sin almacenamiento */ }
        location.reload();
      }, true);
    };
    if (!NOC.auth.can('write')) form.querySelectorAll('input, button[type=submit]').forEach(function (i) { i.disabled = true; });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var box = form.querySelector('[data-errors]'), errs = [];
      var out = { thresholds: {}, theme: root.querySelector('[data-theme][aria-pressed="true"]').getAttribute('data-theme') };
      // Los campos numéricos vacíos se omiten del envío (el servidor conserva su valor).
      [['#s-int', 'intervalSec'], ['#s-hist', 'historyPoints']].forEach(function (f) {
        var v = form.querySelector(f[0]).value.trim();
        if (v !== '' && isFinite(+v)) out[f[1]] = +v;
      });
      form.querySelectorAll('[data-k]').forEach(function (i) {
        var v = i.value.trim();
        if (v !== '' && isFinite(+v)) out.thresholds[i.getAttribute('data-k')] = +v;
      });
      // El aviso debe ser menos grave que el crítico (en SSL, al revés: más días restantes es menos grave).
      TH.forEach(function (r) {
        var w = out.thresholds[r[2]], c = out.thresholds[r[3]];
        if (w == null || c == null) return;
        if (!T.isOrdered(r[4], w, c)) errs.push(T.orderMessage(r[4], w, c, r[1]));
      });
      if (errs.length) {
        box.innerHTML = '<div class="errors" role="alert"><ul>' + errs.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul></div>';
        return;
      }
      box.innerHTML = '';
      NOC.data.saveSettings(out).then(function () { ui.toast('Ajustes guardados', 'ok'); }, function (er) {
        // El servidor devuelve 400 con la lista de errores de validación: se muestran en el formulario.
        if (er.status === 400 && er.errors && er.errors.length) {
          box.innerHTML = '<div class="errors" role="alert"><ul>' + er.errors.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul></div>';
          return;
        }
        ui.toast(er.message, 'err');
      });
    });
  }
  function W2(kind, text) { return NOC.W.badge(kind, text, 'alert'); }

  NOC.views = NOC.views || {};
  NOC.views.settings = { mount: function (el) { render(el); }, refresh: function (el) { render(el); } };
})(window.NOC = window.NOC || {});
