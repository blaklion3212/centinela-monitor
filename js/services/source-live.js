/* Fuente de datos real: habla con server/server.js por API REST y recibe resultados en vivo por SSE. */
(function (NOC) {
  'use strict';
  var store = NOC.store;
  var es = null, wasDown = false, retryTimer = null, retryN = 0;
  // Pausa por expulsión (tope de flujos): no se reintenta sola; se sale por clic o al volver a ver la pestaña.
  var paused = false, autoResume = false, visHooked = false;

  // Texto de respaldo cuando el servidor no manda mensaje (429 y 421 normalmente sí lo mandan).
  var HTTP_TEXT = { 421: 'Host no permitido por el servidor.', 429: 'Demasiadas peticiones o intentos. Espera un momento.' };

  function req(method, url, body) {
    var opts = { method: method, cache: 'no-store', credentials: 'same-origin', headers: {} };
    // Toda escritura (incluido DELETE) lleva Content-Type JSON: es la defensa CSRF del servidor.
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; if (body !== undefined) opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (r.status === 401 && NOC.auth) NOC.auth.onUnauthorized(); // sesión vencida: pide iniciar sesión de nuevo
        if (!r.ok) {
          var err = new Error((j && (j.error || (j.errors && j.errors[0]))) || HTTP_TEXT[r.status] || ('Error HTTP ' + r.status));
          err.status = r.status;
          err.errors = (j && j.errors) || [err.message];
          // 403 con mustChange: hay que cambiar la contraseña por defecto antes de seguir.
          if (r.status === 403 && j && j.mustChange) { err.mustChange = true; if (NOC.auth) NOC.auth.requireChange(); }
          throw err;
        }
        return j;
      });
    });
  }

  function q(orgId) { return '?org=' + encodeURIComponent(orgId || store.state.orgId); }

  // Pide el estado de una organización y lo devuelve; quien llama decide si lo ingiere (evita carreras al cambiar de organización).
  function fetchState(orgId) {
    return req('GET', '/api/state' + q(orgId));
  }
  // Recarga la organización actual (tras reconectar), solo si no cambió mientras se pedía.
  function reload() {
    var org = store.state.orgId;
    return fetchState(org).then(function (s) { if (org === store.state.orgId) store.ingestState(s); });
  }

  // Espera exponencial con algo de aleatoriedad: 1 s, 2 s, 4 s... hasta 30 s como máximo.
  function retryDelay() {
    var base = Math.min(30000, 1000 * Math.pow(2, Math.min(retryN, 5)));
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }
  // El flujo quedó cerrado: si la sesión sigue válida se reabre; si no, flujo de login como siempre.
  function scheduleRetry() {
    if (retryTimer || paused) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (paused) return;
      if (!NOC.auth) { retryN++; stream(); return; }
      NOC.auth.verify().then(function (ok) {
        if (!ok) { NOC.auth.onUnauthorized(); return; }
        retryN++; stream();
      }, function () { retryN++; scheduleRetry(); }); // servidor inalcanzable: se vuelve a intentar
    }, retryDelay());
  }

  // El servidor expulsó este flujo (otra pestaña lo desplazó): se cierra, se cancelan reintentos y se queda en pausa.
  function pause() {
    if (es) { es.close(); es = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryN = 0; wasDown = true;
    paused = true;
    // Con la pestaña visible se espera un clic (evita ciclos entre dos pestañas visibles); oculta, se recupera al volver a verla.
    autoResume = !!document.hidden;
    store.setPaused(true); store.setConnected(false);
    hookVisibility();
  }
  // Reconecta tras una pausa: flujo normal (onopen recarga el estado porque wasDown es true).
  function resume() {
    if (!paused) return;
    paused = false; autoResume = false;
    store.setPaused(false);
    stream();
  }
  // Un único listener global (no se duplica aunque haya varias pausas).
  function hookVisibility() {
    if (visHooked) return;
    visHooked = true;
    document.addEventListener('visibilitychange', function () {
      if (!paused) return;
      if (document.hidden) autoResume = true;          // al ocultarse, ya puede recuperar el vivo al volver
      else if (autoResume) resume();
    });
  }

  function stream() {
    if (paused) return; // un flujo en pausa solo se reabre con resume()
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (es) es.close();
    es = new EventSource('/api/stream');
    es.addEventListener('result', function (e) { store.ingestResult(JSON.parse(e.data)); });
    es.addEventListener('event', function (e) { store.ingestEvent(JSON.parse(e.data)); });
    es.addEventListener('targets', function (e) {
      var j = JSON.parse(e.data);
      if (j.org === store.state.orgId) store.setTargets(j.targets);
      if (j.orgs) store.setOrgs(j.orgs, j.statuses); else store.setStatuses(j.statuses);
    });
    es.addEventListener('orgs', function (e) {
      var j = JSON.parse(e.data);
      store.setOrgs(j.orgs, j.statuses);
      // Si la organización que se está viendo fue eliminada, se vuelve al host.
      if (!store.org(store.state.orgId) && NOC.data) NOC.data.switchOrg('default').catch(function (er) { if (NOC.ui) NOC.ui.toast(er.message, 'err'); });
    });
    es.addEventListener('settings', function (e) { store.setSettings(JSON.parse(e.data)); });
    es.addEventListener('evicted', pause);
    es.onopen = function () {
      if (wasDown) reload().catch(function () {});
      wasDown = false; retryN = 0;
      store.setConnected(true);
    };
    es.onerror = function () {
      if (paused) return;
      wasDown = true; store.setConnected(false);
      // Flujo cerrado (401, tope de flujos, 429...): el navegador no reintenta solo; se reabre con espera exponencial.
      if (es.readyState === 2) scheduleRetry();
    };
  }

  NOC.sources = NOC.sources || {};
  NOC.sources.live = {
    name: 'live',
    resume: resume,

    probe: function () {
      if (location.protocol === 'file:') return Promise.resolve(false);
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var to = setTimeout(function () { if (ctl) ctl.abort(); }, 2000);
      return fetch('/api/health', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
        // 421/429/5xx: el servidor sí responde (rechaza el host o falla); no es "sin servidor", el error se mostrará al cargar.
        .then(function (r) { if (r.status === 421 || r.status === 429 || r.status >= 500) return { ok: true, blocked: true }; return r.ok ? r.json() : null; })
        .then(function (j) { clearTimeout(to); if (j && j.ok) { if (!j.blocked) store.setServer(j); return true; } return false; })
        .catch(function () { clearTimeout(to); return false; });
    },

    start: function (orgId) {
      return fetchState(orgId).catch(function (e) {
        if (orgId && orgId !== 'default' && (e.status === 400 || e.status === 404)) return fetchState('default'); // la organización guardada ya no existe
        throw e;
      }).then(function (s) { store.ingestState(s); store.setConnected(true); if (!paused) stream(); });
    },
    // Devuelve el estado de la organización sin ingerirlo: data.js decide si sigue vigente.
    switchOrg: function (orgId) { return fetchState(orgId); },
    createOrg: function (o) { return req('POST', '/api/orgs', o).then(function (j) { return j.org; }); },
    updateOrg: function (id, o) { return req('PUT', '/api/orgs/' + encodeURIComponent(id), o).then(function (j) { return j.org; }); },
    removeOrg: function (id) { return req('DELETE', '/api/orgs/' + encodeURIComponent(id)); },

    createTarget: function (t) { return req('POST', '/api/targets' + q(), t).then(function (j) { return j.target; }); },
    updateTarget: function (id, t) { return req('PUT', '/api/targets/' + encodeURIComponent(id), t).then(function (j) { return j.target; }); },
    removeTarget: function (id) { return req('DELETE', '/api/targets/' + encodeURIComponent(id)); },
    replaceTargets: function (list) { return req('PUT', '/api/targets' + q(), { targets: list }).then(function (j) { return j.targets; }); },
    checkNow: function (id) { return req('POST', '/api/targets/' + encodeURIComponent(id) + '/check', {}); },
    saveSettings: function (s) { return req('PUT', '/api/settings', s); },
    loadLayout: function (orgId) { return req('GET', '/api/layout' + q(orgId)).then(function (j) { return j.layout; }); },
    saveLayout: function (l, orgId) { return req('PUT', '/api/layout' + q(orgId), l); },
    traceroute: function (opts) { return req('POST', '/api/traceroute', opts); }
  };
})(window.NOC = window.NOC || {});
