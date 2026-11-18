/*
 * Estado único de la aplicación: objetivos, último resultado, historial, eventos, configuración.
 * Las fuentes de datos (servidor real o demostración) solo alimentan este almacén;
 * los widgets solo lo leen. Así ninguna ventana depende de cómo llegan los datos.
 */
(function (NOC) {
  'use strict';
  var U = NOC.util, E = NOC.Evaluate, bus = NOC.bus;

  var state = {
    mode: 'boot',            // boot | live | demo
    connected: false,
    paused: false,           // flujo en vivo expulsado por el tope: en pausa hasta reconectar
    server: null,            // info de /api/health
    targets: [],
    results: {},             // id -> último resultado completo
    history: {},             // id -> [puntos compactos]
    events: [],              // alertas de TODAS las organizaciones (cada una trae org/orgName/orgColor)
    orgs: [],                // [{id,name,color,note,targets}]
    orgId: 'default',        // organización activa (la que muestra el panel)
    statuses: {},            // id -> {o: orgId, s: estado, e: activo}  (todas las organizaciones)
    since: {},               // id -> ts del último cambio de estado
    settings: U.clone(NOC.Defaults.SETTINGS),
    focusId: null,
    lastTick: 0
  };

  var emitTimer = null;
  function scheduleData() {
    if (emitTimer) return;
    emitTimer = setTimeout(function () { emitTimer = null; state.lastTick = Date.now(); bus.emit('data'); }, 250);
  }

  function computeSince(id) {
    var h = state.history[id] || [];
    if (!h.length) { delete state.since[id]; return; }
    var cur = h[h.length - 1].s, i = h.length - 1;
    while (i > 0 && h[i - 1].s === cur) i--;
    state.since[id] = h[i].t;
  }

  var S = NOC.store = {
    state: state,

    setMode: function (mode) { state.mode = mode; bus.emit('mode', mode); },
    setPaused: function (v) { v = !!v; if (state.paused !== v) { state.paused = v; bus.emit('conn', state.connected); } },
    setConnected: function (v) { if (state.connected !== v) { state.connected = v; bus.emit('conn', v); } },
    setServer: function (info) { state.server = info; },

    getTarget: function (id) { return state.targets.filter(function (t) { return t.id === id; })[0] || null; },
    targets: function (filter) { return filter ? state.targets.filter(filter) : state.targets.slice(); },

    setTargets: function (list) {
      state.targets = list;
      var ids = {};
      list.forEach(function (t) { ids[t.id] = true; });
      Object.keys(state.results).forEach(function (id) { if (!ids[id]) { delete state.results[id]; delete state.history[id]; delete state.since[id]; } });
      if (state.focusId && !ids[state.focusId]) state.focusId = null;
      // Estados compactos de esta organización (las demás las actualiza el servidor o la demo).
      Object.keys(state.statuses).forEach(function (id) { if (state.statuses[id].o === state.orgId && !ids[id]) delete state.statuses[id]; });
      list.forEach(function (t) {
        var r = state.results[t.id];
        state.statuses[t.id] = { o: state.orgId, s: r ? r.status : 'unknown', e: !!t.enabled };
      });
      bus.emit('targets', list);
      scheduleData();
    },

    setSettings: function (s) { state.settings = s; bus.emit('settings', s); scheduleData(); },

    /* Carga completa inicial (desde /api/state). */
    ingestState: function (s) {
      state.orgId = s.org || state.orgId;
      if (s.orgs) state.orgs = s.orgs;
      if (s.statuses) state.statuses = s.statuses;
      state.focusId = null;
      state.targets = s.targets || [];
      state.settings = s.settings || state.settings;
      state.results = s.results || {};
      state.history = s.history || {};
      state.events = s.events || [];
      state.since = {};
      Object.keys(state.history).forEach(computeSince);
      bus.emit('orgs', state.orgs);
      bus.emit('targets', state.targets);
      bus.emit('settings', state.settings);
      scheduleData();
    },

    /* ---- organizaciones ---- */
    setOrgs: function (list, statuses) {
      state.orgs = list || [];
      if (statuses) state.statuses = statuses;
      // Si la organización activa desapareció, el que llama decide a cuál pasar (ver NOC.data).
      bus.emit('orgs', state.orgs);
      scheduleData();
    },
    setStatuses: function (statuses) { if (statuses) { state.statuses = statuses; scheduleData(); } },
    org: function (id) { return state.orgs.filter(function (o) { return o.id === id; })[0] || null; },
    // Conteo por estado de una organización (sale de los estados compactos, así cubre también las que no se están viendo).
    orgSummary: function (orgId) {
      var c = { total: 0, up: 0, degraded: 0, down: 0, unknown: 0, paused: 0 };
      Object.keys(state.statuses).forEach(function (id) {
        var x = state.statuses[id];
        if (orgId && x.o !== orgId) return;
        if (!x.e) { c.paused++; return; }
        c.total++; c[x.s] = (c[x.s] || 0) + 1;
      });
      return c;
    },

    ingestResult: function (r) {
      var id = r.id, prev = state.results[id];
      var ro = r.org || state.orgId;
      state.statuses[id] = { o: ro, s: r.status, e: true };
      if (ro !== state.orgId) { scheduleData(); return; } // otra organización: solo cuenta para indicadores y alertas
      state.results[id] = r;
      var h = state.history[id] = state.history[id] || [];
      h.push(E.toPoint(r));
      var max = state.settings.historyPoints || 360;
      if (h.length > max) h.splice(0, h.length - max);
      if (!prev || prev.status !== r.status || !state.since[id]) state.since[id] = r.ts;
      scheduleData();
    },

    ingestEvent: function (e) {
      state.events.unshift(e);
      if (state.events.length > 300) state.events.length = 300;
      bus.emit('event', e);
      scheduleData();
    },

    setFocus: function (id) {
      if (state.focusId === id) return;
      state.focusId = id;
      bus.emit('focus', id);
    },

    /* ---- consultas ---- */
    result: function (id) { return state.results[id] || null; },
    // 'paused' solo existe en la interfaz: un objetivo deshabilitado no se mide.
    statusOf: function (t) {
      if (!t.enabled) return 'paused';
      var r = state.results[t.id];
      return r ? r.status : 'unknown';
    },
    series: function (id, n) {
      var h = state.history[id] || [];
      return n && h.length > n ? h.slice(h.length - n) : h;
    },
    availability: function (id) {
      var h = state.history[id] || [], ok = 0, tot = 0;
      h.forEach(function (p) { if (p.s === 'unknown') return; tot++; if (p.s !== 'down') ok++; });
      return tot ? ok / tot * 100 : null;
    },
    summary: function () {
      var c = { total: 0, up: 0, degraded: 0, down: 0, unknown: 0, paused: 0, avgLatency: null, availability: null };
      var latSum = 0, latN = 0, avSum = 0, avN = 0;
      state.targets.forEach(function (t) {
        var st = S.statusOf(t);
        if (st === 'paused') { c.paused++; return; }
        c.total++; c[st]++;
        var r = state.results[t.id];
        if (r && r.ping && U.isNum(r.ping.avg)) { latSum += r.ping.avg; latN++; }
        var a = S.availability(t.id);
        if (a != null) { avSum += a; avN++; }
      });
      if (latN) c.avgLatency = latSum / latN;
      if (avN) c.availability = avSum / avN;
      return c;
    },
    groups: function () {
      var g = {};
      state.targets.forEach(function (t) { if (t.group) g[t.group] = true; });
      return Object.keys(g).sort();
    }
  };
})(window.NOC = window.NOC || {});
