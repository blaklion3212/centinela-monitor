'use strict';
/*
 * TLS opcional del agente (Fase 3): agent/agent.js con --tls-cert/--tls-key (o CENTINELA_AGENT_TLS_CERT/KEY) y la
 * consulta de server/lib/checks.js con checks.agent.tls y checks.agent.fingerprint (huella fijada).
 * Los certificados autofirmados se generan con openssl en un directorio temporal; sin openssl, se omite de forma explícita.
 * Los objetivos usan 127.0.0.2 (127.0.0.1/localhost se miden en local con sysmetrics); si no se puede enlazar, se omiten.
 */
var test = require('node:test');
var assert = require('node:assert');
var https = require('https');
var http = require('http');
var path = require('path');
var fs = require('fs');
var spawn = require('child_process').spawn;
var spawnSync = require('child_process').spawnSync;
var checks = require('../server/lib/checks.js');
var certs = require('./helpers/certs');
var tmp = require('./helpers/tmp');
var srv = require('./helpers/server');

var AGENT_JS = path.join(__dirname, '..', 'agent', 'agent.js');
var HOST = '127.0.0.2';
var TOKEN = 'token-tls-de-prueba-123';
var SETTINGS = { thresholds: require('../js/config/defaults.js').SETTINGS.thresholds };
var RE_HUELLA = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
var SIN_OPENSSL = !certs.hayOpenssl() ? 'openssl no está instalado: no se pueden generar certificados de prueba' : false;

var hijos = new Set(), directorios = [], servidoresFalsos = [];
process.on('exit', function () { hijos.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) { /* ya terminó */ } }); });
test.after(async function () {
  for (var c of hijos) await parar(c);
  servidoresFalsos.forEach(function (s) { if (s.closeAllConnections) s.closeAllConnections(); s.close(); });
  directorios.forEach(tmp.rmTmp);
});

function certificado(cn) {
  var c = certs.generar(cn);
  directorios.push(c.dir);
  return c;
}
function parar(c) {
  return new Promise(function (resolve) {
    if (c.exitCode !== null || c.signalCode) { hijos.delete(c); return resolve(); }
    c.once('exit', function () { hijos.delete(c); resolve(); });
    c.kill('SIGKILL');
  });
}
// Lanza el agente y espera su línea de arranque. Devuelve { child, port, log(), huella }.
async function lanzarAgente(host, args, env) {
  var port = await srv.freePort();
  var e = Object.assign({}, process.env, { CENTINELA_AGENT_TOKEN: TOKEN }, env || {});
  ['CENTINELA_AGENT_TLS_CERT', 'CENTINELA_AGENT_TLS_KEY'].forEach(function (k) { if (!(env && k in env)) delete e[k]; });
  var child = spawn(process.execPath, [AGENT_JS, '--port', String(port), '--host', host].concat(args || []), { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  hijos.add(child);
  var log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  await new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('El agente no arrancó en 8 s. Salida:\n' + log)); }, 8000);
    child.once('exit', function (c) { clearTimeout(t); reject(new Error('El agente terminó (' + c + '): ' + log)); });
    // Con TLS la línea de la huella se imprime justo después (puede llegar en otro fragmento): se espera también.
    (function poll() { if (/escuchando en/.test(log) && (!/escuchando en https/.test(log) || /Huella SHA-256 del certificado[^:]*:\s+\S+/.test(log))) { clearTimeout(t); setTimeout(resolve, 50); /* las líneas de arranque siguientes (avisos) llegan en otros fragmentos */ } else setTimeout(poll, 25); })();
  });
  var m = /Huella SHA-256 del certificado[^:]*:\s+(\S+)/.exec(log);
  return { child: child, port: port, log: function () { return log; }, huella: m ? m[1] : null };
}
// Ejecuta el agente esperando que termine solo (errores de arranque).
function agenteFallido(args, env) {
  var e = Object.assign({}, process.env, { CENTINELA_AGENT_TOKEN: TOKEN }, env || {});
  ['CENTINELA_AGENT_TLS_CERT', 'CENTINELA_AGENT_TLS_KEY'].forEach(function (k) { if (!(env && k in env)) delete e[k]; });
  return spawnSync(process.execPath, [AGENT_JS, '--port', '0', '--host', '127.0.0.1'].concat(args), { env: e, encoding: 'utf8', timeout: 10000 });
}
// GET por HTTPS sin validar la cadena (autofirmado); devuelve { status, json, huella } con la huella que presentó el servidor.
function getTls(port, p, headers, host) {
  return new Promise(function (resolve, reject) {
    var req = https.request({ host: host || '127.0.0.1', port: port, path: p, method: 'GET', headers: headers || {}, rejectUnauthorized: false, agent: false }, function (res) {
      var d = '', cert = res.socket.getPeerCertificate();
      res.on('data', function (c) { d += c; });
      res.on('end', function () { var j = null; try { j = JSON.parse(d); } catch (e) { /* no JSON */ } resolve({ status: res.statusCode, json: j, huella: cert.fingerprint256 }); });
    });
    req.setTimeout(8000, function () { req.destroy(new Error('tiempo agotado')); });
    req.on('error', reject);
    req.end();
  });
}
// ¿Se puede enlazar la dirección de loopback secundaria? (Linux sí; macOS no)
function puedeEnlazar(ip) {
  return new Promise(function (resolve) {
    var s = require('net').createServer();
    s.on('error', function () { resolve(false); });
    s.listen(0, ip, function () { s.close(function () { resolve(true); }); });
  });
}

/* ---------- Arranque del agente ---------- */

test('TLS agente: con --tls-cert/--tls-key sirve HTTPS, imprime la huella AA:BB:... y coincide con el certificado', { skip: SIN_OPENSSL }, async function () {
  var c = certificado();
  var a = await lanzarAgente('127.0.0.1', ['--tls-cert', c.cert, '--tls-key', c.key]);
  assert.match(a.log(), /escuchando en https:\/\/127\.0\.0\.1:\d+/);
  assert.match(a.huella, RE_HUELLA);
  assert.strictEqual(a.huella, c.fingerprint);
  assert.doesNotMatch(a.log(), /sin TLS el token viaja en claro/, 'con TLS no se avisa de claro');
  var r = await getTls(a.port, '/health', { Authorization: 'Bearer ' + TOKEN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.huella, a.huella, 'el certificado presentado por la red tiene la huella impresa');
  assert.strictEqual((await getTls(a.port, '/health')).status, 401, 'la autenticación por token sigue vigente bajo TLS');
  await parar(a.child);
});

test('TLS agente: las variables CENTINELA_AGENT_TLS_CERT/KEY equivalen a los argumentos', { skip: SIN_OPENSSL }, async function () {
  var c = certificado();
  var a = await lanzarAgente('127.0.0.1', [], { CENTINELA_AGENT_TLS_CERT: c.cert, CENTINELA_AGENT_TLS_KEY: c.key });
  assert.match(a.log(), /escuchando en https:/);
  assert.strictEqual(a.huella, c.fingerprint);
  assert.strictEqual((await getTls(a.port, '/health', { Authorization: 'Bearer ' + TOKEN })).status, 200);
  await parar(a.child);
});

test('TLS agente: los argumentos tienen prioridad sobre las variables de entorno', { skip: SIN_OPENSSL }, async function () {
  var arg = certificado('por-argumento'), env = certificado('por-entorno');
  var a = await lanzarAgente('127.0.0.1', ['--tls-cert', arg.cert, '--tls-key', arg.key], { CENTINELA_AGENT_TLS_CERT: env.cert, CENTINELA_AGENT_TLS_KEY: env.key });
  assert.strictEqual(a.huella, arg.fingerprint);
  assert.notStrictEqual(arg.fingerprint, env.fingerprint);
  await parar(a.child);
});

test('TLS agente: sin TLS sigue sirviendo HTTP plano y no imprime huella', async function () {
  var a = await lanzarAgente('127.0.0.1', []);
  assert.match(a.log(), /escuchando en http:\/\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(a.log(), /Huella SHA-256/);
  assert.match(a.log(), /sin TLS el token viaja en claro/);
  assert.strictEqual((await srv.request(a.port, 'GET', '/health', { headers: { Authorization: 'Bearer ' + TOKEN } })).status, 200);
  await parar(a.child);
});

test('TLS agente: archivos inexistentes => mensaje de error y salida con código 1', function () {
  var r = agenteFallido(['--tls-cert', '/no/existe/agent.crt', '--tls-key', '/no/existe/agent.key']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No se pudo cargar el certificado o la clave TLS/);
  assert.match(r.stderr, /agent\.crt/, 'indica qué archivo falló');
});

test('TLS agente: indicar solo el certificado o solo la clave => error y salida 1', { skip: SIN_OPENSSL }, function () {
  var c = certificado();
  var soloCert = agenteFallido(['--tls-cert', c.cert]);
  assert.strictEqual(soloCert.status, 1, soloCert.stderr);
  assert.match(soloCert.stderr, /--tls-cert y --tls-key/);
  var soloClave = agenteFallido([], { CENTINELA_AGENT_TLS_KEY: c.key });
  assert.strictEqual(soloClave.status, 1, soloClave.stderr);
  assert.match(soloClave.stderr, /juntos/);
});

test('TLS agente: certificado y clave que no se corresponden, o contenido que no es PEM => salida 1', { skip: SIN_OPENSSL }, function () {
  var a = certificado('a'), b = certificado('b');
  var cruzado = agenteFallido(['--tls-cert', a.cert, '--tls-key', b.key]);
  assert.strictEqual(cruzado.status, 1, 'clave de otro certificado: ' + cruzado.stdout + cruzado.stderr);
  assert.match(cruzado.stderr, /No se pudo cargar/);
  var basura = path.join(a.dir, 'basura.pem');
  fs.writeFileSync(basura, 'esto no es un certificado');
  var r = agenteFallido(['--tls-cert', basura, '--tls-key', a.key]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No se pudo cargar/);
});

/* ---------- Consulta del servidor al agente (checks.agent.tls / fingerprint) ---------- */

function objetivo(port, agente) {
  return { id: 'ag-tls', name: 'agente tls', kind: 'host', address: HOST, enabled: true,
           checks: { ping: false, ports: [], ssl: false, agent: Object.assign({ enabled: true, port: port, token: TOKEN, services: [] }, agente) } };
}

// Agente real en 127.0.0.2 con TLS; devuelve también el certificado para comparar.
async function agenteTlsReal(t) {
  if (!(await puedeEnlazar(HOST))) { t.skip('no se puede enlazar ' + HOST + ' en este sistema'); return null; }
  var c = certificado();
  var a = await lanzarAgente(HOST, ['--tls-cert', c.cert, '--tls-key', c.key]);
  a.cert = c;
  return a;
}

test('TLS checks: huella fijada correcta => datos del agente, sin advertencia', { skip: SIN_OPENSSL }, async function (t) {
  var a = await agenteTlsReal(t); if (!a) return;
  var r = await checks.checkTarget(objetivo(a.port, { tls: true, fingerprint: a.cert.fingerprint }), SETTINGS);
  assert.strictEqual(r.agent.error, undefined, JSON.stringify(r.agent));
  assert.ok(r.agent.cpu && typeof r.agent.hostname === 'string' && r.agent.hostname.length > 0, 'datos normalizados');
  assert.strictEqual(r.agent.warning, undefined, 'con huella fijada no hay advertencia');
  await parar(a.child);
});

test('TLS checks: la huella se compara sin importar mayúsculas ni ":"', { skip: SIN_OPENSSL }, async function (t) {
  var a = await agenteTlsReal(t); if (!a) return;
  var plana = a.cert.fingerprint.replace(/:/g, '').toLowerCase();
  [plana, a.cert.fingerprint.toLowerCase()].forEach(function (f) { assert.notStrictEqual(f, a.cert.fingerprint); });
  for (var f of [plana, a.cert.fingerprint.toLowerCase()]) {
    var r = await checks.checkTarget(objetivo(a.port, { tls: true, fingerprint: f }), SETTINGS);
    assert.strictEqual(r.agent.error, undefined, f + ' => ' + JSON.stringify(r.agent));
    assert.ok(r.agent.cpu);
  }
  await parar(a.child);
});

test('TLS checks: huella distinta => error de suplantación y sin datos', { skip: SIN_OPENSSL }, async function (t) {
  var a = await agenteTlsReal(t); if (!a) return;
  var otra = certificado('otro').fingerprint;
  var r = await checks.checkTarget(objetivo(a.port, { tls: true, fingerprint: otra }), SETTINGS);
  assert.strictEqual(r.agent.error, 'La huella TLS del agente no coincide (posible suplantación)');
  assert.strictEqual(r.agent.cpu, undefined, 'no se aceptan datos de un servidor no verificado');
  assert.strictEqual(r.agent.warning, undefined);
  await parar(a.child);
});

test('TLS checks: con tls y sin huella (vacía o ausente) => error y ningún dato; ya no hay advertencia', { skip: SIN_OPENSSL }, async function (t) {
  var a = await agenteTlsReal(t); if (!a) return;
  var r = await checks.checkTarget(objetivo(a.port, { tls: true, fingerprint: '' }), SETTINGS);
  assert.strictEqual(r.agent.error, 'Falta la huella TLS del agente');
  assert.strictEqual(r.agent.cpu, undefined, 'sin huella no se aceptan datos');
  assert.strictEqual(r.agent.warning, undefined, 'la advertencia "TLS sin huella fijada" ya no existe');
  var sinCampo = await checks.checkTarget(objetivo(a.port, { tls: true }), SETTINGS);
  assert.strictEqual(sinCampo.agent.error, 'Falta la huella TLS del agente', 'sin el campo fingerprint también');
  assert.strictEqual(sinCampo.agent.warning, undefined);
  await parar(a.child);
});

test('TLS checks: tls=false contra un agente HTTPS no devuelve datos (error, no cae a texto plano con éxito)', { skip: SIN_OPENSSL }, async function (t) {
  var a = await agenteTlsReal(t); if (!a) return;
  var r = await checks.checkTarget(objetivo(a.port, { tls: false }), SETTINGS);
  assert.ok(r.agent.error, JSON.stringify(r.agent));
  assert.strictEqual(r.agent.cpu, undefined);
  await parar(a.child);
});

/* ---------- Servidor falso: el token no llega a quien no coincide con la huella ---------- */

// Servidor HTTPS en 127.0.0.2 que registra cada petición recibida (con sus cabeceras) y responde datos mínimos válidos.
async function servidorFalso(cert) {
  var s = { vistas: [] };
  s.srv = https.createServer({ cert: cert.certPem, key: cert.keyPem }, function (req, res) {
    s.vistas.push({ url: req.url, auth: req.headers.authorization || null });
    var body = JSON.stringify({ ts: 1, hostname: 'falso', platform: 'linux', uptimeSec: 1, cpu: { usagePct: 1, cores: 1, load: [0, 0, 0] }, mem: { totalMb: 1, usedMb: 1, usedPct: 1 }, disks: [], services: [] });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  servidoresFalsos.push(s.srv);
  await new Promise(function (r) { s.srv.listen(0, HOST, r); });
  s.port = s.srv.address().port;
  return s;
}

test('TLS checks: con huella distinta el servidor NO recibe la petición ni el token; con la correcta sí', { skip: SIN_OPENSSL }, async function (t) {
  if (!(await puedeEnlazar(HOST))) return t.skip('no se puede enlazar ' + HOST + ' en este sistema');
  var legitimo = certificado('legitimo'), impostor = certificado('impostor');
  var falso = await servidorFalso(impostor); // presenta el certificado del impostor
  var r = await checks.checkTarget(objetivo(falso.port, { tls: true, fingerprint: legitimo.fingerprint }), SETTINGS);
  assert.strictEqual(r.agent.error, 'La huella TLS del agente no coincide (posible suplantación)');
  // Margen para que una petición tardía (si el código la enviara) llegara; la comprobación positiva siguiente la delata.
  await new Promise(function (res) { setTimeout(res, 150); });
  assert.deepStrictEqual(falso.vistas, [], 'ninguna petición (y por tanto ningún Authorization) llegó al servidor falso');
  // Control positivo: el mismo servidor con SU huella sí recibe la petición con el token.
  var ok = await checks.checkTarget(objetivo(falso.port, { tls: true, fingerprint: impostor.fingerprint }), SETTINGS);
  assert.strictEqual(ok.agent.error, undefined, JSON.stringify(ok.agent));
  assert.strictEqual(falso.vistas.length, 1, 'solo la petición legítima llegó');
  assert.strictEqual(falso.vistas[0].auth, 'Bearer ' + TOKEN);
  assert.match(falso.vistas[0].url, /^\/metrics\?services=/);
});

test('TLS checks: con tls y sin huella el servidor NO recibe la petición ni Authorization', { skip: SIN_OPENSSL }, async function (t) {
  if (!(await puedeEnlazar(HOST))) return t.skip('no se puede enlazar ' + HOST + ' en este sistema');
  var cert = certificado('sin-huella');
  var falso = await servidorFalso(cert);
  var r = await checks.checkTarget(objetivo(falso.port, { tls: true }), SETTINGS);
  assert.strictEqual(r.agent.error, 'Falta la huella TLS del agente');
  assert.strictEqual(r.agent.warning, undefined);
  // Control negativo: margen para que una petición tardía (si el código la enviara) llegara.
  await new Promise(function (res) { setTimeout(res, 150); });
  assert.deepStrictEqual(falso.vistas, [], 'ninguna petición ni Authorization llegó al servidor');
  // Control positivo: con la huella correcta el mismo servidor sí recibe la petición con el token.
  var ok = await checks.checkTarget(objetivo(falso.port, { tls: true, fingerprint: cert.fingerprint }), SETTINGS);
  assert.strictEqual(ok.agent.error, undefined, JSON.stringify(ok.agent));
  assert.strictEqual(falso.vistas.length, 1);
  assert.strictEqual(falso.vistas[0].auth, 'Bearer ' + TOKEN);
});

test('TLS checks: tls=true contra un servidor HTTP plano falla sin enviarle el token', async function (t) {
  if (!(await puedeEnlazar(HOST))) return t.skip('no se puede enlazar ' + HOST + ' en este sistema');
  var vistas = [];
  var plano = http.createServer(function (req) { vistas.push(req.headers.authorization || null); });
  servidoresFalsos.push(plano);
  await new Promise(function (r) { plano.listen(0, HOST, r); });
  var r = await checks.checkTarget(objetivo(plano.address().port, { tls: true, fingerprint: 'AA'.repeat(32) }), SETTINGS);
  assert.ok(r.agent.error, JSON.stringify(r.agent));
  assert.strictEqual(r.agent.cpu, undefined);
  assert.deepStrictEqual(vistas, []);
});
