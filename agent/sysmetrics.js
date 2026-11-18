'use strict';
/*
 * Recolector de métricas del sistema. Sin dependencias.
 *   Linux:   CPU, I/O wait, memoria, discos, ancho de banda y servicios (systemctl / pgrep).
 *   Windows: CPU, memoria, discos (PowerShell) y servicios (Get-Service). Sin I/O wait ni ancho de banda.
 *   macOS:   CPU, memoria, discos y procesos (pgrep).
 *
 * Lo usa el dashboard para el equipo local y agent.js para exponerlo por HTTP en servidores remotos.
 */
var fs = require('fs');
var os = require('os');
var execFile = require('child_process').execFile;

var IS_WIN = process.platform === 'win32';
var IS_LINUX = process.platform === 'linux';
// Primer carácter alfanumérico: un nombre nunca puede pasar por opción de systemctl/pgrep.
var SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,63}$/;
var SKIP_FS = /^(tmpfs|devtmpfs|squashfs|efivarfs|proc|sysfs|cgroup2?|ramfs|devpts|iso9660|autofs|overlay|fuse\.(?:gvfsd-fuse|portal))$/;
var SKIP_MOUNT = /^\/(snap|sys|proc|dev|run)(\/|$)/;

var prev = null; // instantánea anterior (para calcular tasas)

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function round(v, d) { var m = Math.pow(10, d == null ? 1 : d); return Math.round(v * m) / m; }

function run(bin, args, timeout) {
  return new Promise(function (resolve) {
    execFile(bin, args, { timeout: timeout || 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, function (err, stdout) {
      resolve({ err: err, out: String(stdout || '') });
    });
  });
}

function cpuSnap() {
  if (IS_LINUX) {
    try {
      var p = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
      var user = p[0], nice = p[1], system = p[2], idle = p[3], iowait = p[4] || 0, irq = p[5] || 0, soft = p[6] || 0, steal = p[7] || 0;
      return { total: user + nice + system + idle + iowait + irq + soft + steal, idle: idle + iowait, iowait: iowait, hasIo: true };
    } catch (e) { /* cae al respaldo */ }
  }
  var idleT = 0, total = 0;
  os.cpus().forEach(function (c) { for (var k in c.times) total += c.times[k]; idleT += c.times.idle; });
  return { total: total, idle: idleT, iowait: 0, hasIo: false };
}

function netSnap() {
  if (!IS_LINUX) return null;
  try {
    var rx = 0, tx = 0;
    fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).forEach(function (line) {
      var m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (!m || m[1] === 'lo' || /^(docker|veth|br-|virbr)/.test(m[1])) return;
      var f = m[2].trim().split(/\s+/).map(Number);
      rx += f[0] || 0; tx += f[8] || 0;
    });
    return { rx: rx, tx: tx };
  } catch (e) { return null; }
}

function memInfo() {
  if (IS_LINUX) {
    try {
      var t = fs.readFileSync('/proc/meminfo', 'utf8');
      var get = function (k) { var m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(t); return m ? +m[1] / 1024 : null; };
      var total = get('MemTotal'), avail = get('MemAvailable');
      if (total != null && avail != null) {
        var swT = get('SwapTotal'), swF = get('SwapFree');
        return { totalMb: Math.round(total), usedMb: Math.round(total - avail), usedPct: round((total - avail) / total * 100),
                 swapUsedPct: swT ? round((swT - swF) / swT * 100) : 0 };
      }
    } catch (e) { /* respaldo */ }
  }
  var tot = os.totalmem() / 1048576, free = os.freemem() / 1048576;
  return { totalMb: Math.round(tot), usedMb: Math.round(tot - free), usedPct: round((tot - free) / tot * 100), swapUsedPct: null };
}

async function disks() {
  var out = [];
  if (IS_WIN) {
    var r = await run('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress']);
    try {
      var j = JSON.parse(r.out); if (!Array.isArray(j)) j = [j];
      j.forEach(function (d) {
        if (!d || !d.Size) return;
        var used = d.Size - d.FreeSpace;
        out.push({ mount: d.DeviceID, fs: 'NTFS', totalGb: round(d.Size / 1073741824), usedGb: round(used / 1073741824), usedPct: round(used / d.Size * 100) });
      });
    } catch (e) { /* sin datos */ }
    return out;
  }
  var res = await run('df', ['-P', '-k', '-T']);
  var withType = !res.err && /Type/.test(res.out.split('\n')[0] || '');
  if (!withType) res = await run('df', ['-P', '-k']);
  res.out.split('\n').slice(1).forEach(function (line) {
    var f = line.trim().split(/\s+/);
    if (f.length < 6) return;
    var fsType = withType ? f[1] : '', off = withType ? 2 : 1;
    var used = +f[off + 1], avail = +f[off + 2], mount = f.slice(off + 4).join(' ');
    if (!isFinite(used) || !isFinite(avail) || used + avail === 0) return;
    if ((fsType && SKIP_FS.test(fsType) && mount !== '/') || SKIP_MOUNT.test(mount)) return;
    if (/^\/var\/lib\/(docker|containers|kubelet)/.test(mount)) return;
    out.push({ mount: mount, fs: fsType || f[0], totalGb: round((used + avail) / 1048576), usedGb: round(used / 1048576),
               usedPct: round(used / (used + avail) * 100) });
  });
  return out.slice(0, 12);
}

async function serviceActive(name) {
  if (!SERVICE_RE.test(name)) return false;
  if (IS_WIN) {
    // El nombre ya validado no admite comillas ni espacios, por lo que no puede salir del literal entre comillas simples.
    var w = await run('powershell', ['-NoProfile', '-Command', "(Get-Service -Name '" + name + "' -ErrorAction SilentlyContinue).Status"]);
    return /running/i.test(w.out);
  }
  if (IS_LINUX) {
    var s = await run('systemctl', ['is-active', '--', name], 4000);
    if (/^active/.test(s.out.trim())) return true;
  }
  var p = await run('pgrep', ['-x', '--', name], 4000);
  return !p.err;
}

async function collect(serviceNames) {
  var first = !prev;
  var a = prev || { t: Date.now(), cpu: cpuSnap(), net: netSnap() };
  if (first) await sleep(300);
  var b = { t: Date.now(), cpu: cpuSnap(), net: netSnap() };
  prev = b;

  var dt = b.cpu.total - a.cpu.total;
  var cpu = {
    usagePct: dt > 0 ? round(100 * (1 - (b.cpu.idle - a.cpu.idle) / dt)) : 0,
    ioWaitPct: b.cpu.hasIo && dt > 0 ? round(100 * (b.cpu.iowait - a.cpu.iowait) / dt) : null,
    cores: os.cpus().length,
    load: os.loadavg().map(function (v) { return round(v, 2); })
  };
  var net = { rxBps: null, txBps: null };
  var secs = (b.t - a.t) / 1000;
  if (a.net && b.net && secs > 0) {
    net.rxBps = Math.max(0, Math.round((b.net.rx - a.net.rx) * 8 / secs));
    net.txBps = Math.max(0, Math.round((b.net.tx - a.net.tx) * 8 / secs));
  }

  var names = (serviceNames || []).filter(function (n) { return SERVICE_RE.test(n); }).slice(0, 20);
  var results = await Promise.all([disks(), Promise.all(names.map(serviceActive))]);

  return {
    ts: Date.now(), hostname: os.hostname(), platform: process.platform, release: os.release(), uptimeSec: Math.round(os.uptime()),
    cpu: cpu, mem: memInfo(), disks: results[0], net: net,
    services: names.map(function (n, i) { return { name: n, active: results[1][i] }; })
  };
}

module.exports = { collect: collect, SERVICE_RE: SERVICE_RE };
