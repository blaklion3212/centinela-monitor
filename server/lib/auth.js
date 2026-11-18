'use strict';
/*
 * Usuarios, contraseñas y sesiones.
 *   - data/users.json guarda los usuarios; las contraseñas se guardan con scrypt (sal aleatoria), nunca en claro.
 *   - Sesión: cookie HttpOnly con un identificador aleatorio; las sesiones viven en memoria (se pierden al reiniciar).
 *   - Roles: admin (todo, incluye usuarios) · operator (edita objetivos, organizaciones, ajustes y ventanas) · viewer (solo lectura).
 *   - Límite de intentos: 5 fallos por usuario+IP bloquean 60 s; más de 20 fallos por IP en 10 min dan 429 sin calcular hash.
 *   - Los intentos se reservan ANTES de calcular el hash (cuentan como fallo pendiente y se anulan si resultan correctos),
 *     así una ráfaga paralela no obtiene más verificaciones que el límite.
 *   - El hash scrypt es asíncrono (no bloquea el event loop) y hay un máximo de 4 cálculos simultáneos (login, alta, edición y cambio
 *     de contraseña comparten el mismo semáforo; el exceso recibe 429).
 *   - Los cambios se escriben en users.json ANTES de tocar la memoria (se opera sobre una copia).
 *   - Sin CENTINELA_ADMIN_PASSWORD el primer administrador recibe una contraseña aleatoria que se muestra una sola vez al arrancar.
 *   - Sesiones: máx. 10 por usuario, caducidad deslizante de 12 h y absoluta de 7 días.
 */
var crypto = require('crypto');
var storeLib = require('./store');

var ROLES = ['admin', 'operator', 'viewer'];
var SESSION_MS = 12 * 3600 * 1000;       // caducidad con uso (deslizante)
var ABS_SESSION_MS = 7 * 24 * 3600 * 1000; // caducidad absoluta, aunque se use
var MAX_SESSIONS = 500;
var MAX_SESSIONS_PER_USER = 10;
var MAX_LOGINS = 4;                      // logins (hash) simultáneos
var MAX_ATTEMPTS = 2000;                 // tope de entradas del registro de intentos
var ATTEMPT_TTL = 15 * 60 * 1000;        // los contadores sin bloqueo caducan
var IP_MAX_FAILS = 20, IP_WINDOW_MS = 10 * 60 * 1000;
var MAX_USERS = 200;
var LOCK_AFTER = 5, LOCK_MS = 60 * 1000;
var COOKIE = 'centinela_sid';
var MIN_PASSWORD = 8;

var DEFAULT_USER = 'administrador';
var BUSY_MSG = 'Servidor ocupado, intenta de nuevo en unos segundos.';
// Alfabeto sin caracteres ambiguos (sin 0/O, 1/l/I).
var PASS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function randomPassword(len) {
  var out = '', n = PASS_ALPHABET.length, lim = 256 - (256 % n);
  while (out.length < len) {
    var b = crypto.randomBytes(len * 2);
    for (var i = 0; i < b.length && out.length < len; i++) if (b[i] < lim) out += PASS_ALPHABET.charAt(b[i] % n);
  }
  return out;
}

function scryptAsync(pw, salt) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(String(pw), salt, 64, function (err, key) { if (err) reject(err); else resolve(key); });
  });
}
function hashPassword(pw, saltHex) {
  var salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  return scryptAsync(pw, salt).then(function (key) { return { salt: salt.toString('hex'), hash: key.toString('hex') }; });
}
// Versión síncrona: solo para crear el usuario inicial al arrancar.
function hashPasswordSync(pw) {
  var salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') };
}
function verifyPassword(pw, user) {
  return hashPassword(pw, user.salt).then(function (r) {
    return crypto.timingSafeEqual(Buffer.from(r.hash, 'hex'), Buffer.from(user.hash, 'hex'));
  }).catch(function () { return false; });
}

function cleanUsername(v) { return String(v == null ? '' : v).trim(); }
function validUsername(v) { return /^[A-Za-z0-9._@-]{3,32}$/.test(v); }

function create(storeDir) {
  var users = [];
  var sessions = new Map();     // sid -> { userId, exp, abs, created }
  var attempts = new Map();     // clave -> { n, until, last }
  var ipFails = new Map();      // ip -> { n, first }
  var hashActive = 0;           // cálculos de hash en curso (semáforo común)
  var self = null;

  var raw = storeLib.read('users.json');
  if (raw.exists && Array.isArray(raw.value)) {
    raw.value.forEach(function (u) {
      if (u && typeof u.username === 'string' && u.salt && u.hash && ROLES.indexOf(u.role) >= 0)
        users.push({ id: String(u.id), username: u.username, role: u.role, salt: u.salt, hash: u.hash, disabled: !!u.disabled,
                     defaultPassword: !!u.defaultPassword, createdAt: u.createdAt || Date.now(), lastLogin: u.lastLogin || null });
    });
  }
  // Escribe la lista nueva en disco y solo entonces la adopta en memoria (si la escritura lanza, nada cambia).
  function persist(list) { storeLib.write('users.json', list); users = list; }
  function replaceUser(nu) { return users.map(function (x) { return x.id === nu.id ? nu : x; }); }

  var seeded = null;
  if (!users.length) {
    var name = cleanUsername(process.env.CENTINELA_ADMIN_USER) || DEFAULT_USER;
    var pass = process.env.CENTINELA_ADMIN_PASSWORD, generated = null;
    if (!pass) { generated = randomPassword(16); pass = generated; }
    if (!validUsername(name)) name = DEFAULT_USER;
    var hp = hashPasswordSync(pass);
    // Una contraseña generada, o de entorno que no cumple la política, obliga a cambiarla al entrar.
    var weak = !!generated || !!checkPassword(pass);
    if (!generated && weak) console.warn('AVISO: CENTINELA_ADMIN_PASSWORD no cumple la política de contraseñas (' + checkPassword(pass) + ') y deberá cambiarse al entrar.');
    users.push({ id: 'u_' + crypto.randomBytes(5).toString('hex'), username: name, role: 'admin', salt: hp.salt, hash: hp.hash,
                 disabled: false, defaultPassword: weak, createdAt: Date.now(), lastLogin: null });
    persist(users);
    seeded = { username: name, isDefault: weak, generatedPassword: generated };
  }

  function publicUser(u) {
    return { id: u.id, username: u.username, role: u.role, disabled: u.disabled, createdAt: u.createdAt, lastLogin: u.lastLogin,
             mustChange: !!u.defaultPassword };
  }
  function find(id) { return users.filter(function (u) { return u.id === id; })[0] || null; }
  function byName(n) { var l = String(n).toLowerCase(); return users.filter(function (u) { return u.username.toLowerCase() === l; })[0] || null; }
  function activeAdmins() { return users.filter(function (u) { return u.role === 'admin' && !u.disabled; }); }

  function checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return 'La contraseña debe tener al menos ' + MIN_PASSWORD + ' caracteres.';
    if (pw.length > 200) return 'La contraseña es demasiado larga (máx. 200).';
    return null;
  }

  // Elimina una sesión y avisa (p. ej. para cortar sus flujos en vivo).
  function endSession(sid) {
    if (!sessions.delete(sid)) return;
    if (self && typeof self.onSessionsDropped === 'function') { try { self.onSessionsDropped([sid]); } catch (e) { /* el aviso no debe romper la sesión */ } }
  }
  function dropSessions(userId, exceptSid) {
    Array.from(sessions.keys()).forEach(function (sid) {
      var s = sessions.get(sid);
      if (s && s.userId === userId && sid !== exceptSid) endSession(sid);
    });
  }
  function oldestSid(filter) {
    var best = null, bt = Infinity;
    sessions.forEach(function (s, sid) { if (filter(s) && s.created < bt) { bt = s.created; best = sid; } });
    return best;
  }

  function lockKey(name, ip) { return cleanUsername(name).toLowerCase() + '|' + ip; }

  // Registro de intentos: expulsa lo caducado y, si sigue sobre el tope, lo más antiguo (Map conserva el orden de inserción).
  function pruneAttempts(now) {
    attempts.forEach(function (a, k) {
      if (a.until ? a.until <= now : now - a.last > ATTEMPT_TTL) attempts.delete(k);
    });
    ipFails.forEach(function (f, k) { if (now - f.first > IP_WINDOW_MS) ipFails.delete(k); });
    while (attempts.size > MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value);
    while (ipFails.size > MAX_ATTEMPTS) ipFails.delete(ipFails.keys().next().value);
  }
  // Reserva un intento ANTES de calcular el hash (V-05): cuenta como fallo pendiente, de modo que las ráfagas
  // paralelas no superen el límite. Devuelve la referencia para anularlo si el intento resulta correcto.
  function reserve(key, ip, now) {
    failed(key, ip, now);
    return { ipEntry: ipFails.get(ip) };
  }
  // Anula la reserva de un intento correcto: borra el contador de usuario+IP y devuelve el cupo por IP.
  function cancelReserve(key, ip, rsv) {
    attempts.delete(key);
    var f = rsv && rsv.ipEntry;
    if (f && ipFails.get(ip) === f) { if (f.n > 1) f.n--; else ipFails.delete(ip); }
  }
  function failed(key, ip, now) {
    var a = attempts.get(key);
    var n = ((a && !(a.until && a.until <= now)) ? a.n : 0) + 1;
    attempts.delete(key); // reinserta al final para conservar el orden por antigüedad
    attempts.set(key, { n: n, until: n >= LOCK_AFTER ? now + LOCK_MS : 0, last: now });
    var f = ipFails.get(ip);
    if (!f || now - f.first > IP_WINDOW_MS) ipFails.set(ip, { n: 1, first: now }); else f.n++;
    pruneAttempts(now);
  }
  // Bloqueo vigente por IP o por usuario+IP (null si no hay). No calcula ningún hash.
  function blockedBy(key, ip, now) {
    var f = ipFails.get(ip);
    if (f && now - f.first <= IP_WINDOW_MS && f.n > IP_MAX_FAILS) return { error: 'Demasiados intentos desde esta dirección. Espera unos minutos.', status: 429 };
    var a = attempts.get(key);
    if (a && a.until > now) return { error: 'Demasiados intentos. Espera ' + Math.ceil((a.until - now) / 1000) + ' s.', status: 429 };
    return null;
  }
  // Semáforo común de cálculos de hash: acquire() devuelve false si ya hay MAX_LOGINS en curso.
  function acquire() { if (hashActive >= MAX_LOGINS) return false; hashActive++; return true; }
  function release() { if (hashActive > 0) hashActive--; }
  function busy() { return { error: BUSY_MSG, errors: [BUSY_MSG], status: 429 }; }

  // Valida una edición contra el estado VIGENTE del usuario y calcula los campos resultantes.
  function planUpdate(id, input, actorId) {
    var u = find(id);
    if (!u) return { errors: ['Usuario no encontrado.'], status: 404 };
    input = input || {};
    var errors = [];
    var role = input.role != null ? input.role : u.role;
    // `disabled` solo se acepta como booleano; cualquier otro tipo es un error.
    if (input.disabled != null && typeof input.disabled !== 'boolean') errors.push('Valor no válido para deshabilitado.');
    var disabled = typeof input.disabled === 'boolean' ? input.disabled : u.disabled;
    if (ROLES.indexOf(role) < 0) errors.push('Rol no válido.');
    var newName = input.username != null ? cleanUsername(input.username) : u.username;
    if (newName !== u.username) {
      if (!validUsername(newName)) errors.push('El usuario debe tener de 3 a 32 caracteres: letras, números y . _ @ -');
      else if (byName(newName) && byName(newName).id !== u.id) errors.push('Ya existe un usuario con ese nombre.');
    }
    if (input.password) { var pe = checkPassword(input.password); if (pe) errors.push(pe); }
    // Siempre debe quedar al menos un administrador activo.
    var wasAdmin = u.role === 'admin' && !u.disabled, willBeAdmin = role === 'admin' && !disabled;
    if (wasAdmin && !willBeAdmin && activeAdmins().length <= 1) errors.push('Debe quedar al menos un administrador activo.');
    if (id === actorId && disabled) errors.push('No puedes deshabilitar tu propio usuario.');
    if (errors.length) return { errors: errors };
    return { u: u, role: role, disabled: disabled, username: newName };
  }

  self = {
    COOKIE: COOKIE, ROLES: ROLES, SESSION_MS: SESSION_MS, seeded: seeded, MIN_PASSWORD: MIN_PASSWORD,
    count: function () { return users.length; },
    list: function () { return users.map(publicUser); },
    publicUser: publicUser,

    /* ---- inicio y cierre de sesión ---- */
    login: async function (username, password, ip) {
      var key = lockKey(username, ip), now = Date.now();
      pruneAttempts(now);
      var blk = blockedBy(key, ip, now);
      if (blk) return blk;
      if (!acquire()) return { error: BUSY_MSG, status: 429 };
      var rsv = reserve(key, ip, now); // el intento queda contado como fallo hasta que se confirme
      var u, ok;
      try {
        u = byName(cleanUsername(username));
        // Se calcula el hash aunque el usuario no exista, para que el tiempo de respuesta no revele qué usuarios existen.
        if (u) ok = await verifyPassword(password, u);
        else { await hashPassword(password || ''); ok = false; }
      } finally { release(); }
      now = Date.now();
      if (ok) u = find(u.id); // pudo cambiar o borrarse durante el hash
      // Mismo mensaje para usuario inexistente, contraseña errónea o usuario deshabilitado.
      if (!ok || !u || u.disabled) return { error: 'Usuario o contraseña incorrectos.', status: 401 };
      cancelReserve(key, ip, rsv);
      // Primero a disco: si no se puede guardar, no se crea la sesión.
      var nu = Object.assign({}, u, { lastLogin: now });
      try { persist(replaceUser(nu)); }
      catch (e) { console.error('[auth] no se pudo guardar users.json:', e.message); return { error: 'No se pudo completar el inicio de sesión (error de almacenamiento).', status: 500 }; }
      u = nu;
      // Tope por usuario: se expulsa la sesión más antigua del mismo usuario.
      var mine = 0;
      sessions.forEach(function (s) { if (s.userId === u.id) mine++; });
      while (mine >= MAX_SESSIONS_PER_USER) {
        var oldMine = oldestSid(function (s) { return s.userId === u.id; });
        if (!oldMine) break;
        endSession(oldMine); mine--;
      }
      if (sessions.size >= MAX_SESSIONS) { // descarta las más antiguas
        var oldest = oldestSid(function () { return true; });
        if (oldest) endSession(oldest);
      }
      var sid = crypto.randomBytes(32).toString('hex');
      sessions.set(sid, { userId: u.id, exp: now + SESSION_MS, abs: now + ABS_SESSION_MS, created: now });
      return { sid: sid, user: publicUser(u) };
    },
    logout: function (sid) { if (sid) endSession(sid); },

    // Usuario de una cookie válida (renueva la caducidad). Devuelve null si no hay sesión.
    fromSid: function (sid, noRenew) {
      var s = sid && sessions.get(sid);
      if (!s) return null;
      if (s.exp < Date.now() || s.abs < Date.now()) { endSession(sid); return null; }
      var u = find(s.userId);
      if (!u || u.disabled) { endSession(sid); return null; }
      if (!noRenew) s.exp = Date.now() + SESSION_MS;
      return u;
    },

    /* ---- gestión de usuarios (solo administrador) ---- */
    // input.forceChange === true deja la contraseña como "por cambiar" (el usuario deberá cambiarla al entrar).
    create: async function (input) {
      var name = cleanUsername(input && input.username);
      if (!validUsername(name)) return { errors: ['El usuario debe tener de 3 a 32 caracteres: letras, números y . _ @ -'] };
      if (byName(name)) return { errors: ['Ya existe un usuario con ese nombre.'] };
      if (users.length >= MAX_USERS) return { errors: ['Se alcanzó el máximo de ' + MAX_USERS + ' usuarios.'] };
      var role = input && input.role;
      if (ROLES.indexOf(role) < 0) return { errors: ['Rol no válido.'] };
      var pe = checkPassword(input && input.password);
      if (pe) return { errors: [pe] };
      if (!acquire()) return busy();
      var hp;
      try { hp = await hashPassword(input.password); } finally { release(); }
      // Tras la espera el estado pudo cambiar: se revalida.
      if (byName(name)) return { errors: ['Ya existe un usuario con ese nombre.'] };
      if (users.length >= MAX_USERS) return { errors: ['Se alcanzó el máximo de ' + MAX_USERS + ' usuarios.'] };
      var u = { id: 'u_' + crypto.randomBytes(5).toString('hex'), username: name, role: role, salt: hp.salt, hash: hp.hash,
                disabled: false, defaultPassword: input.forceChange === true, createdAt: Date.now(), lastLogin: null };
      persist(users.concat([u]));
      return { value: publicUser(u) };
    },
    // Solo se aplican los campos presentes en input, sobre el estado vigente tras la espera del hash.
    update: async function (id, input, actorId, actorSid) {
      var pl = planUpdate(id, input, actorId);
      if (pl.errors) return pl;
      var hp = null;
      if (input && input.password) {
        if (!acquire()) return busy();
        try { hp = await hashPassword(input.password); } finally { release(); }
        pl = planUpdate(id, input, actorId); // se revalida con el estado actual
        if (pl.errors) return pl;
      }
      var nu = Object.assign({}, pl.u, { username: pl.username, role: pl.role, disabled: pl.disabled });
      // Si el administrador se edita a sí mismo se ignora forceChange (no se bloquea a sí mismo) y se conserva su sesión actual.
      var force = !!(input && input.forceChange === true) && id !== actorId;
      if (hp) { nu.salt = hp.salt; nu.hash = hp.hash; nu.defaultPassword = force; }
      else if (force) nu.defaultPassword = true;
      persist(replaceUser(nu));
      if (hp || nu.disabled) dropSessions(nu.id, id === actorId ? actorSid : undefined);
      else if (force) {
        // Sin contraseña nueva las sesiones siguen abiertas, pero se cortan sus flujos en vivo (el cliente deberá cambiar la contraseña).
        var userSids = [];
        sessions.forEach(function (s, sid) { if (s.userId === nu.id) userSids.push(sid); });
        if (userSids.length && typeof self.onStreamsDropped === 'function') { try { self.onStreamsDropped(userSids); } catch (e) { /* el aviso no debe romper la edición */ } }
      }
      return { value: publicUser(nu) };
    },
    remove: function (id, actorId) {
      var u = find(id);
      if (!u) return { errors: ['Usuario no encontrado.'], status: 404 };
      if (id === actorId) return { errors: ['No puedes eliminar tu propio usuario.'] };
      if (u.role === 'admin' && !u.disabled && activeAdmins().length <= 1) return { errors: ['Debe quedar al menos un administrador activo.'] };
      persist(users.filter(function (x) { return x.id !== id; }));
      dropSessions(id);
      return { ok: true };
    },

    // Cambio de contraseña propio: exige la actual y cierra las demás sesiones del usuario.
    // Los fallos de la actual cuentan para el bloqueo (usuario+IP y por IP); al bloquearse se cierra la sesión (closeSession).
    changeOwnPassword: async function (userId, current, next, keepSid, ip) {
      var u = find(userId);
      if (!u) return { errors: ['Usuario no encontrado.'] };
      ip = ip || '';
      var key = lockKey(u.username, ip), now = Date.now();
      pruneAttempts(now);
      var blk = blockedBy(key, ip, now);
      if (blk) return { errors: [blk.error], status: 429 };
      if (!acquire()) return busy();
      var rsv = reserve(key, ip, now); // contado como fallo pendiente hasta confirmar la contraseña actual
      var ok;
      try { ok = await verifyPassword(current, u); } finally { release(); }
      if (!ok) {
        now = Date.now();
        var a = attempts.get(key);
        if (a && a.until > now) {
          if (keepSid) endSession(keepSid);
          return { errors: ['Demasiados intentos fallidos. Se cerró la sesión.'], status: 429, closeSession: true };
        }
        return { errors: ['La contraseña actual no es correcta.'] };
      }
      cancelReserve(key, ip, rsv);
      var pe = checkPassword(next);
      if (pe) return { errors: [pe] };
      if (next === current) return { errors: ['La contraseña nueva debe ser distinta de la actual.'] };
      if (!acquire()) return busy();
      var hp;
      try { hp = await hashPassword(next); } finally { release(); }
      var cur = find(userId);
      if (!cur) return { errors: ['Usuario no encontrado.'] };
      var nu = Object.assign({}, cur, { salt: hp.salt, hash: hp.hash, defaultPassword: false });
      persist(replaceUser(nu));
      dropSessions(nu.id, keepSid);
      return { value: publicUser(nu) };
    }
  };
  // Aviso opcional: self.onSessionsDropped = function (sids) { ... } se invoca al cerrar/expulsar sesiones.
  self.onSessionsDropped = null;
  // Aviso opcional: self.onStreamsDropped = function (sids) { ... } corta solo los flujos en vivo (las sesiones siguen abiertas).
  self.onStreamsDropped = null;
  return self;
}

function parseCookies(header) {
  var out = {};
  String(header || '').split(';').forEach(function (p) {
    var i = p.indexOf('='); if (i < 0) return;
    out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

module.exports = { create: create, parseCookies: parseCookies, COOKIE: COOKIE, DEFAULT_USER: DEFAULT_USER };
