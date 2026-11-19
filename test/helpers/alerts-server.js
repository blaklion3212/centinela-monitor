'use strict';
/*
 * Ayudantes para las pruebas de integración de alertas: arrancan server/server.js como proceso hijo (ver helpers/server.js)
 * SIEMPRE con datos temporales y con CENTINELA_TELEGRAM_API_BASE apuntando al simulador local (nunca a Internet).
 * El estado de las variables de alertas del entorno del proceso de prueba no se hereda.
 */
var fs = require('fs');
var path = require('path');
var http = require('http');
var srv = require('./server');
var tmp = require('./tmp');
var simMod = require('./telegram-sim');

var ADMIN = 'administrador', ADMIN_PASS = 'clave-admin-segura-1';
var TOKEN = '123456789:AAH_abcdefghijklmnopqrstuvwxyz012345';
var TOKEN_ENV = '987654321:BBH_abcdefghijklmnopqrstuvwxyz067890';
var CHAT = '-1001234567890';

var servidores = [], sims = [], ctls = [], dirs = [];

// Variables propias de alertas que nunca se heredan del entorno del proceso de prueba.
var BASE_ENV = { CENTINELA_TELEGRAM_TOKEN: '', CENTINELA_ALERTS_DISABLED: '' };

async function nuevoSim() { var s = await simMod.start(); sims.push(s); return s; }

function nuevoDir() { var d = tmp.mkTmp('centinela-alerts-'); fs.writeFileSync(path.join(d, 'targets.json'), '[]'); dirs.push(d); return d; }

/*
 * o.sim | o.base: simulador (obligatorio; solo http://127.0.0.1). o.alerts: objeto escrito en alerts.json antes de arrancar.
 * o.dir: reutiliza un directorio. o.env: variables extra. o.windowMs: ventana de agrupación (por omisión 100 ms).
 * Devuelve el manejador de startServer con .cookie (administrador ya autenticado) y .dir.
 */
async function arrancar(o) {
  o = o || {};
  var base = o.base || (o.sim && o.sim.base);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(base))) throw new Error('Las pruebas de alertas solo pueden usar un simulador en 127.0.0.1');
  var dir = o.dir || nuevoDir();
  if (o.alerts) fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify(o.alerts), { mode: 0o600 });
  if (o.rawAlerts !== undefined) fs.writeFileSync(path.join(dir, 'alerts.json'), o.rawAlerts, { mode: 0o600 });
  var env = Object.assign({}, BASE_ENV, {
    CENTINELA_ADMIN_USER: ADMIN, CENTINELA_ADMIN_PASSWORD: ADMIN_PASS,
    CENTINELA_TELEGRAM_API_BASE: base,
    CENTINELA_ALERTS_GROUP_WINDOW_MS: String(o.windowMs === undefined ? 100 : o.windowMs)
  }, o.env || {});
  var h = await srv.startServer({ dir: dir, env: env });
  servidores.push(h);
  h.dir = dir;
  var r = await h.request('POST', '/api/auth/login', { body: { username: ADMIN, password: ADMIN_PASS } });
  if (r.status !== 200) throw new Error('login del administrador falló: ' + r.text);
  h.cookie = srv.cookieOf(r);
  // Atajos con la cookie del administrador.
  h.api = function (method, p, body, extra) {
    // La API exige Content-Type JSON en toda escritura (también DELETE): sin cuerpo se envía {}.
    if (body === undefined && method !== 'GET' && method !== 'HEAD') body = {};
    return h.request(method, p, Object.assign({ cookie: h.cookie, body: body }, extra || {}));
  };
  return h;
}

async function login(h, user, pass) {
  var r = await h.request('POST', '/api/auth/login', { body: { username: user, password: pass } });
  if (r.status !== 200) throw new Error('login de ' + user + ' falló: ' + r.text);
  return srv.cookieOf(r);
}

// Crea un usuario con el rol dado y devuelve su cookie de sesión.
async function nuevoUsuario(h, nombre, rol, clave) {
  clave = clave || 'clave-usuario-segura-1';
  var r = await h.request('POST', '/api/users', { cookie: h.cookie, body: { username: nombre, role: rol, password: clave } });
  if (r.status !== 201) throw new Error('no se pudo crear ' + nombre + ': ' + r.text);
  return login(h, nombre, clave);
}

var adminN = 0;
// Nuevo administrador (cada uno tiene su propio límite de 5 s entre pruebas/búsquedas).
function nuevoAdmin(h) { return nuevoUsuario(h, 'admin' + (++adminN) + '_' + Date.now().toString(36), 'admin'); }

// Servidor HTTP local que hace de "servicio vigilado". status: número o función(hits) -> código. Registra cada petición.
async function nuevoCtl(status) {
  var c = { status: status === undefined ? 200 : status, hits: 0, times: [] };
  var socks = new Set();
  var s = http.createServer(function (req, res) {
    c.hits++; c.times.push(Date.now());
    var st = typeof c.status === 'function' ? c.status(c.hits) : c.status;
    res.writeHead(st, { 'Content-Type': 'text/plain' }); res.end('x');
  });
  s.on('connection', function (k) { socks.add(k); k.on('close', function () { socks.delete(k); }); });
  await new Promise(function (r) { s.listen(0, '127.0.0.1', r); });
  c.port = s.address().port;
  c.url = 'http://127.0.0.1:' + c.port + '/';
  c.close = function () { socks.forEach(function (k) { k.destroy(); }); s.close(); };
  ctls.push(c);
  return c;
}

// Crea un objetivo URL hacia el servicio vigilado (intervalo mínimo de 2 s). org: id de organización (opcional).
async function nuevoObjetivo(h, nombre, c, org, extra) {
  var r = await h.request('POST', '/api/targets' + (org ? '?org=' + org : ''), { cookie: h.cookie,
    body: Object.assign({ name: nombre, kind: 'url', address: c.url, intervalSec: 2, checks: { ping: false } }, extra || {}) });
  if (r.status !== 201) throw new Error('no se pudo crear el objetivo: ' + r.text);
  return r.json.target.id;
}

function verificar(h, id) { return h.request('POST', '/api/targets/' + id + '/check', { cookie: h.cookie, body: {} }); }

// Espera (con sondeo) a que cond() sea verdadero; falla con msg al agotar ms.
async function esperar(cond, ms, msg) {
  var fin = Date.now() + (ms || 8000);
  for (;;) {
    var v = await cond();
    if (v) return v;
    if (Date.now() > fin) throw new Error('tiempo agotado esperando: ' + (msg || String(cond)));
    await new Promise(function (r) { setTimeout(r, 40); });
  }
}
function pausa(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function leerAlerts(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'alerts.json'), 'utf8')); }

// Configuración de alertas lista para usar (activada, con token y chat), para escribir en alerts.json.
function alertasActivas(extra) {
  return Object.assign({ version: 1, enabled: true, token: TOKEN, chatId: CHAT, orgChats: {}, detail: 'minimal', failsBeforeAlert: 2,
    notifyRecovery: true, notifyDegraded: false, alerted: {} }, extra || {});
}

// Lista todos los archivos bajo un directorio (para buscar el token en disco).
function archivos(dir) {
  var out = [];
  (function rec(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(d, e.name);
      if (e.isDirectory()) rec(p); else out.push(p);
    });
  })(dir);
  return out;
}

async function limpiar() {
  ctls.forEach(function (c) { c.close(); });
  for (var h of servidores) await h.stop();
  for (var s of sims) await s.close();
  dirs.forEach(function (d) { tmp.rmTmp(d); });
  servidores.length = 0; sims.length = 0; ctls.length = 0; dirs.length = 0;
}

// Detiene un servidor concreto (conserva su directorio de datos para reiniciar sobre él).
async function parar(h) { await h.stop(); servidores.splice(servidores.indexOf(h), 1); }

module.exports = { arrancar: arrancar, nuevoSim: nuevoSim, nuevoDir: nuevoDir, nuevoUsuario: nuevoUsuario, nuevoAdmin: nuevoAdmin, nuevoCtl: nuevoCtl,
  nuevoObjetivo: nuevoObjetivo, verificar: verificar, esperar: esperar, pausa: pausa, leerAlerts: leerAlerts, alertasActivas: alertasActivas,
  archivos: archivos, limpiar: limpiar, parar: parar, login: login, ADMIN: ADMIN, ADMIN_PASS: ADMIN_PASS, TOKEN: TOKEN, TOKEN_ENV: TOKEN_ENV, CHAT: CHAT, R: simMod.R,
  updMessage: simMod.updMessage };
