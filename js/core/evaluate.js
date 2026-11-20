/*
 * Lógica que decide el estado de un objetivo a partir de lo medido.
 * Se ejecuta igual en el servidor (Node) y en el navegador (modo demostración),
 * así UP / DEGRADADO / DOWN significa lo mismo en ambos lados.
 *
 *   DOWN      = falla de disponibilidad: no hay respuesta, HTTP fuera de lo esperado,
 *               puerto cerrado, certificado vencido, servicio detenido.
 *   DEGRADADO = responde, pero fuera de umbrales: latencia, pérdida, jitter, TTFB,
 *               certificado por vencer, disco/CPU/RAM altos, agente sin respuesta.
 *   UP        = todo dentro de lo esperado.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../config/defaults.js'));
  else { root.NOC = root.NOC || {}; root.NOC.Evaluate = factory(root.NOC.Defaults); }
})(typeof self !== 'undefined' ? self : this, function (Defaults) {
  'use strict';

  var STATUS = { UP: 'up', DEGRADED: 'degraded', DOWN: 'down', UNKNOWN: 'unknown' };
  var LABEL = { up: 'UP', degraded: 'DEGRADADO', down: 'DOWN', unknown: 'SIN DATOS' };
  var WORD = { up: 'Arriba', degraded: 'Degradado', down: 'Abajo', unknown: 'Sin datos' };
  var RANK = { unknown: 0, up: 1, degraded: 2, down: 3 };

  function worst(list) {
    var w = STATUS.UNKNOWN;
    for (var i = 0; i < list.length; i++) if (RANK[list[i]] > RANK[w]) w = list[i];
    return w;
  }

  // "200-399,401" -> ¿cumple el código?
  function statusMatches(code, spec) {
    if (typeof code !== 'number') return false;
    var parts = String(spec || '200-399').split(',');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      var m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
      if (!m) continue;
      var lo = +m[1], hi = m[2] ? +m[2] : lo;
      if (code >= lo && code <= hi) return true;
    }
    return false;
  }

  function evaluate(target, r, thresholds) {
    var th = thresholds || Defaults.SETTINGS.thresholds;
    var c = target.checks || {};
    var reasons = [];
    var seen = false; // ¿hubo algún dato medido?
    // `sub` es opcional (ssl: expired|expiring|unreadable; disk: punto de montaje); solo se añade si se indica.
    function add(level, text, down, code, sub) {
      var o = { level: level, text: text, down: !!down, code: code || '' };
      if (sub !== undefined) o.sub = sub;
      reasons.push(o);
    }
    function n(v, d) { return typeof v === 'number' ? Math.round(v * (d || 1)) / (d || 1) : v; }

    // DNS
    if (r.dns) {
      seen = true;
      if (r.dns.error) add('crit', 'No se resuelve el nombre (' + r.dns.error + ')', true, 'dns');
    }

    // Ping
    var p = r.ping;
    if (p && c.ping !== false) {
      if (p.unavailable) {
        add('info', 'Ping no disponible en el servidor de monitoreo', false, 'icmp');
      } else {
        seen = true;
        if (p.sent > 0 && p.received === 0) {
          // Vivo si algún puerto está abierto o si HTTP respondió sin error con un código del esperado.
          var expectedHttp = (c.http && c.http.expectedStatus) || '200-399';
          var httpAlive = !!(r.http && !r.http.error && statusMatches(r.http.status, expectedHttp));
          var alive = (r.ports || []).some(function (x) { return x.open; }) || httpAlive;
          if (alive) add('info', 'Sin respuesta ICMP (posible bloqueo por firewall)', false, 'icmp');
          else add('crit', 'Sin respuesta al ping (100 % de pérdida)', true, 'ping');
        } else if (p.received > 0) {
          if (p.lossPct >= th.lossCritPct) add('crit', 'Pérdida de paquetes ' + n(p.lossPct, 10) + ' % (crítico desde ' + th.lossCritPct + ' %)', false, 'loss');
          else if (p.lossPct >= th.lossWarnPct) add('warn', 'Pérdida de paquetes ' + n(p.lossPct, 10) + ' %', false, 'loss');
          if (p.avg >= th.latencyCritMs) add('crit', 'Latencia ' + n(p.avg, 10) + ' ms (umbral crítico ' + th.latencyCritMs + ' ms)', false, 'latency');
          else if (p.avg >= th.latencyWarnMs) add('warn', 'Latencia ' + n(p.avg, 10) + ' ms (umbral ' + th.latencyWarnMs + ' ms)', false, 'latency');
          if (p.jitter >= th.jitterCritMs) add('crit', 'Jitter ' + n(p.jitter, 10) + ' ms (afecta tiempo real)', false, 'jitter');
          else if (p.jitter >= th.jitterWarnMs) add('warn', 'Jitter ' + n(p.jitter, 10) + ' ms', false, 'jitter');
        }
      }
    }

    // Puertos
    (r.ports || []).forEach(function (pt) {
      seen = true;
      if (!pt.open) add('crit', 'Puerto ' + pt.port + ' cerrado o filtrado' + (pt.error ? ' (' + pt.error + ')' : ''), true, 'port');
    });

    // HTTP / HTTPS
    if (r.http) {
      seen = true;
      var h = r.http;
      var expected = (c.http && c.http.expectedStatus) || '200-399';
      if (h.error) {
        add('crit', 'Sin respuesta HTTP (' + h.error + ')', true, 'http');
      } else if (!statusMatches(h.status, expected)) {
        add('crit', 'HTTP ' + h.status + (h.statusText ? ' ' + h.statusText : '') + ' (se esperaba ' + expected + ')' +
          ((h.status === 403 || h.status === 429 || h.status === 503) && !(c.http && c.http.browser) ? ' · si en el navegador sí abre, activa “Identificarse como un navegador” en el objetivo' : ''), true, 'http');
      } else {
        if (h.keywordFound === false) add('crit', 'La página responde pero no contiene el texto esperado', true, 'keyword');
        if (h.ttfbMs >= th.ttfbCritMs) add('crit', 'TTFB ' + Math.round(h.ttfbMs) + ' ms (umbral crítico ' + th.ttfbCritMs + ' ms)', false, 'ttfb');
        else if (h.ttfbMs >= th.ttfbWarnMs) add('warn', 'TTFB ' + Math.round(h.ttfbMs) + ' ms (umbral ' + th.ttfbWarnMs + ' ms)', false, 'ttfb');
      }
    }

    // SSL / TLS
    if (r.ssl) {
      seen = true;
      var s = r.ssl;
      if (s.error) add('warn', 'No se pudo leer el certificado (' + s.error + ')', false, 'ssl', 'unreadable');
      else {
        if (s.daysLeft < 0) add('crit', 'Certificado vencido hace ' + Math.abs(s.daysLeft) + ' días', true, 'ssl', 'expired');
        else if (s.daysLeft <= th.sslCritDays) add('crit', 'Certificado vence en ' + s.daysLeft + ' días', false, 'ssl', 'expiring');
        else if (s.daysLeft <= th.sslWarnDays) add('warn', 'Certificado vence en ' + s.daysLeft + ' días', false, 'ssl', 'expiring');
        if (s.authorized === false) add('warn', 'Certificado no confiable: ' + (s.authError || 'cadena inválida'), false, 'ssl-trust');
      }
    }

    // Agente (infraestructura)
    if (r.agent) {
      seen = true;
      var a = r.agent;
      if (a.error) {
        add('warn', 'Agente sin respuesta (' + a.error + ')', false, 'agent');
      } else {
        var cpu = a.cpu && a.cpu.usagePct, mem = a.mem && a.mem.usedPct, io = a.cpu && a.cpu.ioWaitPct;
        if (cpu >= th.cpuCritPct) add('crit', 'CPU al ' + Math.round(cpu) + ' %', false, 'cpu');
        else if (cpu >= th.cpuWarnPct) add('warn', 'CPU al ' + Math.round(cpu) + ' %', false, 'cpu');
        if (mem >= th.memCritPct) add('crit', 'Memoria al ' + Math.round(mem) + ' %', false, 'mem');
        else if (mem >= th.memWarnPct) add('warn', 'Memoria al ' + Math.round(mem) + ' %', false, 'mem');
        if (io >= th.ioWaitCritPct) add('crit', 'I/O wait ' + Math.round(io) + ' % (disco lento)', false, 'io');
        else if (io >= th.ioWaitWarnPct) add('warn', 'I/O wait ' + Math.round(io) + ' %', false, 'io');
        (a.disks || []).forEach(function (d) {
          if (d.usedPct >= th.diskCritPct) add('crit', 'Disco ' + d.mount + ' al ' + Math.round(d.usedPct) + ' %', false, 'disk', d.mount);
          else if (d.usedPct >= th.diskWarnPct) add('warn', 'Disco ' + d.mount + ' al ' + Math.round(d.usedPct) + ' %', false, 'disk', d.mount);
        });
        (a.services || []).forEach(function (sv) {
          if (!sv.active) add('crit', 'Servicio ' + sv.name + ' detenido', true, 'service');
        });
      }
    }

    var status;
    if (!seen) status = STATUS.UNKNOWN;
    else if (reasons.some(function (x) { return x.down; })) status = STATUS.DOWN;
    else if (reasons.some(function (x) { return x.level === 'warn' || x.level === 'crit'; })) status = STATUS.DEGRADED;
    else status = STATUS.UP;

    return { status: status, reasons: reasons };
  }

  // Resumen compacto que se guarda en el historial para las gráficas.
  function toPoint(r) {
    var p = r.ping || {}, h = r.http || {}, a = r.agent && !r.agent.error ? r.agent : null;
    return {
      t: r.ts, s: r.status,
      lat: typeof p.avg === 'number' ? p.avg : null,
      min: typeof p.min === 'number' ? p.min : null,
      max: typeof p.max === 'number' ? p.max : null,
      loss: typeof p.lossPct === 'number' ? p.lossPct : null,
      jit: typeof p.jitter === 'number' ? p.jitter : null,
      ttl: typeof p.ttl === 'number' ? p.ttl : null,
      ttfb: typeof h.ttfbMs === 'number' ? h.ttfbMs : null,
      http: typeof h.status === 'number' ? h.status : null,
      cpu: a && a.cpu ? a.cpu.usagePct : null,
      mem: a && a.mem ? a.mem.usedPct : null,
      io: a && a.cpu && typeof a.cpu.ioWaitPct === 'number' ? a.cpu.ioWaitPct : null,
      rx: a && a.net ? a.net.rxBps : null,
      tx: a && a.net ? a.net.txBps : null
    };
  }

  return { STATUS: STATUS, LABEL: LABEL, WORD: WORD, RANK: RANK, worst: worst,
           statusMatches: statusMatches, evaluate: evaluate, toPoint: toPoint };
});
