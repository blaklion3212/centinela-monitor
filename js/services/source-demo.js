/*
 * Modo demostración: se usa cuando no hay servidor (por ejemplo al abrir index.html directamente).
 * Simula mediciones realistas con los mismos campos y la misma lógica de estado que el servidor real,
 * guarda objetivos/ajustes/disposición en localStorage y genera historial previo para que las gráficas no estén vacías.
 */
(function (NOC) {
  'use strict';
  var U = NOC.util, E = NOC.Evaluate, store = NOC.store, Seed = NOC.Seed;
  var LS = 'centinela.demo.';
  var STEP = 3000;        // una muestra cada 3 s en modo demo
  var PREFILL = 120;      // muestras de historial previo
  var K = 0;              // contador de muestras (0 = ahora; negativo = pasado)
  var t0 = 0;
  var timer = null;
  var prevStatus = {};

  function lsGet(k, d) { try { var v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* almacenamiento no disponible */ } }

  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function r1(v) { return Math.round(v * 10) / 10; }
  function fakeIp(seed) {
    var h = hash(seed);
    return (20 + h % 190) + '.' + ((h >>> 8) % 250) + '.' + ((h >>> 16) % 250) + '.' + (1 + (h >>> 24) % 250);
  }
  var PTR = { '8.8.8.8': 'dns.google', '1.1.1.1': 'one.one.one.one', '127.0.0.1': 'localhost' };

  var targets = [];           // objetivos de la organización activa (misma lista que byOrg[activeOrg])
  var byOrg = {};             // orgId -> lista de objetivos (todas las organizaciones se simulan a la vez)
  var orgs = [];              // [{id,name,color,note}]
  var activeOrg = 'default';
  function tkey(orgId) { return orgId === 'default' ? 'targets' : 'targets.' + orgId; }
  function lkey(orgId) { return orgId === 'default' ? 'layout' : 'layout.' + orgId; }
  function orgList() { return orgs.map(function (o) { return Object.assign({}, o, { targets: (byOrg[o.id] || []).length }); }); }
  function orgOfTarget(id) {
    for (var i = 0; i < orgs.length; i++) if ((byOrg[orgs[i].id] || []).some(function (t) { return t.id === id; })) return orgs[i].id;
    return null;
  }
  function setActiveList(list) { targets = list; byOrg[activeOrg] = list; }
  function profileOf(t) { return t.profile || Seed.DEMO_PROFILES[t.id] || 'healthy'; }

  // Línea de tiempo del perfil: ok | lossy | slow | down
  function modeAt(prof, k) {
    if (prof === 'down') return k >= -40 ? 'down' : 'ok';
    if (prof === 'flaky') { var m = ((k % 90) + 90) % 90; return m >= 66 && m < 78 ? 'down' : 'lossy'; }
    if (prof === 'slow') return 'slow';
    return 'ok';
  }

  function genAgent(t, prof, mode, k, h) {
    var ag = t.checks.agent;
    if (mode === 'down') return { error: 'tiempo agotado' };
    var cpu = U.clamp((prof === 'slow' ? 74 : 20 + h % 22) + 12 * Math.sin(k / 9 + h % 7) + rnd(-4, 4) + (prof === 'slow' && ((k % 60) + 60) % 60 < 12 ? 14 : 0), 2, 99);
    var mem = U.clamp(44 + h % 22 + 5 * Math.sin(k / 41) + rnd(-1, 1), 5, 98);
    var io = prof === 'disk-full' ? rnd(8, 30) : (Math.random() < 0.05 ? rnd(12, 24) : rnd(0.5, 5));
    var drift = prof === 'disk-full' ? 92.2 + (k % 50) * 0.004 : null;
    var rx = Math.max(0.2e6, 7e6 + 5e6 * Math.sin(k / 7 + h % 5) + rnd(-1.2e6, 1.2e6));
    return {
      ts: Date.now(), hostname: U.hostOf(t), platform: 'linux', release: '5.15', uptimeSec: 86400 * (6 + h % 40) + (k + PREFILL) * 3,
      cpu: { usagePct: r1(cpu), ioWaitPct: r1(io), cores: 8, load: [r1(cpu / 25), r1(cpu / 28), r1(cpu / 31)] },
      mem: { totalMb: 16384, usedMb: Math.round(16384 * mem / 100), usedPct: r1(mem), swapUsedPct: r1(rnd(0, 6)) },
      disks: [
        { mount: '/', fs: 'ext4', totalGb: 100, usedGb: r1(38 + h % 20), usedPct: r1(38 + h % 20) },
        { mount: prof === 'disk-full' ? '/var/lib/mysql' : '/data', fs: 'xfs', totalGb: 500,
          usedGb: r1(500 * (drift || (48 + h % 12)) / 100), usedPct: r1(drift || (48 + h % 12)) }
      ],
      net: { rxBps: Math.round(rx), txBps: Math.round(rx * rnd(0.3, 0.5)) },
      services: (ag.services || []).map(function (n) { return { name: n, active: true }; })
    };
  }

  function genResult(t, k, ts) {
    var prof = profileOf(t), mode = modeAt(prof, k), c = t.checks, host = U.hostOf(t), h = hash(t.id);
    var lit = U.isIp(host), ip = lit ? host : fakeIp(host);
    var base = 7 + h % 38;
    var r = { id: t.id, ts: ts };
    r.dns = { input: host, literal: lit, resolved: ip, ips: lit ? [ip] : [ip, fakeIp(host + 'b')],
              ms: lit ? null : r1(rnd(6, 28)), ptr: lit ? (PTR[host] || null) : null };

    if (c.ping) {
      var samples = [], i;
      for (i = 0; i < 4; i++) {
        var v;
        if (mode === 'down') v = null;
        else if (mode === 'lossy') v = Math.random() < 0.24 ? null : base * 2 + rnd(5, 70);
        else if (mode === 'slow') v = base + rnd(150, 240);
        else v = base + rnd(0, base * 0.18) + (Math.random() < 0.06 ? rnd(8, 30) : 0);
        samples.push(v == null ? null : r1(v));
      }
      var st = U.stats(samples);
      st.ttl = [64, 117, 118, 56][h % 4];
      st.samples = samples; st.ip = ip;
      r.ping = st;
    }

    if (c.ports && c.ports.length) {
      r.ports = c.ports.map(function (p) {
        return mode === 'down' ? { port: p, open: false, ms: null, error: 'tiempo agotado' }
                               : { port: p, open: true, ms: r1(base * 0.8 + rnd(0, 6)) };
      });
    }

    var isHttps = t.kind === 'url' && /^https:/i.test(t.address);
    if (t.kind === 'url' && c.http) {
      if (mode === 'down') {
        r.http = { status: 503, statusText: 'Service Unavailable', ttfbMs: r1(rnd(30, 70)), totalMs: r1(rnd(40, 90)), bytes: 640, redirects: 0, finalUrl: t.address };
      } else {
        var ttfb = mode === 'slow' ? rnd(1100, 2800) : mode === 'lossy' ? base * 3 + rnd(40, 200) : base * 2 + rnd(30, 140);
        r.http = { status: 200, statusText: 'OK', ttfbMs: r1(ttfb), totalMs: r1(ttfb + rnd(15, 90)), bytes: Math.round(rnd(8, 60) * 1024),
                   redirects: h % 3 === 0 ? 1 : 0, finalUrl: t.address };
      }
    }
    if (c.ssl && isHttps) {
      var days = prof === 'ssl-soon' ? 12 : 45 + h % 220;
      r.ssl = { daysLeft: days, validFrom: new Date(ts - 80 * 86400000).toISOString(), validTo: new Date(ts + days * 86400000).toISOString(),
                subject: host, issuer: ['Let\'s Encrypt', 'DigiCert Inc', 'Sectigo Limited', 'Google Trust Services'][h % 4], protocol: 'TLSv1.3', authorized: true, authError: null };
    }
    if (c.agent && c.agent.enabled) r.agent = genAgent(t, prof, mode, k, h);

    var ev = E.evaluate(t, r, store.state.settings.thresholds);
    r.status = ev.status; r.reasons = ev.reasons;
    return r;
  }

  function eventFor(t, r) {
    var prev = prevStatus[t.id];
    prevStatus[t.id] = r.status;
    var changed = prev ? prev !== r.status : (r.status === 'down' || r.status === 'degraded');
    if (!changed) return null;
    var text = r.status === 'up' ? 'Servicio recuperado'
      : (r.reasons.filter(function (x) { return x.level !== 'info'; }).map(function (x) { return x.text; }).join(' · ') || 'Sin detalle');
    var oid = orgOfTarget(t.id), o = oid ? orgs.filter(function (x) { return x.id === oid; })[0] : null;
    return { id: t.id + '-' + r.ts, ts: r.ts, targetId: t.id, name: t.name, org: oid, orgName: o ? o.name : '', orgColor: o ? o.color : null,
             from: prev || null, to: r.status, text: text };
  }

  function feed(t, r, quiet) {
    r.org = orgOfTarget(t.id) || activeOrg;
    store.ingestResult(r);
    var ev = eventFor(t, r);
    if (ev && !quiet) store.ingestEvent(ev);
  }

  function prefill(t, quiet) {
    delete prevStatus[t.id];
    for (var k = -PREFILL + 1; k <= 0; k++) feed(t, genResult(t, k, t0 + k * STEP), quiet);
  }

  function tick() {
    K++;
    orgs.forEach(function (o) {
      (byOrg[o.id] || []).forEach(function (t) { if (t.enabled) feed(t, genResult(t, K, Date.now())); });
    });
  }

  function persist() { lsSet(tkey(activeOrg), targets); store.setTargets(targets.map(U.clone)); store.setOrgs(orgList()); }
  function persistOrgs() { lsSet('orgs', orgs); store.setOrgs(orgList()); }

  function fail(errors) { var e = new Error(errors[0]); e.errors = errors; return e; }

  NOC.sources = NOC.sources || {};
  NOC.sources.demo = {
    name: 'demo',

    start: function (wantedOrg) {
      var savedOrgs = lsGet('orgs', null);
      orgs = savedOrgs && savedOrgs.length ? savedOrgs
        : [{ id: 'default', name: 'Host', color: '#4f8cff', note: 'Equipos y servicios propios de este servidor' }, U.clone(Seed.DEMO_ORG)];
      if (!savedOrgs) lsSet('orgs', orgs);
      byOrg = {};
      orgs.forEach(function (o) {
        var saved = lsGet(tkey(o.id), null);
        byOrg[o.id] = saved || (o.id === 'default' ? U.clone(Seed.TARGETS.concat(Seed.DEMO_EXTRA))
                              : o.id === Seed.DEMO_ORG.id ? U.clone(Seed.DEMO_ORG_TARGETS) : []);
      });
      activeOrg = byOrg[wantedOrg] ? wantedOrg : 'default';
      targets = byOrg[activeOrg];
      var s = lsGet('settings', null);
      if (s) store.state.settings = s;
      store.state.orgId = activeOrg;
      store.state.orgs = orgList();
      store.state.targets = targets.map(U.clone);
      t0 = Date.now();
      K = 0;
      // La organización activa genera historial previo; las demás solo una medición inicial (alimenta indicadores y alertas).
      orgs.forEach(function (o) {
        byOrg[o.id].forEach(function (t) {
          if (!t.enabled) { store.state.statuses[t.id] = { o: o.id, s: 'unknown', e: false }; return; }
          if (o.id === activeOrg) prefill(t); else feed(t, genResult(t, 0, Date.now()));
        });
      });
      store.setTargets(targets.map(U.clone));
      store.setConnected(true);
      if (timer) clearInterval(timer);
      timer = setInterval(tick, STEP);
      return Promise.resolve();
    },

    createTarget: function (input) {
      var v = NOC.validate.target(input, null, store.state.settings);
      if (v.errors.length) return Promise.reject(fail(v.errors));
      v.value.profile = 'healthy';
      v.value.checks.agent.token = '';
      targets.push(v.value);
      t0 = t0 || Date.now();
      persist();
      prefill(v.value);
      return Promise.resolve(U.clone(v.value));
    },
    updateTarget: function (id, input) {
      var cur = targets.filter(function (t) { return t.id === id; })[0];
      if (!cur) return Promise.reject(fail(['Objetivo no encontrado']));
      var v = NOC.validate.target(input, cur, store.state.settings);
      if (v.errors.length) return Promise.reject(fail(v.errors));
      v.value.id = id;
      setActiveList(targets.map(function (t) { return t.id === id ? v.value : t; }));
      persist();
      return Promise.resolve(U.clone(v.value));
    },
    removeTarget: function (id) {
      setActiveList(targets.filter(function (t) { return t.id !== id; }));
      delete prevStatus[id];
      persist();
      return Promise.resolve({ ok: true });
    },
    replaceTargets: function (list) {
      var out = [], errs = [];
      list.forEach(function (x, i) {
        var v = NOC.validate.target(x, null, store.state.settings);
        if (v.errors.length) errs.push('Fila ' + (i + 1) + ': ' + v.errors.join(' ')); else out.push(v.value);
      });
      if (errs.length) return Promise.reject(fail(errs.slice(0, 20)));
      setActiveList(out); prevStatus = {};
      persist();
      targets.forEach(function (t) { if (t.enabled) prefill(t); });
      return Promise.resolve(targets.map(U.clone));
    },
    checkNow: function (id) {
      var t = targets.filter(function (x) { return x.id === id; })[0];
      if (!t) return Promise.reject(fail(['Objetivo no encontrado']));
      var r = genResult(t, K, Date.now());
      feed(t, r);
      return Promise.resolve({ result: r });
    },
    saveSettings: function (s) {
      var merged = U.clone(store.state.settings);
      ['intervalSec', 'historyPoints', 'theme'].forEach(function (k) { if (s[k] != null) merged[k] = s[k]; });
      if (s.thresholds) Object.keys(s.thresholds).forEach(function (k) { merged.thresholds[k] = Number(s.thresholds[k]); });
      lsSet('settings', merged);
      store.setSettings(merged);
      return Promise.resolve(merged);
    },
    loadLayout: function (orgId) { return Promise.resolve(lsGet(lkey(orgId || activeOrg), null)); },
    saveLayout: function (l, orgId) { lsSet(lkey(orgId || activeOrg), l); return Promise.resolve(l); },

    /* ---- organizaciones ---- */
    switchOrg: function (id) {
      if (!byOrg[id]) return Promise.reject(fail(['Organización no encontrada']));
      activeOrg = id;
      targets = byOrg[id];
      store.ingestState({ org: id, orgs: orgList(), statuses: store.state.statuses, targets: targets.map(U.clone),
                          settings: store.state.settings, results: {}, history: {}, events: store.state.events });
      targets.forEach(function (t) { if (t.enabled) prefill(t, true); });
      return Promise.resolve();
    },
    createOrg: function (input) {
      var name = String((input && input.name) || '').trim().slice(0, 60);
      if (!name) return Promise.reject(fail(['El nombre de la organización es obligatorio.']));
      if (orgs.some(function (o) { return o.name.toLowerCase() === name.toLowerCase(); })) return Promise.reject(fail(['Ya existe una organización con ese nombre.']));
      var o = { id: 'o' + Math.random().toString(36).slice(2, 10), name: name,
                color: /^#[0-9a-fA-F]{6}$/.test(input.color || '') ? input.color : '#4f8cff', note: String(input.note || '').trim().slice(0, 200) };
      orgs.push(o); byOrg[o.id] = [];
      lsSet(tkey(o.id), []); persistOrgs();
      return Promise.resolve(U.clone(o));
    },
    updateOrg: function (id, input) {
      var o = orgs.filter(function (x) { return x.id === id; })[0];
      if (!o) return Promise.reject(fail(['Organización no encontrada.']));
      var name = String((input && input.name) || '').trim().slice(0, 60);
      if (!name) return Promise.reject(fail(['El nombre de la organización es obligatorio.']));
      if (orgs.some(function (x) { return x.id !== id && x.name.toLowerCase() === name.toLowerCase(); })) return Promise.reject(fail(['Ya existe una organización con ese nombre.']));
      o.name = name; if (/^#[0-9a-fA-F]{6}$/.test(input.color || '')) o.color = input.color; o.note = String(input.note || '').trim().slice(0, 200);
      persistOrgs();
      return Promise.resolve(U.clone(o));
    },
    removeOrg: function (id) {
      if (id === 'default') return Promise.reject(fail(['La organización principal (Host) no se puede eliminar.']));
      if (!byOrg[id]) return Promise.reject(fail(['Organización no encontrada.']));
      byOrg[id].forEach(function (t) { delete store.state.statuses[t.id]; delete prevStatus[t.id]; });
      delete byOrg[id];
      orgs = orgs.filter(function (o) { return o.id !== id; });
      try { localStorage.removeItem(LS + tkey(id)); localStorage.removeItem(LS + lkey(id)); } catch (e) { /* sin almacenamiento */ }
      persistOrgs();
      return Promise.resolve({ ok: true });
    },

    traceroute: function (opts) {
      var t = opts.targetId ? store.getTarget(opts.targetId) : null;
      var host = t ? U.hostOf(t) : String(opts.address || '');
      var prof = t ? profileOf(t) : 'healthy', h = hash(host), n = 7 + h % 4, hops = [];
      var names = [null, 'gw.local', 'cpe-isp.red', 'core1.isp.net', 'ix-mx1.transit.net', 'edge2.transit.net', 'bb.carrier.net', 'peer.cdn.net', 'lb1.' + host];
      for (var i = 1; i <= n; i++) {
        var ip = i === 1 ? '192.168.1.1' : i === 2 ? '10.' + (h % 200) + '.0.1' : i === n ? (U.isIp(host) ? host : fakeIp(host)) : fakeIp(host + i);
        var baseMs = i * (2 + h % 3) + (prof === 'slow' && i > n / 2 ? 140 : 0);
        var lossP = prof === 'flaky' && i >= n - 2 ? 0.3 : 0;
        var samples = [];
        for (var q = 0; q < 3; q++) {
          var dead = prof === 'down' && i > n - 3;
          samples.push(dead || Math.random() < lossP || (i === 4 && Math.random() < 0.05) ? null : r1(baseMs + rnd(0, 3 + i * 0.6)));
        }
        var st = U.stats(samples);
        var gone = prof === 'down' && i > n - 3;
        hops.push({ hop: i, ip: gone ? null : ip, name: gone ? null : (names[i] || null), samples: samples, sent: st.sent, loss: st.lossPct, min: st.min, avg: st.avg, max: st.max });
      }
      return new Promise(function (resolve) { setTimeout(function () { resolve({ host: host, hops: hops, ts: Date.now() }); }, rnd(500, 1000)); });
    }
  };
})(window.NOC = window.NOC || {});
