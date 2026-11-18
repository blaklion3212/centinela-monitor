'use strict';
/*
 * Ejecuta todas las verificaciones configuradas de un objetivo y devuelve el resultado ya evaluado
 * (estado UP / DEGRADADO / DOWN y la lista de razones que lo explican).
 */
var http = require('http');
var https = require('https');
var Evaluate = require('../../js/core/evaluate.js');
var Fingerprint = require('../../js/shared/fingerprint.js');
var validate = require('./validate');
var u = require('./util');
var dnsProbe = require('../probes/dns');
var pingProbe = require('../probes/ping');
var tcpProbe = require('../probes/tcp');
var httpProbe = require('../probes/http');
var tlsProbe = require('../probes/tls');
var sysmetrics = require('../../agent/sysmetrics');

var LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

var AGENT_MAX_BODY = 1024 * 1024; // 1 MB

function fnum(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function fstr(v) { return typeof v === 'string' ? v.slice(0, 200) : ''; }

// Deja solo los campos esperados y con el tipo correcto: lo que devuelve un agente remoto no es de confianza.
function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'respuesta del agente no válida' };
  var cpu = raw.cpu && typeof raw.cpu === 'object' ? raw.cpu : {};
  var mem = raw.mem && typeof raw.mem === 'object' ? raw.mem : {};
  var net = raw.net && typeof raw.net === 'object' ? raw.net : null;
  return {
    ts: fnum(raw.ts),
    hostname: fstr(raw.hostname),
    platform: fstr(raw.platform),
    release: fstr(raw.release),
    uptimeSec: fnum(raw.uptimeSec),
    cpu: {
      usagePct: fnum(cpu.usagePct),
      ioWaitPct: fnum(cpu.ioWaitPct),
      cores: fnum(cpu.cores),
      load: Array.isArray(cpu.load) ? cpu.load.slice(0, 3).map(fnum) : []
    },
    mem: { totalMb: fnum(mem.totalMb), usedMb: fnum(mem.usedMb), usedPct: fnum(mem.usedPct), swapUsedPct: fnum(mem.swapUsedPct) },
    disks: (Array.isArray(raw.disks) ? raw.disks : []).slice(0, 12).filter(function (d) { return d && typeof d === 'object'; }).map(function (d) {
      return { mount: fstr(d.mount), fs: fstr(d.fs), totalGb: fnum(d.totalGb), usedGb: fnum(d.usedGb), usedPct: fnum(d.usedPct) };
    }),
    net: net ? { rxBps: fnum(net.rxBps), txBps: fnum(net.txBps) } : null,
    services: (Array.isArray(raw.services) ? raw.services : []).slice(0, 20).filter(function (x) { return x && typeof x === 'object'; }).map(function (x) {
      return { name: fstr(x.name), active: x.active === true };
    })
  };
}

var AGENT_DEADLINE_MS = 10000; // plazo absoluto de una consulta al agente

function agentFetch(ag, host, ip) {
  return new Promise(function (resolve) {
    var settled = false, req = null;
    var useTls = ag.tls === true;
    var pinned = useTls && ag.fingerprint ? Fingerprint.normalize(ag.fingerprint) : '';
    var timer = null;
    function done(v) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    }
    // Defensa en profundidad: con TLS y sin huella no se envía el token (objetivos guardados antes de exigirla).
    if (useTls && !pinned) return done({ error: 'Falta la huella TLS del agente' });
    // Plazo absoluto: 'timeout' del socket solo cubre inactividad y un servidor lento podría retener la petición.
    timer = setTimeout(function () {
      done({ error: 'El agente tardó demasiado en responder' });
      if (req) req.destroy();
    }, AGENT_DEADLINE_MS);
    var headers = {};
    var path = '/metrics?services=' + encodeURIComponent((ag.services || []).join(','));
    var onResponse = function (res) {
      var chunks = [], size = 0, over = false;
      res.on('data', function (c) {
        size += c.length;
        if (size > AGENT_MAX_BODY) { over = true; done({ error: 'respuesta del agente demasiado grande' }); res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', function () {
        if (over) return;
        if (res.statusCode === 401) return done({ error: 'token rechazado por el agente' });
        if (res.statusCode === 429) return done({ error: 'el agente limitó las peticiones (demasiados intentos)' });
        if (res.statusCode !== 200) return done({ error: 'el agente respondió HTTP ' + res.statusCode });
        try { done(normalizeAgent(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
        catch (e) { done({ error: 'respuesta del agente no válida' }); }
      });
      res.on('aborted', function () { done({ error: 'conexión con el agente interrumpida' }); });
      res.on('error', function (e) { done({ error: u.friendlyError(e) }); });
      res.on('close', function () { done({ error: 'conexión con el agente cerrada antes de terminar' }); });
    };
    try {
      if (!useTls) {
        if (ag.token) headers.Authorization = 'Bearer ' + ag.token;
        req = http.get({ host: ip || host, port: ag.port, headers: headers, timeout: 6000, path: path }, onResponse);
      } else {
        // La petición se crea sin el token y la cabecera se añade en 'secureConnect', solo si la huella
        // del certificado presentado coincide con la fijada. Así el secreto nunca llega a un servidor falso.
        // Con rejectUnauthorized:false la validación de la cadena no aplica: la autenticidad la da la huella.
        req = https.request({ host: ip || host, port: ag.port, method: 'GET', headers: headers, timeout: 6000, path: path,
                              rejectUnauthorized: false,
                              // IMPORTANTE: agent:false evita reutilizar sockets y sesiones TLS. La protección del token
                              // depende de ello: una conexión reutilizada ya no pasaría por la verificación de huella.
                              agent: false }, onResponse);
        req.on('socket', function (sock) {
          sock.once('secureConnect', function () {
            var cert = null;
            try { cert = sock.getPeerCertificate(); } catch (e) { cert = null; }
            var got = cert && cert.fingerprint256 ? cert.fingerprint256 : '';
            if (pinned && !(got && Fingerprint.same(pinned, got))) {
              done({ error: 'La huella TLS del agente no coincide (posible suplantación)' });
              req.destroy();
              return;
            }
            if (ag.token) req.setHeader('Authorization', 'Bearer ' + ag.token);
            req.end();
          });
        });
      }
    } catch (e) { return done({ error: u.friendlyError(e) }); }
    req.on('timeout', function () { done({ error: 'tiempo agotado' }); req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })); });
    req.on('error', function (e) { done({ error: u.friendlyError(e) }); });
  });
}

async function agentMetrics(target, host, ip) {
  var ag = target.checks.agent;
  if (LOCAL_HOSTS.indexOf(host) >= 0) {
    try { return await u.withTimeout(sysmetrics.collect(ag.services), 12000, 'timeout'); }
    catch (e) { return { error: u.friendlyError(e) }; }
  }
  return agentFetch(ag, host, ip);
}

async function checkTarget(target, settings) {
  var c = target.checks || {};
  var host = validate.hostFromAddress(target.kind, target.address);
  var r = { id: target.id, ts: Date.now() };

  r.dns = await dnsProbe.resolve(host);
  var ip = r.dns.resolved;

  var jobs = [];
  if (c.ping && ip) jobs.push(pingProbe.ping(ip, { count: 4, timeoutMs: 2000 }).then(function (x) { r.ping = x; }));
  if (c.ports && c.ports.length && ip) {
    jobs.push(Promise.all(c.ports.map(function (p) { return tcpProbe.checkPort(ip, p, 3000); })).then(function (x) { r.ports = x; }));
  }
  var httpTls = null;
  if (target.kind === 'url' && c.http && ip) {
    jobs.push(httpProbe.probe(target.address, c.http, ip).then(function (x) { r.http = x.http; httpTls = x.tls; }));
  }
  if (c.agent && c.agent.enabled) {
    jobs.push(agentMetrics(target, host, ip).then(function (x) { r.agent = x; }));
  }
  await Promise.all(jobs);

  if (c.ssl && ip) {
    if (httpTls) r.ssl = httpTls;
    else {
      var port = 443;
      if (target.kind === 'url') { try { port = Number(new URL(target.address).port) || 443; } catch (e) { port = 443; } }
      r.ssl = await tlsProbe.probe(host, port, ip, 5000);
    }
  }

  var ev = Evaluate.evaluate(target, r, settings.thresholds);
  r.status = ev.status;
  r.reasons = ev.reasons;
  return r;
}

module.exports = { checkTarget: checkTarget };
