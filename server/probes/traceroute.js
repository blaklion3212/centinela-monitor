'use strict';
/*
 * Análisis de ruta al estilo PingPlotter: lista cada salto con su latencia y pérdida.
 * Usa traceroute (Linux/macOS), tracepath como respaldo, o tracert (Windows).
 * El navegador repite la consulta y acumula estadísticas por salto.
 */
var execFile = require('child_process').execFile;
var net = require('net');
var u = require('../lib/util');
var dnsProbe = require('./dns');

var IS_WIN = process.platform === 'win32';
var MAX_HOPS = 20, QUERIES = 3, WAIT_SEC = 1;

function run(bin, args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 }, function (err, stdout) {
      resolve({ err: err, out: String(stdout || '') });
    });
  });
}

var IPV4 = /(\d{1,3}(?:\.\d{1,3}){3})/;
var IPV6 = /([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})/i;

function parseLine(rest) {
  var samples = [];
  var cleaned = rest.replace(/(\*)|<?(\d+(?:[.,]\d+)?)\s*ms/gi, function (m, star, num) {
    if (star) samples.push(null);
    else {
      var v = parseFloat(num.replace(',', '.'));
      // '<1 ms' (tracert) se registra como 0.5, igual que en ping
      samples.push(/^</.test(m) ? 0.5 : (v || 0.5));
    }
    return ' ';
  });
  var ip = null, m = IPV4.exec(cleaned) || IPV6.exec(cleaned);
  if (m) ip = m[1];
  return { ip: ip, samples: samples };
}

function parseTraceroute(out) {
  var hops = [];
  out.split(/\r?\n/).forEach(function (line) {
    var m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) return;
    var p = parseLine(m[2]);
    if (!p.samples.length) return;
    hops.push({ hop: +m[1], ip: p.ip, samples: p.samples });
  });
  return hops;
}

function parseTracepath(out) {
  var hops = [];
  out.split(/\r?\n/).forEach(function (line) {
    var m = /^\s*(\d+)\??:\s+(.*)$/.exec(line);
    if (!m) return;
    if (/no reply/i.test(m[2])) { hops.push({ hop: +m[1], ip: null, samples: [null] }); return; }
    var ms = /(\d+(?:\.\d+)?)\s*ms/.exec(m[2]);
    var ip = IPV4.exec(m[2]);
    if (!ip && !ms) return;
    var prev = hops[hops.length - 1];
    var sample = ms ? parseFloat(ms[1]) : null;
    if (prev && prev.hop === +m[1]) { prev.samples.push(sample); return; }
    hops.push({ hop: +m[1], ip: ip ? ip[1] : null, samples: [sample] });
  });
  return hops;
}

async function trace(host) {
  var v6 = net.isIPv6(host);
  var r;
  if (IS_WIN) {
    r = await run('tracert', ['-d', '-h', String(MAX_HOPS), '-w', String(WAIT_SEC * 1000), host], 90000);
    if (r.err && r.err.code === 'ENOENT') return { error: 'tracert no está disponible en este equipo', hops: [] };
    return finish(parseTraceroute(r.out), r);
  }
  var args = ['-n', '-q', String(QUERIES), '-w', String(WAIT_SEC), '-m', String(MAX_HOPS)];
  if (v6) args.push('-6');
  args.push(host);
  r = await run('traceroute', args, 60000);
  if (r.err && r.err.code === 'ENOENT') {
    r = await run('tracepath', ['-n', '-m', String(MAX_HOPS)].concat(v6 ? ['-6'] : [], [host]), 60000);
    if (r.err && r.err.code === 'ENOENT') {
      return { error: 'No hay traceroute ni tracepath instalado (en Debian/Ubuntu: apt install traceroute).', hops: [] };
    }
    return finish(parseTracepath(r.out), r);
  }
  return finish(parseTraceroute(r.out), r);
}

async function finish(hops, r) {
  if (!hops.length) {
    return { error: (r.err && /permission|not permitted/i.test(String(r.err.message))) ? 'Sin permiso para ejecutar traceroute.' :
                    'No se obtuvieron saltos (¿red sin salida o ICMP bloqueado?).', hops: [] };
  }
  await Promise.all(hops.map(async function (h) {
    var st = u.stats(h.samples);
    h.sent = st.sent; h.loss = st.lossPct; h.min = st.min; h.avg = st.avg; h.max = st.max;
    h.name = h.ip ? await dnsProbe.reverseName(h.ip) : null;
  }));
  return { hops: hops, ts: Date.now() };
}

module.exports = { trace: trace, parseTraceroute: parseTraceroute, parseTracepath: parseTracepath };
