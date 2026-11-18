'use strict';
/*
 * Verificación HTTP/HTTPS (capa 7): código de estado, TTFB (tiempo al primer byte), tiempo total,
 * redirecciones, texto esperado y certificado TLS de la conexión usada.
 */
var http = require('http');
var https = require('https');
var net = require('net');
var u = require('../lib/util');
var tlsProbe = require('./tls');

var MAX_BODY = 256 * 1024;
var MAX_REDIRECTS = 10;

// Cabeceras de un navegador real, para sitios que bloquean a los monitores (403/429 con el User-Agent de Centinela).
var BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1'
};

// Mini almacén de cookies solo para seguir redirecciones: algunos sitios redirigen en bucle hasta que el cliente
// guarda una cookie (como hace un navegador). Se ignoran ruta, caducidad y Secure; no sale de esta medición.
function cookieHeader(jar, hostname) {
  var out = [];
  Object.keys(jar).forEach(function (k) {
    var c = jar[k];
    if (hostname === c.domain || hostname.slice(-(c.domain.length + 1)) === '.' + c.domain) out.push(c.name + '=' + c.value);
  });
  return out.join('; ');
}
function storeCookies(jar, hostname, setCookie) {
  (setCookie || []).forEach(function (line) {
    var parts = String(line).split(';'), nv = parts[0].indexOf('=');
    if (nv <= 0) return;
    var name = parts[0].slice(0, nv).trim(), value = parts[0].slice(nv + 1).trim(), domain = hostname;
    parts.slice(1).forEach(function (a) {
      var m = /^\s*domain\s*=\s*\.?([^;\s]+)/i.exec(a);
      if (m && (hostname === m[1].toLowerCase() || hostname.slice(-(m[1].length + 1)) === '.' + m[1].toLowerCase())) domain = m[1].toLowerCase();
    });
    if (/^\s*max-age\s*=\s*0\s*$/i.test(parts.slice(1).join(';')) ) { delete jar[domain + '|' + name]; return; }
    if (Object.keys(jar).length < 50) jar[domain + '|' + name] = { name: name, value: value.slice(0, 1000), domain: domain };
  });
}

function one(urlObj, o) {
  return new Promise(function (resolve) {
    var isHttps = urlObj.protocol === 'https:';
    var lib = isHttps ? https : http;
    var hostname = urlObj.hostname.replace(/^\[|\]$/g, '');
    var t0 = process.hrtime.bigint();
    var settled = false, timedOut = false;

    var options = {
      method: o.method,
      hostname: hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: (urlObj.pathname || '/') + (urlObj.search || ''),
      headers: Object.assign({ 'User-Agent': 'Centinela-Monitor', 'Accept': '*/*' }, o.browser ? BROWSER_HEADERS : {}, { 'Connection': 'close' }),
      agent: false,
      rejectUnauthorized: false,
      timeout: o.timeoutMs
    };
    if (isHttps && !net.isIP(hostname)) options.servername = hostname;
    var ck = o.jar ? cookieHeader(o.jar, hostname) : '';
    if (ck) options.headers.Cookie = ck;
    // Conecta a la IP ya resuelta para que la IP mostrada sea la realmente usada.
    if (o.ip && o.ipHost === hostname) {
      options.lookup = function (_h, opts, cb) {
        var fam = net.isIPv6(o.ip) ? 6 : 4;
        if (opts && opts.all) cb(null, [{ address: o.ip, family: fam }]); else cb(null, o.ip, fam);
      };
    }

    function done(res) { if (settled) return; settled = true; resolve(res); }
    var finishResp = null, needBody = false; // finishResp existe cuando ya llegaron las cabeceras
    function expire() {
      timedOut = true;
      // Con cabeceras recibidas y sin necesitar el cuerpo, las cabeceras bastan: se cierra con éxito.
      if (finishResp && !needBody) { var f = finishResp; req.destroy(); return f(); }
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
    }
    var deadline = setTimeout(expire, o.timeoutMs);

    var req = lib.request(options, function (res) {
      var ttfb = u.round(Number(process.hrtime.bigint() - t0) / 1e6, 1);
      var tlsInfo = null;
      if (isHttps && res.socket && res.socket.getPeerCertificate) { try { tlsInfo = tlsProbe.describe(res.socket); } catch (e) { tlsInfo = null; } }
      var bytes = 0, chunks = [], wantBody = !!o.keyword && o.method !== 'HEAD', aborted = false, truncated = false;
      res.on('data', function (c) {
        bytes += c.length;
        if (wantBody && bytes <= MAX_BODY) chunks.push(c);
        if (bytes > MAX_BODY) { truncated = true; res.destroy(); }
      });
      needBody = wantBody;
      res.on('aborted', function () { aborted = true; });
      function end() {
        clearTimeout(deadline);
        // Solo si se necesita el cuerpo (palabra clave) importa que venza el plazo o que llegue incompleto;
        // si no, las cabeceras bastan. Exceder MAX_BODY a propósito no es un fallo.
        if (wantBody && timedOut) return done({ error: u.friendlyError({ code: 'ETIMEOUT' }) });
        if (wantBody && !truncated && (aborted || res.complete === false)) return done({ error: 'respuesta incompleta (conexión cortada a mitad del cuerpo)' });
        var total = u.round(Number(process.hrtime.bigint() - t0) / 1e6, 1);
        var body = wantBody ? Buffer.concat(chunks).toString('utf8') : null;
        if (o.jar) storeCookies(o.jar, hostname, res.headers['set-cookie']);
        done({ status: res.statusCode, statusText: res.statusMessage || '', location: res.headers.location || null,
               ttfbMs: ttfb, totalMs: total, bytes: bytes, tls: tlsInfo, body: body });
      }
      finishResp = end;
      res.on('end', end);
      res.on('close', end);
      res.on('error', function () { aborted = true; end(); });
    });
    req.on('timeout', expire);
    req.on('error', function (e) {
      clearTimeout(deadline);
      // Cortes tras las cabeceras no invalidan el resultado si no se necesitaba el cuerpo.
      if (finishResp && !needBody) return finishResp();
      done({ error: u.friendlyError(e) });
    });
    req.end();
  });
}

async function probe(address, cfg, resolvedIp) {
  cfg = cfg || {};
  var timeoutMs = cfg.timeoutMs || 8000;
  var method = cfg.method === 'HEAD' ? 'HEAD' : 'GET';
  var current;
  try { current = new URL(address); } catch (e) { return { http: { error: 'URL no válida' }, tls: null }; }
  var firstHost = current.hostname.replace(/^\[|\]$/g, '');
  var redirects = 0, started = Date.now(), r = null, jar = {}, chain = [], tooMany = false;

  for (;;) {
    var left = Math.max(500, timeoutMs - (Date.now() - started));
    r = await one(current, { method: method, timeoutMs: left, ip: resolvedIp, ipHost: firstHost, keyword: cfg.keyword, browser: !!cfg.browser, jar: jar });
    if (r.error) break;
    chain.push({ url: current.href, status: r.status });
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (redirects >= MAX_REDIRECTS) { tooMany = true; break; }
      try { current = new URL(r.location, current); } catch (e) { break; }
      if (current.protocol !== 'http:' && current.protocol !== 'https:') break;
      redirects++;
      continue;
    }
    break;
  }

  if (r.error) return { http: { error: r.error, redirects: redirects, finalUrl: current.href, chain: chain }, tls: null };
  if (tooMany) return { http: { error: 'Demasiadas redirecciones (más de ' + MAX_REDIRECTS + '): el sitio redirige en bucle', status: r.status, redirects: redirects, finalUrl: current.href, chain: chain }, tls: null };
  var h = { status: r.status, statusText: r.statusText, ttfbMs: r.ttfbMs, totalMs: r.totalMs, bytes: r.bytes,
            redirects: redirects, finalUrl: current.href, chain: chain };
  if (cfg.keyword && r.body != null) h.keywordFound = r.body.indexOf(cfg.keyword) >= 0;
  return { http: h, tls: r.tls };
}

module.exports = { probe: probe };
