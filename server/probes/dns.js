'use strict';
/* Resolución de nombres: para un host o URL devuelve la(s) IP que resuelve; para una IP intenta el PTR (DNS inverso). */
var dns = require('dns');
var net = require('net');
var u = require('../lib/util');

var ptrCache = new Map(); // ip -> { name, at }
var PTR_TTL_MS = 10 * 60 * 1000;
var PTR_MAX = 1000; // tope de entradas: se expulsa la más antigua

function ptrSet(ip, name) {
  ptrCache.delete(ip); // reinserta al final para conservar el orden de antigüedad
  ptrCache.set(ip, { name: name, at: Date.now() });
  while (ptrCache.size > PTR_MAX) ptrCache.delete(ptrCache.keys().next().value);
}

async function resolve(host, timeoutMs) {
  timeoutMs = timeoutMs || 3000;
  if (net.isIP(host)) {
    var out = { input: host, literal: true, resolved: host, ips: [host], ms: null, ptr: null };
    var hit = ptrCache.get(host);
    if (hit && Date.now() - hit.at < PTR_TTL_MS) { out.ptr = hit.name; return out; }
    try {
      var names = await u.withTimeout(dns.promises.reverse(host), 1500, 'ptr');
      out.ptr = names[0] || null;
    } catch (e) { out.ptr = null; }
    ptrSet(host, out.ptr);
    return out;
  }
  var t0 = process.hrtime.bigint();
  try {
    var list = await u.withTimeout(dns.promises.lookup(host, { all: true }), timeoutMs, 'timeout');
    var ms = u.round(Number(process.hrtime.bigint() - t0) / 1e6, 1);
    var ips = [];
    list.forEach(function (a) { if (ips.indexOf(a.address) < 0) ips.push(a.address); });
    var v4 = ips.filter(function (ip) { return net.isIPv4(ip); });
    return { input: host, literal: false, resolved: (v4[0] || ips[0] || null), ips: ips, ms: ms, ptr: null };
  } catch (e) {
    return { input: host, literal: false, resolved: null, ips: [], ms: u.round(Number(process.hrtime.bigint() - t0) / 1e6, 1),
             error: u.friendlyError(e) };
  }
}

// PTR para nombres de salto en traceroute (con caché).
async function reverseName(ip) {
  var hit = ptrCache.get(ip);
  if (hit && Date.now() - hit.at < PTR_TTL_MS) return hit.name;
  var name = null;
  try { name = (await u.withTimeout(dns.promises.reverse(ip), 1000, 'ptr'))[0] || null; } catch (e) { name = null; }
  ptrSet(ip, name);
  return name;
}

module.exports = { resolve: resolve, reverseName: reverseName };
