#!/usr/bin/env node
'use strict';
/*
 * Agente de Centinela: expone las métricas del servidor donde corre (CPU, RAM, discos, I/O wait,
 * red y servicios) por HTTP para que el dashboard las consulte.
 *
 * Instalación en un servidor remoto: copia esta carpeta (agent.js + sysmetrics.js) y ejecuta
 *     CENTINELA_AGENT_TOKEN=UN_SECRETO_LARGO node agent.js --port 9100 --host 10.0.0.5
 * Uso: node agent.js [--port 9100] [--host IP_DE_ESCUCHA] [--token SECRETO]
 *   --host   interfaz donde escuchar (recomendado: la IP por la que te alcanza el dashboard; por defecto 0.0.0.0).
 *   --token  secreto compartido; es preferible la variable CENTINELA_AGENT_TOKEN, porque --token se ve en `ps`.
 * En el dashboard, en el objetivo de ese servidor, activa "Agente" con el mismo puerto y token.
 *
 * Seguridad: si escucha en una interfaz que no sea 127.0.0.1, exige token.
 * Limita el acceso al puerto con el firewall a la IP del dashboard.
 */
var http = require('http');
var crypto = require('crypto');
var metrics = require('./sysmetrics');

function arg(name, fallback) {
  var i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

var PORT = parseInt(arg('port', process.env.CENTINELA_AGENT_PORT || '9100'), 10);
var HOST_GIVEN = process.argv.indexOf('--host') > -1 || !!process.env.CENTINELA_AGENT_HOST;
var HOST = arg('host', process.env.CENTINELA_AGENT_HOST || '0.0.0.0');
// La variable de entorno tiene prioridad: no queda visible en la lista de procesos.
var TOKEN = process.env.CENTINELA_AGENT_TOKEN || arg('token', '');
var LOOPBACK = /^(127\.|::1$|localhost$)/.test(HOST);

if (!TOKEN && !LOOPBACK) {
  console.error('Por seguridad, el agente exige --token (o CENTINELA_AGENT_TOKEN) cuando escucha fuera de 127.0.0.1.');
  process.exit(1);
}

// Límite de fallos de token: 10 por IP y por minuto; superado, responde 429.
var FAIL_MAX = 10, FAIL_WINDOW_MS = 60 * 1000;
var fails = new Map(); // ip -> { n, start }

function clientIp(req) { return (req.socket && req.socket.remoteAddress) || '?'; }
function blocked(ip) {
  var f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.start > FAIL_WINDOW_MS) { fails.delete(ip); return false; }
  return f.n >= FAIL_MAX;
}
function registerFail(ip) {
  var now = Date.now(), f = fails.get(ip);
  if (!f || now - f.start > FAIL_WINDOW_MS) {
    if (fails.size > 5000) { // poda simple para que el mapa no crezca sin límite
      fails.forEach(function (v, k) { if (now - v.start > FAIL_WINDOW_MS) fails.delete(k); });
      if (fails.size > 5000) { // sigue lleno: se expulsan las más antiguas (el Map conserva el orden de inserción)
        var excess = fails.size - 5000, it = fails.keys();
        while (excess-- > 0) { var old = it.next(); if (old.done) break; fails.delete(old.value); }
      }
    }
    f = { n: 0, start: now };
    fails.set(ip, f);
  }
  f.n++;
}

function authorized(req) {
  if (!TOKEN) return true;
  var h = req.headers.authorization || '';
  var given = h.indexOf('Bearer ') === 0 ? h.slice(7) : '';
  var a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function handle(req, res) {
  var url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return send(res, 400, { error: 'petición no válida' }); }
  if (req.method !== 'GET') return send(res, 405, { error: 'método no permitido' });
  var ip = clientIp(req);
  if (blocked(ip)) return send(res, 429, { error: 'demasiados intentos fallidos, espera un minuto' });
  if (!authorized(req)) { registerFail(ip); return send(res, 401, { error: 'token inválido' }); }
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  if (url.pathname === '/metrics') {
    var names = (url.searchParams.get('services') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return Promise.resolve().then(function () { return metrics.collect(names); })
      .then(function (m) { send(res, 200, m); },
            function (e) { send(res, 500, { error: String(e && e.message || e) }); })
      .catch(function () { try { res.destroy(); } catch (e2) { /* sin acción */ } });
  }
  send(res, 404, { error: 'no encontrado' });
}

var server = http.createServer(function (req, res) {
  // Errores del socket de la petición o de la respuesta (cliente que corta): no deben tumbar el agente.
  req.on('error', function () {});
  res.on('error', function () {});
  try { handle(req, res); }
  catch (e) {
    try { if (!res.headersSent) send(res, 500, { error: 'error interno' }); else res.destroy(); } catch (e2) { /* sin acción */ }
  }
});
server.on('clientError', function (err, socket) {
  try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch (e) { /* sin acción */ }
});
server.listen(PORT, HOST, function () {
  console.log('Agente Centinela escuchando en http://' + HOST + ':' + PORT + '  (token ' + (TOKEN ? 'activo' : 'desactivado') + ')');
  if (!HOST_GIVEN) console.warn('Aviso: escuchando en todas las interfaces (0.0.0.0). Se recomienda indicar --host con la IP por la que te alcanza el dashboard.');
  if (process.argv.indexOf('--token') > -1 && !process.env.CENTINELA_AGENT_TOKEN) console.warn('Aviso: --token es visible en la lista de procesos; usa la variable CENTINELA_AGENT_TOKEN.');
});
