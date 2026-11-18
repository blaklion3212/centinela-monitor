/*
 * Fachada de datos: las vistas y widgets llaman a NOC.data.* sin saber si hay servidor real o demostración.
 * Al iniciar prueba /api/health; si responde usa el servidor, si no (o en file:) usa el modo demostración.
 */
(function (NOC) {
  'use strict';
  var store = NOC.store;
  var LAYOUT_KEY = 'centinela.layout.v1';
  var ORG_KEY = 'centinela.org';
  var switchSeq = 0;

  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }

  function layoutKey(orgId) { return orgId && orgId !== 'default' ? LAYOUT_KEY + '.' + orgId : LAYOUT_KEY; }
  function savedOrg() { try { return localStorage.getItem(ORG_KEY) || 'default'; } catch (e) { return 'default'; } }
  function rememberOrg(id) { try { localStorage.setItem(ORG_KEY, id); } catch (e) { /* sin almacenamiento */ } }

  var D = NOC.data = {
    source: null,

    // Con servidor real: sesión + estado. Un error del servidor NO cae a demostración: se propaga para mostrar "Reintentar".
    // La demostración queda solo para file: o cuando /api/health no responde.
    init: function () {
      return NOC.sources.live.probe().then(function (ok) {
        D.source = ok ? NOC.sources.live : NOC.sources.demo;
        store.setMode(ok ? 'live' : 'demo');
        if (!ok) return D.source.start(savedOrg());
        function loadLive() {
          return NOC.auth.ensure().then(function () { return D.source.start(savedOrg()); }).catch(function (e) {
            // Contraseña por defecto: se espera a que la cambie y se reintenta la carga.
            if (e && e.mustChange) return NOC.auth.requireChange().then(loadLive);
            throw e;
          });
        }
        return loadLive();
      });
    },

    isDemo: function () { return store.state.mode === 'demo'; },

    /* ---- organizaciones ---- */
    // Cambia la organización que se ve. Las demás siguen midiéndose y sus alertas siguen llegando.
    switchOrg: function (id) {
      if (id === store.state.orgId) { switchSeq++; return Promise.resolve(); } // también anula un cambio pendiente a otra organización
      var seq = ++switchSeq;
      return D.source.switchOrg(id).then(function (st) {
        if (seq !== switchSeq) return; // llegó otra petición después: esta respuesta ya no vale
        if (st) store.ingestState(st); // la demostración ya ingiere por su cuenta y no devuelve estado
        rememberOrg(store.state.orgId);
        NOC.bus.emit('org', store.state.orgId);
      });
    },
    createOrg: function (o) { return D.source.createOrg(o); },
    updateOrg: function (id, o) { return D.source.updateOrg(id, o); },
    removeOrg: function (id) { return D.source.removeOrg(id); },

    createTarget: function (t) { return D.source.createTarget(t); },
    updateTarget: function (id, t) { return D.source.updateTarget(id, t); },
    removeTarget: function (id) { return D.source.removeTarget(id); },
    replaceTargets: function (list) { return D.source.replaceTargets(list); },
    checkNow: function (id) { return D.source.checkNow(id); },
    traceroute: function (opts) { return D.source.traceroute(opts); },

    saveSettings: function (s) { return D.source.saveSettings(s); },

    // La disposición de ventanas es propia de cada organización.
    loadLayout: function (orgId) {
      orgId = orgId || store.state.orgId;
      return D.source.loadLayout(orgId).then(function (l) { return l || lsGet(layoutKey(orgId)); }, function () { return lsGet(layoutKey(orgId)); });
    },
    saveLayout: function (l, orgId) {
      orgId = orgId || store.state.orgId;
      lsSet(layoutKey(orgId), l);
      return D.source.saveLayout(l, orgId).catch(function () { /* queda la copia local */ });
    }
  };
})(window.NOC = window.NOC || {});
