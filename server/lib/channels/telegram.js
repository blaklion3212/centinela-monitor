'use strict';
/*
 * Canal de Telegram (Bot API). Solo red: no conoce objetivos ni la configuración de Centinela.
 * Reglas de seguridad: el token solo viaja en la ruta de la petición; ningún mensaje devuelto
 * incluye la URL, options.path ni err.message; todo texto pasa por redact. Se valida el
 * certificado TLS (nunca se desactiva) y no se siguen redirecciones.
 */
var http = require('http');
var https = require('https');
var net = require('net');
var alertsCfg = require('../alerts-config');

var DEFAULT_BASE = 'https://api.telegram.org';
var TG_MAX_TEXT = 4096;
var MAX_CHATS = 20;
// Igual que el de la configuración: el token se inserta en la ruta, solo con letras, dígitos, _ y -.
var TOKEN_PATH_RE = /^[1-9]\d{0,17}:[A-Za-z0-9_-]{30,}$/;
var NO_INTERNET = { ECONNREFUSED: 1, ENOTFOUND: 1, EAI_AGAIN: 1, ENETUNREACH: 1 };

/* ---- saneado de texto ---- */

// Sustituye el token (y /bot<algo>/) por bot***; también su parte numérica de bot.
function redact(str, token) {
  var s = str == null ? '' : String(str);
  if (typeof token === 'string' && token) {
    s = s.split(token).join('bot***');
    var id = token.split(':')[0];
    if (id && id.length >= 6) s = s.split(id).join('***');
  }
  s = s.replace(/\/bot[^\/\s"'?]*/g, '/bot***');
  s = s.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot***');
  return s;
}

/* ---- clasificación de respuestas (pura) ---- */

var MSG = {
  invalid_token: function (st) { return 'Telegram rechazó el token (' + st + '): revisa que lo copiaste completo desde @BotFather'; },
  chat_not_found: function () { return 'Telegram no encuentra ese chat: escríbele primero al bot o añádelo al grupo y usa “Buscar mis chats”'; },
  migrated: function () { return 'El grupo pasó a supergrupo y Telegram cambió su identificador: se actualiza el chat guardado'; },
  blocked: function () { return 'El bot fue bloqueado o expulsado de ese chat: desbloquéalo o vuelve a añadirlo, o elige otro chat'; },
  chat_is_bot: function () { return 'Ese destino es un bot (quizá el propio bot): Telegram no deja que un bot escriba a otro. Escríbele al bot desde tu cuenta y elige tu chat con “Buscar mis chats”'; },
  not_started: function () { return 'Esa persona aún no ha iniciado el chat con el bot: abre el bot en Telegram, pulsa “Iniciar” (/start) y reintenta'; },
  no_internet: function () { return 'No hay conexión con api.telegram.org: el servidor necesita salida a Internet por el puerto 443'; },
  timeout: function () { return 'Telegram no respondió a tiempo: comprueba la conexión del servidor a Internet e inténtalo de nuevo'; },
  rate_limited: function (s) { return 'Telegram pide esperar' + (s ? ' ' + s + ' s' : ' un momento') + ' antes de enviar más mensajes: se reintentará automáticamente'; },
  unknown: function () { return 'Respuesta inesperada de Telegram: inténtalo de nuevo más tarde'; }
};

function fail(code, message, transient, extra) {
  var r = { ok: false, code: code, message: message, transient: !!transient };
  if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) r[k] = extra[k]; });
  return r;
}

// classify(status, body, err) -> { ok:true, result } | { ok:false, code, message, transient, ... }
// body puede ser el objeto ya analizado o el texto crudo; err = { code?, timedOut? } si no hubo respuesta.
function classify(status, body, err) {
  if (err) {
    if (err.timedOut || err.code === 'ETIMEDOUT') return fail('timeout', MSG.timeout(), true);
    if (err.code && NO_INTERNET[err.code]) return fail('no_internet', MSG.no_internet(), true);
    var c = typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? ' (' + err.code + ')' : '';
    return fail('unknown', 'Error de red al contactar con Telegram' + c + ': inténtalo de nuevo más tarde', true);
  }
  status = Number(status) || 0;
  if (status >= 300 && status < 400) return fail('unknown', MSG.unknown(), false, { status: status }); // sin seguir redirecciones
  var json = body;
  var parsed = true;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try { json = JSON.parse(String(body)); } catch (e) { json = null; parsed = false; }
  }
  var obj = json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  var params = obj && obj.parameters && typeof obj.parameters === 'object' ? obj.parameters : {};

  if (status === 200) {
    if (obj && obj.ok === true) return { ok: true, result: obj.result };
    return fail('unknown', MSG.unknown(), false, { status: status });
  }
  if (status === 429) {
    var ra = Number(params.retry_after);
    ra = isFinite(ra) && ra >= 0 ? Math.ceil(ra) : undefined;
    return fail('rate_limited', MSG.rate_limited(ra), true, { retryAfterS: ra, status: status });
  }
  if (status >= 500) return fail('unknown', 'Telegram tuvo un fallo temporal (' + status + '): se reintentará', true, { status: status });
  if (status === 401 || status === 404) return fail('invalid_token', MSG.invalid_token(status), false, { status: status });
  if (status === 403) {
    // Se distinguen dos 403 frecuentes por su descripción (sin depender de ella para nada más).
    var d403 = obj && typeof obj.description === 'string' ? obj.description : '';
    if (/bots? can'?t send messages to bots/i.test(d403)) return fail('chat_is_bot', MSG.chat_is_bot(), false, { status: status });
    if (/can'?t initiate conversation/i.test(d403)) return fail('not_started', MSG.not_started(), false, { status: status });
    return fail('blocked', MSG.blocked(), false, { status: status });
  }
  if (status === 400) {
    var mig = params.migrate_to_chat_id;
    if (mig !== undefined && mig !== null) {
      // Se normaliza a entero y se valida; si no es un id de chat válido se trata como desconocido (sin registrar el valor).
      var ms = typeof mig === 'number' || typeof mig === 'string' ? String(mig).trim() : '';
      if (/^-?[1-9]\d{0,19}$/.test(ms) && alertsCfg.validateChatId(ms)) return fail('chat_not_found', MSG.migrated(), false, { migrateTo: Number(ms), status: status });
      return fail('unknown', 'Telegram rechazó la petición (400)', false, { status: status });
    }
    var desc = obj && typeof obj.description === 'string' ? obj.description : '';
    if (/chat not found/i.test(desc)) return fail('chat_not_found', MSG.chat_not_found(), false, { status: status });
    return fail('unknown', 'Telegram rechazó la petición (400)' + (desc ? ': ' + redact(desc, '').slice(0, 200) : ''), false, { status: status });
  }
  if (status === 409) return fail('unknown', 'Telegram informa de un conflicto (409): hay un webhook activo u otro proceso leyendo el bot; usa un bot dedicado para Centinela', false, { status: status });
  if (!parsed) return fail('unknown', MSG.unknown(), false, { status: status });
  return fail('unknown', 'Telegram respondió con un error inesperado (' + status + ')', false, { status: status });
}

/* ---- chats desde getUpdates ---- */

function chatTitle(chat) {
  if (typeof chat.title === 'string' && chat.title) return chat.title;
  var n = [chat.first_name, chat.last_name].filter(function (x) { return typeof x === 'string' && x; }).join(' ');
  if (n) return n;
  if (typeof chat.username === 'string' && chat.username) return '@' + chat.username;
  return String(chat.id);
}

// -> [{ id, type, title, username? }] deduplicados, máximo 20. Solo se toma el chat, no el contenido de los mensajes.
function chatsFromUpdates(updates) {
  var out = [], seen = {};
  (Array.isArray(updates) ? updates : []).forEach(function (u) {
    if (!u || typeof u !== 'object') return;
    ['message', 'channel_post', 'my_chat_member', 'edited_message'].forEach(function (k) {
      var chat = u[k] && u[k].chat;
      if (!chat || typeof chat !== 'object' || out.length >= MAX_CHATS) return;
      if (typeof chat.id !== 'number' || !isFinite(chat.id)) return;
      var key = String(chat.id);
      if (Object.prototype.hasOwnProperty.call(seen, key)) return;
      seen[key] = true;
      var item = { id: chat.id, type: String(chat.type || '').slice(0, 20), title: chatTitle(chat).slice(0, 100) };
      if (typeof chat.username === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(chat.username)) item.username = chat.username;
      out.push(item);
    });
  });
  return out;
}

/* ---- base de la API ---- */

// -> { base: URL ya normalizada, warning? }. http solo hacia loopback; https hacia cualquiera.
function resolveBase(apiBase) {
  if (apiBase == null || apiBase === '') return { url: new URL(DEFAULT_BASE) };
  var bad = { url: new URL(DEFAULT_BASE), warning: 'La base alternativa de la API de Telegram no es válida (solo http hacia 127.0.0.1, localhost o ::1, o https): se usa la predeterminada' };
  var u;
  try { u = new URL(String(apiBase)); } catch (e) { return bad; }
  if (u.username || u.password || u.search || u.hash) return bad;
  if (u.protocol === 'https:') return { url: u };
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) return { url: u };
  return bad;
}

/* ---- creación del canal ---- */

function create(opts) {
  opts = opts || {};
  var base = resolveBase(opts.apiBase);
  var timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
  var maxBody = Number(opts.maxBodyBytes) > 0 ? Number(opts.maxBodyBytes) : 262144;
  var mods = { 'http:': (opts.httpModules && opts.httpModules.http) || http, 'https:': (opts.httpModules && opts.httpModules.https) || https };
  var autoFamily = typeof net.getDefaultAutoSelectFamily === 'function';
  var basePath = base.url.pathname.replace(/\/+$/, '');
  var hostname = base.url.hostname.replace(/^\[|\]$/g, '');

  function request(token, method, payload) {
    return new Promise(function (resolve) {
      if (typeof token !== 'string' || token.length > 80 || !TOKEN_PATH_RE.test(token)) {
        return resolve(fail('invalid_token', MSG.invalid_token(401), false));
      }
      var data = Buffer.from(JSON.stringify(payload || {}), 'utf8');
      var done = false, timedOut = false, timer = null, req = null;

      function finish(r) {
        if (done) return;
        done = true; clearTimeout(timer);
        // Defensa final: ningún texto devuelto conserva el token.
        if (r && r.message) r.message = redact(r.message, token);
        resolve(r);
      }

      var o = {
        method: 'POST', hostname: hostname, port: base.url.port || undefined,
        path: basePath + '/bot' + token + '/' + method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        agent: false
      };
      if (autoFamily) o.autoSelectFamily = true;

      try {
        req = mods[base.url.protocol].request(o, function (res) {
          var chunks = [], size = 0, truncated = false;
          res.on('data', function (c) {
            if (truncated) return;
            size += c.length;
            if (size > maxBody) { truncated = true; res.destroy(); return; }
            chunks.push(c);
          });
          function end() {
            if (done) return;
            var st = res.statusCode;
            if (truncated) return finish(classify(st, null)); // respuesta desmesurada: se descarta
            finish(classify(st, Buffer.concat(chunks).toString('utf8')));
          }
          res.on('end', end);
          res.on('close', end);
          res.on('error', function (e) { finish(classify(0, null, { code: e && e.code })); });
        });
      } catch (e) {
        return finish(classify(0, null, { code: e && e.code }));
      }
      req.on('error', function (e) { finish(classify(0, null, { code: e && e.code, timedOut: timedOut })); });
      // Plazo total de la petición (RA-36), no solo de inactividad.
      timer = setTimeout(function () { timedOut = true; finish(classify(0, null, { timedOut: true })); req.destroy(); }, timeoutMs);
      req.end(data);
    });
  }

  return {
    apiBase: base.url.origin + basePath,
    baseWarning: base.warning,
    sendMessage: function (token, chatId, text, o) {
      var t = String(text == null ? '' : text);
      if (t.length > TG_MAX_TEXT) {
        var cut = TG_MAX_TEXT - 1;
        var last = t.charCodeAt(cut - 1);
        if (last >= 0xD800 && last <= 0xDBFF) cut--; // no partir un par sustituto
        t = t.slice(0, cut) + '…';
      }
      var p = { chat_id: String(chatId), text: t, link_preview_options: { is_disabled: true } };
      if (o && o.silent === true) p.disable_notification = true;
      return request(token, 'sendMessage', p);
    },
    getMe: function (token) { return request(token, 'getMe', {}); },
    // Sin offset ni allowed_updates (anexo A): no confirma ni borra actualizaciones.
    getUpdates: function (token) { return request(token, 'getUpdates', { timeout: 0 }); }
  };
}

module.exports = { create: create, chatsFromUpdates: chatsFromUpdates, redact: redact, classify: classify, TG_MAX_TEXT: TG_MAX_TEXT };
