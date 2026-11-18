'use strict';
/*
 * Arranca server/server.js como proceso hijo en 127.0.0.1 con puerto libre y datos temporales,
 * y ofrece un cliente HTTP mínimo (http.request, para poder fijar Host y Origin libremente).
 */
var http = require('http');
var net = require('net');
var path = require('path');
var fs = require('fs');
var spawn = require('child_process').spawn;
var tmp = require('./tmp');

var hijos = new Set();
// Red de seguridad: si el proceso de prueba termina de forma abrupta, no quedan servidores huérfanos.
process.on('exit', function () { hijos.forEach(function (c) { matar(c); }); });

// Mata el proceso y todo su grupo (el servidor se lanza con detached para que sus nietos, p. ej. un traceroute
// simulado, tampoco queden huérfanos). En Windows no hay grupos: se mata solo el hijo.
function matar(c) {
  try { if (process.platform !== 'win32' && c.pid) process.kill(-c.pid, 'SIGKILL'); else c.kill('SIGKILL'); }
  catch (e) { try { c.kill('SIGKILL'); } catch (e2) { /* ya terminó */ } }
}

var SERVER_JS = path.join(__dirname, '..', '..', 'server', 'server.js');

function freePort() {
  return new Promise(function (resolve, reject) {
    var s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { resolve(p); }); });
  });
}

/*
 * opts.env: variables extra. opts.dir: reutiliza un directorio de datos (no se borra al parar; lo gestiona quien lo pasa).
 * Los objetivos iniciales se dejan vacíos para no sondear Internet con la semilla.
 * Las variables CENTINELA_ADMIN_* del entorno del proceso de prueba no se heredan salvo que se pasen en opts.env.
 */
async function startServer(opts) {
  // freePort() suelta el puerto antes de que el hijo lo enlace: otro proceso de la suite puede quedárselo (EADDRINUSE).
  // Se reintenta hasta 3 veces; cada intento fallido ya llamó a handle.stop() (borra solo el directorio propio, nunca opts.dir).
  var ultimo;
  for (var intento = 1; intento <= 3; intento++) {
    try { return await arrancarUnaVez(opts); }
    catch (e) {
      ultimo = e;
      if (!/EADDRINUSE/.test(String(e && e.message))) throw e;
    }
  }
  throw ultimo;
}

async function arrancarUnaVez(opts) {
  opts = opts || {};
  var dir = opts.dir || tmp.mkTmp('centinela-api-');
  var propio = !opts.dir;
  if (propio) fs.writeFileSync(path.join(dir, 'targets.json'), '[]');
  var port = await freePort();
  var base = Object.assign({}, process.env);
  ['CENTINELA_ADMIN_USER', 'CENTINELA_ADMIN_PASSWORD', 'CENTINELA_AUTH', 'CENTINELA_ALLOWED_HOSTS', 'CENTINELA_COOKIE_SECURE',
   'CENTINELA_CHECK_TIMEOUT_MS'].forEach(function (k) { delete base[k]; });
  var env = Object.assign(base, { CENTINELA_DATA: dir, PORT: String(port), HOST: '127.0.0.1' }, opts.env || {});
  var child = spawn(process.execPath, [SERVER_JS], { env: env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  hijos.add(child);
  child.once('exit', function () { hijos.delete(child); });
  var log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });

  var handle = {
    port: port, dir: dir, child: child, log: function () { return log; },
    stop: function () {
      return new Promise(function (resolve) {
        function end() { if (propio) tmp.rmTmp(dir); resolve(); }
        if (child.exitCode !== null || child.signalCode) return end();
        child.once('exit', end);
        matar(child);
      });
    },
    request: function (method, p, o) { return request(port, method, p, o); },
    // Contraseña inicial aleatoria impresa en el log de arranque (null si no se generó).
    adminPassword: function () { var m = /Contraseña:\s+(\S+)/.exec(log); return m ? m[1] : null; }
  };
  try {
    await new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('El servidor no arrancó en 10 s. Salida:\n' + log)); }, 10000);
      child.once('exit', function (c) { clearTimeout(t); reject(new Error('El servidor terminó (código ' + c + '). Salida:\n' + log)); });
      (function poll() {
        request(port, 'GET', '/api/health').then(function () { clearTimeout(t); resolve(); },
          function () { setTimeout(poll, 100); });
      })();
    });
  } catch (e) { await handle.stop(); throw e; }
  return handle;
}

/*
 * o.headers, o.body (objeto -> JSON; string -> tal cual), o.json=false para no fijar Content-Type,
 * o.cookie. Devuelve { status, headers, text, json }.
 */
function request(port, method, p, o) {
  o = o || {};
  return new Promise(function (resolve, reject) {
    var headers = Object.assign({}, o.headers || {});
    var payload = null;
    if (o.body !== undefined) {
      payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
      if (o.json !== false && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (o.cookie) headers.Cookie = o.cookie;
    var req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: headers, agent: false, localAddress: o.localAddress }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var text = Buffer.concat(chunks).toString('utf8'), json = null;
        try { json = JSON.parse(text); } catch (e) { /* no era JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
      });
    });
    req.setTimeout(15000, function () { req.destroy(new Error('tiempo agotado en la petición de prueba')); });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Extrae "nombre=valor" de la cabecera Set-Cookie.
function cookieOf(res) {
  var sc = res.headers['set-cookie'];
  return sc && sc[0] ? sc[0].split(';')[0] : null;
}

/* Envía texto HTTP crudo (para Host malformados, cuerpos fraccionados...) y devuelve { status, head, body, text }. */
function rawHttp(port, text, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    var datos = '', s = net.connect(port, '127.0.0.1', function () { s.write(text); });
    var t = setTimeout(function () { s.destroy(); }, opts.timeoutMs || 5000);
    s.on('data', function (d) { datos += d; });
    s.on('error', function (e) { clearTimeout(t); reject(e); });
    s.on('close', function () {
      clearTimeout(t);
      // Se descartan las respuestas informativas previas (1xx, p. ej. "100 Continue" tras Expect: 100-continue).
      var util = datos.replace(/^(?:HTTP\/1\.[01] 1\d\d[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n)+/, '');
      var i = util.indexOf('\r\n\r\n'), m = /^HTTP\/1\.[01] (\d{3})/.exec(util);
      resolve({ status: m ? Number(m[1]) : 0, head: i < 0 ? util : util.slice(0, i), body: i < 0 ? '' : util.slice(i + 4), text: datos });
    });
    if (opts.onOpen) opts.onOpen(s);
  });
}

/*
 * Abre /api/stream (SSE). Resuelve con { status, closed(), whenClosed(ms), close() } al recibir las cabeceras.
 * o.cookie, o.localAddress, o.headers (cabeceras extra). Si el estado no es 200 el cuerpo ya está leído en .text/.json.
 */
function openStream(port, o) {
  o = o || {};
  return new Promise(function (resolve, reject) {
    var headers = Object.assign({ Accept: 'text/event-stream' }, o.headers || {});
    if (o.cookie) headers.Cookie = o.cookie;
    var req = http.request({ host: '127.0.0.1', port: port, method: 'GET', path: '/api/stream', headers: headers, agent: false,
                             localAddress: o.localAddress }, function (res) {
      var cerrado = false, esperando = [];
      function marcar() { if (cerrado) return; cerrado = true; esperando.splice(0).forEach(function (f) { f(true); }); }
      var h = { status: res.statusCode, headers: res.headers, text: '', json: null,
        closed: function () { return cerrado; },
        // Resuelve true si el flujo se cierra dentro de ms; false si sigue abierto.
        whenClosed: function (ms) {
          if (cerrado) return Promise.resolve(true);
          return new Promise(function (r) {
            var f = function (v) { clearTimeout(t); r(v); };
            var t = setTimeout(function () { var i = esperando.indexOf(f); if (i >= 0) esperando.splice(i, 1); r(false); }, ms);
            esperando.push(f);
          });
        },
        close: function () { try { req.destroy(); } catch (e) { /* ya cerrado */ } }
      };
      res.on('data', function (c) { h.text += c; });
      res.on('end', function () { try { h.json = JSON.parse(h.text); } catch (e) { /* SSE */ } marcar(); });
      res.on('close', marcar);
      res.on('error', marcar);
      if (res.statusCode !== 200) { res.on('end', function () { resolve(h); }); } else resolve(h);
    });
    req.on('error', function (e) { reject(e); });
    req.end();
  });
}

module.exports = { startServer: startServer, request: request, cookieOf: cookieOf, freePort: freePort, rawHttp: rawHttp, openStream: openStream };
