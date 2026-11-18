'use strict';
/*
 * Ping ICMP usando el comando del sistema (no requiere root ni dependencias).
 * Devuelve latencia min/prom/máx, pérdida, jitter y TTL. Funciona con Linux, macOS y Windows.
 */
var execFile = require('child_process').execFile;
var net = require('net');
var u = require('../lib/util');

var IS_WIN = process.platform === 'win32';
var IS_MAC = process.platform === 'darwin';

function buildArgs(ip, count, timeoutMs, basic) {
  var v6 = net.isIPv6(ip);
  if (IS_WIN) return ['-n', String(count), '-w', String(timeoutMs), v6 ? '-6' : '-4', ip];
  if (IS_MAC) return basic ? ['-c', String(count), ip] : ['-c', String(count), '-n', '-W', String(timeoutMs), '-i', '0.5', ip];
  var args = ['-n', '-c', String(count)];
  if (!basic) args.push('-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), '-i', '0.3');
  if (v6) args.push('-6');
  args.push(ip);
  return args;
}

function parse(out, count) {
  var samples = new Array(count).fill(null);
  var ttl = null;
  var lines = out.split(/\r?\n/);
  if (IS_WIN) {
    var idx = 0;
    lines.forEach(function (line) {
      var tm = /(?:time|tiempo)\s*([=<])\s*(\d+)\s*m/i.exec(line);
      if (tm) {
        if (idx < count) samples[idx] = tm[1] === '<' ? 0.5 : +tm[2];
        idx++;
        var tt = /TTL[=:]\s*(\d+)/i.exec(line);
        if (tt && ttl == null) ttl = +tt[1];
      } else if (/(timed out|agotado|unreachable|inaccesible|general failure|error general)/i.test(line)) idx++;
    });
  } else {
    var seqs = [];
    var rows = [];
    lines.forEach(function (line) {
      var sm = /icmp_seq=(\d+)/i.exec(line), tm = /time[=<]\s*([\d.,]+)\s*ms/i.exec(line);
      if (sm && tm) {
        rows.push({ seq: +sm[1], ms: parseFloat(tm[1].replace(',', '.')) });
        seqs.push(+sm[1]);
        var tt = /ttl=(\d+)/i.exec(line);
        if (tt && ttl == null) ttl = +tt[1];
      }
    });
    var base = seqs.indexOf(0) >= 0 ? 0 : 1;
    rows.forEach(function (r) { var i = r.seq - base; if (i >= 0 && i < count) samples[i] = r.ms; });
  }
  return { samples: samples, ttl: ttl };
}

function run(bin, args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, function (err, stdout, stderr) {
      resolve({ err: err, out: String(stdout || ''), errOut: String(stderr || '') });
    });
  });
}

async function ping(ip, opts) {
  opts = opts || {};
  var count = Math.min(10, Math.max(1, opts.count || 4));
  var timeoutMs = opts.timeoutMs || 2000;
  var execTimeout = count * 1000 + timeoutMs + 2000;
  var bin = (net.isIPv6(ip) && IS_MAC) ? 'ping6' : 'ping';

  var r = await run(bin, buildArgs(ip, count, timeoutMs, false), execTimeout);
  if (r.err && r.err.code === 'ENOENT') {
    return { sent: count, received: 0, lossPct: 100, unavailable: true, error: 'el comando ping no está instalado', samples: [] };
  }
  // Algunos ping mínimos (busybox) no aceptan -i/-W: reintenta con argumentos básicos.
  if (r.err && /(invalid|unrecognized|usage|illegal option)/i.test(r.errOut + r.out)) {
    r = await run(bin, buildArgs(ip, count, timeoutMs, true), execTimeout);
  }
  var parsed = parse(r.out, count);
  var received = parsed.samples.filter(function (v) { return v != null; }).length;
  if (!received && /(permission|not permitted|operation not|socket|capabilit|privilege)/i.test(r.errOut + r.out)) {
    return { sent: count, received: 0, lossPct: 100, unavailable: true, error: 'sin permiso para enviar ICMP en este equipo', samples: [] };
  }
  var st = u.stats(parsed.samples);
  st.ttl = parsed.ttl;
  st.samples = parsed.samples;
  st.ip = ip;
  return st;
}

module.exports = { ping: ping, parse: parse };
