'use strict';
/*
 * Cargador de js/views/alerts.js para pruebas de la interfaz de alertas (mismo enfoque que test/alerts-ui.test.js):
 * contexto vm con un DOM mínimo (mini-dom.js) y un fetch simulado. Sin red ni servidor.
 * Uso: var u = await L.montar({ routes: { 'POST /api/alerts/test': {...} } }); u.q('[data-test]'); L.D.click(...)
 */
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var D = require('./mini-dom');

var RAIZ = path.join(__dirname, '..', '..');
var MAL_TOKEN = '123456789:AAH_abcdefghijklmnopqrstuvwxyz012345';

function cfg(o) {
  return Object.assign({ enabled: false, blockedByEnv: false, tokenConfigured: true, tokenHint: '…2345', tokenSource: 'panel', chatId: '-1001234567890',
    orgChats: {}, detail: 'minimal', failsBeforeAlert: 2, notifyRecovery: true, notifyDegraded: false, version: 1 }, o || {});
}
function sinConfigurar(o) { return cfg(Object.assign({ tokenConfigured: false, tokenHint: '', tokenSource: 'none', chatId: '' }, o || {})); }
function estado(o) {
  return Object.assign({ state: 'off', lastSentAt: null, lastError: null, queued: 0, inWindow: 0, sentTotal: 0, failedTotal: 0, droppedTotal: 0, tokenSource: 'panel', note: '' }, o || {});
}
function resp(status, json, headers) {
  headers = headers || {};
  return { status: status, ok: status >= 200 && status < 300, headers: { get: function (n) { return headers[n] !== undefined ? headers[n] : null; } },
    json: function () { return json === undefined ? Promise.reject(new Error('sin cuerpo')) : Promise.resolve(json); } };
}

/*
 * Carga util.js y alerts.js en un contexto aislado. opts.routes: { 'MÉTODO /ruta': json | function(body, opts) -> {status, json, headers}
 * | Promise } (por omisión GET /api/alerts y /api/alerts/status). Devuelve { NOC, calls, toasts, confirms, ls, route(clave, valor) }.
 */
function cargar(opts) {
  opts = opts || {};
  var ctx = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
  ctx.window = ctx;
  var almacen = Object.assign({}, opts.storage || {});
  ctx.localStorage = { getItem: function (k) { return Object.prototype.hasOwnProperty.call(almacen, k) ? almacen[k] : null; },
    setItem: function (k, v) { almacen[k] = String(v); }, removeItem: function (k) { delete almacen[k]; } };
  var u = { calls: [], toasts: [], confirms: [], unauthorized: 0, mustChange: 0, ls: almacen };
  var routes = Object.assign({ 'GET /api/alerts': cfg(), 'GET /api/alerts/status': estado() }, opts.routes || {});
  u.route = function (k, v) { routes[k] = v; };
  ctx.fetch = function (url, o) {
    o = o || {};
    var method = o.method || 'GET', key = method + ' ' + url, body = o.body ? JSON.parse(o.body) : undefined;
    u.calls.push({ method: method, url: url, body: body, headers: o.headers, key: key });
    var r = routes[key];
    if (r === undefined) return Promise.resolve(resp(404, { error: 'Ruta no encontrada' }));
    if (typeof r === 'function') r = r(body, o);
    return Promise.resolve(r).then(function (x) {
      if (x && typeof x === 'object' && 'status' in x && 'json' in x && !x.ok && x.ok !== undefined) return x;
      if (x && x.__resp) return resp(x.status, x.json, x.headers);
      return resp(200, x);
    });
  };
  vm.createContext(ctx);
  function leer(f) { vm.runInContext(fs.readFileSync(path.join(RAIZ, f), 'utf8'), ctx, { filename: f }); }
  leer('js/core/util.js');
  var NOC = ctx.NOC;
  NOC.ui = {
    icon: function (n) { return '<svg class="ic" data-icon="' + n + '"></svg>'; },
    statusIcon: function (k) { return '<svg class="si" data-kind="' + k + '"></svg>'; },
    toast: function (m, k) { u.toasts.push({ msg: m, kind: k }); },
    confirm: function (t, m, l, cb) { u.confirms.push({ title: t, msg: m, label: l }); if (opts.confirm !== false) cb(); }
  };
  NOC.auth = { can: function (a) { return opts.admin !== false || (a !== 'users'); }, onUnauthorized: function () { u.unauthorized++; }, requireChange: function () { u.mustChange++; } };
  u.ctx = ctx; u.NOC = NOC; u.leer = leer;
  leer('js/views/alerts.js');
  return u;
}
function http(status, json, headers) { return { __resp: true, status: status, json: json, headers: headers }; }

async function montar(opts) {
  var u = cargar(opts);
  var el = D.elemento();
  u.NOC.alertsPanel.mount(el);
  await D.settle();
  u.el = el;
  u.q = function (s) { return el.querySelector(s); };
  u.qa = function (s) { return el.querySelectorAll(s); };
  u.texto = function () { return el.textContent; };
  u.llamadas = function (k) { return u.calls.filter(function (c) { return c.key === k; }); };
  return u;
}
function inputDe(u, rotulo) {
  var l = u.qa('label').filter(function (x) { return x.textContent.indexOf(rotulo) >= 0; })[0];
  assert.ok(l, 'no hay label «' + rotulo + '»');
  var ref = l.getAttribute('for');
  var inp = ref ? u.q('#' + ref) : l.querySelector('input');
  assert.ok(inp, 'la label «' + rotulo + '» no apunta a ningún campo');
  return inp;
}
function boton(u, texto) {
  var b = u.qa('button').filter(function (x) { return x.textContent.trim().indexOf(texto) >= 0; })[0];
  assert.ok(b, 'no hay botón «' + texto + '»');
  return b;
}


module.exports = { D: D, cfg: cfg, sinConfigurar: sinConfigurar, estado: estado, resp: resp, cargar: cargar, http: http, montar: montar,
  inputDe: inputDe, boton: boton, MAL_TOKEN: MAL_TOKEN };
