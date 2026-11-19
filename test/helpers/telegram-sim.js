'use strict';
/*
 * Servidor de Telegram simulado (solo loopback, sin red externa). Imita la parte de la Bot API que usa Centinela:
 * POST /bot<TOKEN>/sendMessage, getMe y getUpdates. Registra cada petición (ruta, cuerpo e instante) y permite
 * programar las respuestas: 200, 400, 401, 403, 404, 409, 429 (con parameters.retry_after), 5xx, silencio, JSON
 * inválido, respuestas enormes o redirecciones.
 *
 * Uso:
 *   var sim = await telegramSim.start();
 *   sim.base                       // 'http://127.0.0.1:<puerto>' (valor de CENTINELA_TELEGRAM_API_BASE)
 *   sim.on('sendMessage', R.error(429, 'Too Many Requests: retry after 1', { retry_after: 1 }));  // una vez
 *   sim.on('sendMessage', [R.error(500), R.ok()]);                                              // en orden
 *   sim.setDefault('sendMessage', R.silence());                                                  // por omisión
 *   sim.setUpdates([...]);         // lo que devuelve getUpdates
 *   sim.sent()                     // peticiones sendMessage registradas
 *   await sim.close();
 */
var http = require('http');

// Constructores de respuestas programables.
var R = {
  ok: function (result) { return { status: 200, body: { ok: true, result: result === undefined ? true : result } }; },
  error: function (status, description, parameters) {
    var b = { ok: false, error_code: status, description: description || ('Error ' + status) };
    if (parameters) b.parameters = parameters;
    return { status: status, body: b };
  },
  // 429 con retry_after en segundos.
  retryAfter: function (s) { return R.error(429, 'Too Many Requests: retry after ' + s, { retry_after: s }); },
  // 400 de grupo migrado a supergrupo.
  migrate: function (newId) { return R.error(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: newId }); },
  chatNotFound: function () { return R.error(400, 'Bad Request: chat not found'); },
  silence: function () { return { silence: true }; },                       // acepta la conexión y nunca responde
  invalidJson: function (status) { return { status: status || 200, raw: '<html>no es JSON</html>' }; },
  big: function (bytes) { return { status: 200, raw: '{"ok":true,"result":"' + new Array(bytes + 1).join('x') + '"}' }; },
  redirect: function (to) { return { status: 302, headers: { Location: to || 'http://127.0.0.1:1/' }, raw: '' }; },
  delayed: function (ms, spec) { return Object.assign({}, spec || R.ok(), { delayMs: ms }); },
  destroy: function () { return { destroy: true }; }                          // cierra el socket sin responder
};

var API_METHODS = ['sendMessage', 'getMe', 'getUpdates'];

function start() {
  var requests = [], seq = 0, socks = new Set(), pendientes = new Set(), timers = new Set();
  var queues = {}, defaults = {}, updates = [], messageId = 100, cerrado = false;
  var sim = { requests: requests, R: R, validToken: null };

  function reset() {
    requests.length = 0; queues = {}; defaults = {}; updates = [];
    API_METHODS.forEach(function (m) { queues[m] = []; });
    sim.validToken = null;
  }
  reset();

  function sendSpec(res, spec) {
    if (spec.destroy) { res.socket.destroy(); return; }
    if (spec.silence) { pendientes.add(res); return; }
    var h = Object.assign({ 'Content-Type': 'application/json' }, spec.headers || {});
    var payload = spec.raw !== undefined ? spec.raw : JSON.stringify(spec.body === undefined ? {} : spec.body);
    res.writeHead(spec.status || 200, h);
    res.end(payload);
  }

  var server = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var raw = Buffer.concat(chunks).toString('utf8'), body = null;
      try { body = JSON.parse(raw); } catch (e) { body = null; }
      var m = /^\/bot([^\/]*)\/([A-Za-z]+)$/.exec(req.url.split('?')[0]);
      var rec = { n: ++seq, t: Date.now(), httpMethod: req.method, url: req.url, headers: req.headers,
                  token: m ? m[1] : null, apiMethod: m ? m[2] : null, raw: raw, body: body };
      requests.push(rec);
      var spec;
      if (!m || API_METHODS.indexOf(m[2]) < 0) spec = R.error(404, 'Not Found');
      else if (sim.validToken && m[1] !== sim.validToken) spec = R.error(401, 'Unauthorized');
      else if (queues[m[2]].length) spec = queues[m[2]].shift();
      else if (defaults[m[2]]) spec = defaults[m[2]];
      else if (m[2] === 'getMe') spec = R.ok({ id: 1, is_bot: true, username: 'centinela_test_bot' });
      else if (m[2] === 'getUpdates') spec = R.ok(updates);
      else spec = R.ok({ message_id: ++messageId });
      rec.respuesta = spec;
      if (spec.delayMs) {
        var t = setTimeout(function () { timers.delete(t); if (!cerrado) sendSpec(res, spec); }, spec.delayMs);
        timers.add(t);
      } else sendSpec(res, spec);
    });
  });
  server.on('connection', function (s) { socks.add(s); s.on('close', function () { socks.delete(s); }); });

  sim.on = function (apiMethod, specs) { queues[apiMethod] = queues[apiMethod].concat(Array.isArray(specs) ? specs : [specs]); return sim; };
  sim.setDefault = function (apiMethod, spec) { defaults[apiMethod] = spec; return sim; };
  sim.setUpdates = function (list) { updates = list; return sim; };
  sim.reset = reset;
  // Peticiones registradas de un método de la API (sin argumento: todas).
  sim.calls = function (apiMethod) { return requests.filter(function (r) { return !apiMethod || r.apiMethod === apiMethod; }); };
  sim.sent = function () { return sim.calls('sendMessage'); };
  sim.texts = function () { return sim.sent().map(function (r) { return r.body && r.body.text; }); };
  sim.close = function () {
    cerrado = true;
    timers.forEach(function (t) { clearTimeout(t); });
    pendientes.forEach(function (r) { try { r.socket.destroy(); } catch (e) { /* ya cerrado */ } });
    socks.forEach(function (s) { s.destroy(); });
    return new Promise(function (resolve) { server.close(function () { resolve(); }); });
  };

  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      sim.port = server.address().port;
      sim.base = 'http://127.0.0.1:' + sim.port;
      resolve(sim);
    });
  });
}

// Updates de ejemplo para getUpdates.
function updMessage(chatId, type, title, extra) { return { update_id: Math.abs(chatId) % 100000, message: Object.assign({ message_id: 1, date: 1, chat: { id: chatId, type: type, title: title }, text: 'hola' }, extra || {}) }; }

module.exports = { start: start, R: R, updMessage: updMessage };
