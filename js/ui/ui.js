/* Utilidades de interfaz: íconos, insignias de estado, tooltip, avisos y modales. */
(function (NOC) {
  'use strict';
  var U = NOC.util, E = NOC.Evaluate;

  var P = {
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
    shield: '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    disk: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    max: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    min: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
    'alert': '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
    'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
    'help': '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4M12 17h.01"/>',
    pause: '<circle cx="12" cy="12" r="10"/><path d="M10 9v6M14 9v6"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12A9 9 0 0 1 18.5 5.8L21 8M21 3v5h-5M3 21v-5h5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M3.3 17a10 10 0 1 1 17.4 0"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    flask: '<path d="M9 2h6M10 2v6L4 19a2 2 0 0 0 1.8 3h12.4A2 2 0 0 0 20 19l-6-11V2"/>',
    ruler: '<path d="M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2"/>',
    network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-4h14v4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 4.2a4 4 0 0 1 0 7.6M22 21v-1a6 6 0 0 0-4-5.6"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'
  };
  var STATUS_ICON = { up: 'check-circle', degraded: 'alert', down: 'x-circle', unknown: 'help', paused: 'pause' };
  var STATUS_TEXT = { up: 'UP', degraded: 'DEGRADADO', down: 'DOWN', unknown: 'SIN DATOS', paused: 'PAUSADO' };
  var STATUS_WORD = { up: 'Arriba', degraded: 'Degradado', down: 'Abajo', unknown: 'Sin datos', paused: 'Pausado' };

  var ui = NOC.ui = {
    icon: function (name, cls) {
      return '<svg class="ico ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || P.help) + '</svg>';
    },
    // Insignia UP / DEGRADADO / DOWN: siempre ícono + texto, nunca solo color.
    status: function (st, opts) {
      opts = opts || {};
      var text = opts.word ? STATUS_WORD[st] : STATUS_TEXT[st];
      if (opts.word && opts.both) text = STATUS_TEXT[st] + ' · ' + STATUS_WORD[st];
      return '<span class="status status--' + st + '" title="' + U.esc(STATUS_WORD[st]) + '">' + ui.icon(STATUS_ICON[st]) + U.esc(text || st) + '</span>';
    },
    statusIcon: function (st, cls) { return ui.icon(STATUS_ICON[st], cls); },
    statusWord: function (st) { return STATUS_WORD[st] || st; },
    statusText: function (st) { return STATUS_TEXT[st] || st; },
    iconNames: function () { return Object.keys(P); },

    // ---- Tooltip global (position: fixed, sigue al ratón) ----
    tip: {
      el: null,
      show: function (html, ev) {
        if (!ui.tip.el) { ui.tip.el = document.createElement('div'); ui.tip.el.className = 'tip'; document.body.appendChild(ui.tip.el); }
        var t = ui.tip.el; t.innerHTML = html; t.style.display = 'block';
        var x = ev.clientX + 14, y = ev.clientY + 14, w = t.offsetWidth, h = t.offsetHeight;
        if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
        if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
        t.style.left = Math.max(4, x) + 'px'; t.style.top = Math.max(4, y) + 'px';
      },
      hide: function () { if (ui.tip.el) ui.tip.el.style.display = 'none'; }
    },

    toast: function (msg, kind, ms) {
      var box = document.getElementById('toasts');
      if (!box) return;
      var t = document.createElement('div');
      t.className = 'toast ' + (kind || ''); t.setAttribute('role', 'status'); t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.remove(); }, ms || 3800);
    },

    /*
     * Modal accesible. opts: { title, body (HTML), wide, persistent (sin X, Escape ni clic fuera: solo se cierra con sus acciones), actions:[{label, kind, onClick(close)}], onOpen(root, close) }
     * Devuelve { close, root }. Escape y clic fuera lo cierran.
     */
    modal: function (opts) {
      var prevFocus = document.activeElement;
      var back = document.createElement('div');
      back.className = 'modal-back';
      var acts = (opts.actions || []).map(function (a, i) {
        return '<button type="button" class="btn ' + (a.kind ? 'btn--' + a.kind : '') + '" data-act="' + i + '">' + U.esc(a.label) + '</button>';
      }).join('');
      back.innerHTML = '<div class="modal ' + (opts.wide ? 'modal--wide' : '') + '" role="dialog" aria-modal="true" aria-label="' + U.esc(opts.title) + '">' +
        '<div class="modal__head"><h2>' + U.esc(opts.title) + '</h2>' + (opts.persistent ? '' : '<button type="button" class="icon-btn" data-close aria-label="Cerrar">' + ui.icon('x') + '</button>') + '</div>' +
        '<div class="modal__body">' + (opts.body || '') + '</div>' +
        (acts ? '<div class="modal__foot">' + acts + '</div>' : '') + '</div>';
      document.body.appendChild(back);
      function close() {
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* elemento ya no existe */ } }
      }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); if (!opts.persistent) close(); } }
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('mousedown', function (e) { if (e.target === back && !opts.persistent) close(); });
      back.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) return close();
        var b = e.target.closest('[data-act]');
        if (b) { var a = opts.actions[+b.getAttribute('data-act')]; if (a && a.onClick) a.onClick(close, back); }
      });
      var first = back.querySelector('input:not([type=hidden]), select, textarea') || back.querySelector('.modal__foot .btn--primary') || back.querySelector('[data-close]') || back.querySelector('.modal__foot .btn');
      if (first) first.focus();
      if (opts.onOpen) opts.onOpen(back, close);
      return { close: close, root: back };
    },

    confirm: function (title, message, okLabel, onOk, danger) {
      ui.modal({ title: title, body: '<p>' + message + '</p>',
        actions: [{ label: 'Cancelar' }, { label: okLabel || 'Aceptar', kind: danger ? 'danger' : 'primary', onClick: function (close) { close(); onOk(); } }] });
    },

    download: function (filename, text, mime) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime || 'application/json' }));
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }
  };

  // Sombras de estado para colores en SVG
  ui.colorOf = function (st) { return 'var(--' + (st === 'paused' ? 'unknown' : st) + ')'; };
})(window.NOC = window.NOC || {});
