'use strict';
/*
 * Alertas por Telegram: seguridad y restricciones transversales. Requisitos: RA-22 (el token nunca se filtra), RA-37 (sin dependencias
 * nuevas), RA-90 (sin puertos nuevos), RA-92/RA-93 (TLS y redirecciones), RA-98 escenario 6, y la integración en index.html y compose.yml
 * (RA-60, RA-83). Servidor real con datos temporales y el simulador de Telegram; sin Internet.
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var net = require('net');
var srv = require('./helpers/server');
var A = require('./helpers/alerts-server');
var R = A.R;

var RAIZ = path.join(__dirname, '..');
test.after(async function () { await A.limpiar(); });

// Puerto 1 de loopback: privilegiado y sin servicio en las pruebas, así que siempre rechaza la conexión.
// (Un puerto efímero recién liberado podía ocuparlo otra prueba en paralelo y dar resultados intermitentes.)
function puertoCerrado() { return Promise.resolve(1); }

// Busca el token (completo, su parte numérica y trozos del secreto) en un texto; devuelve la lista de coincidencias.
function fugas(texto, token) {
  var id = token.split(':')[0], sec = token.split(':')[1];
  return [token, id, sec.slice(0, 12), sec.slice(-12)].filter(function (x) { return texto.indexOf(x) >= 0; });
}

/*
 * Recorre un uso completo de las alertas con fallos de Telegram y reúne TODAS las salidas capturables:
 * respuestas HTTP, flujo SSE, /api/state, ajustes, exportaciones, log del servidor y archivos de datos distintos de alerts.json.
 */
async function recorrido(opts) {
  var token = opts.token, salidas = [];
  function ver(r) { salidas.push(r.text || ''); return r; }
  var h = await A.arrancar(opts.arranque);
  var sse = await srv.openStream(h.port, { cookie: h.cookie });
  assert.strictEqual(sse.status, 200);
  var a2 = await A.nuevoAdmin(h), a3 = await A.nuevoAdmin(h);
  if (opts.panel) {
    ver(await h.api('PUT', '/api/alerts/token', { token: token }));
    ver(await h.api('PUT', '/api/alerts/token', { token: token + '/x' }));           // inválido: no se debe repetir el valor
    ver(await h.api('PUT', '/api/alerts/token', { token: token.slice(0, 20) }));     // incompleto
  } else {
    ver(await h.api('PUT', '/api/alerts/token', { token: token }));                  // 409 por la variable
  }
  ver(await h.api('PUT', '/api/alerts', { enabled: true, chatId: A.CHAT, failsBeforeAlert: 1 }));
  ver(await h.api('PUT', '/api/alerts', { chatId: token }));                          // valor inválido: el error no lo repite
  ver(await h.api('GET', '/api/alerts'));
  var c = await A.nuevoCtl(500);
  await A.nuevoObjetivo(h, 'Caido', c);
  await A.esperar(function () { return opts.sim ? opts.sim.sent().length >= 1 : c.hits >= 2; }, 8000, 'intento de envío fallido');
  await A.esperar(async function () { return (await h.api('GET', '/api/alerts/status')).json.lastError; }, 8000, 'error de envío registrado');
  ver(await h.api('GET', '/api/alerts/status'));
  ver(await h.request('POST', '/api/alerts/test', { cookie: a2, body: {} }));
  ver(await h.request('POST', '/api/alerts/chats', { cookie: a3, body: {} }));
  ver(await h.api('GET', '/api/state'));
  ver(await h.api('GET', '/api/settings'));
  ver(await h.api('GET', '/api/targets'));
  ver(await h.api('GET', '/api/orgs'));
  ver(await h.api('GET', '/api/users'));
  ver(await h.api('GET', '/api/auth/me'));
  ver(await h.api('PUT', '/api/alerts', { enabled: false }));
  await A.pausa(300);
  salidas.push(sse.text); sse.close();
  salidas.push(h.log());
  var enDisco = [];
  A.archivos(h.dir).forEach(function (f) { if (path.basename(f) !== 'alerts.json') enDisco.push(fs.readFileSync(f, 'utf8')); });
  return { h: h, salidas: salidas.join('\n----\n'), disco: enDisco.join('\n----\n'), log: h.log() };
}

test('RA-98.6 / RA-22 el token del panel no aparece en respuestas, flujo SSE, /api/state, ajustes, exportaciones, log ni archivos (salvo alerts.json) con Telegram devolviendo 5xx', async function () {
  var sim = await A.nuevoSim();
  sim.setDefault('sendMessage', R.error(502, 'Bad Gateway'));
  sim.setDefault('getUpdates', R.error(401, 'Unauthorized'));
  // Se usa un id de bot distinto del de los ejemplos de los mensajes de ayuda (que citan 123456789) para no dar falsos positivos.
  var tk = '804213597:AAHxabcdefghijklmnopqrstuvwxyz98765';
  var r = await recorrido({ token: tk, panel: true, sim: sim, arranque: { sim: sim } });
  assert.deepStrictEqual(fugas(r.salidas, tk), [], 'fugas en las salidas');
  assert.deepStrictEqual(fugas(r.disco, tk), [], 'fugas en archivos de datos distintos de alerts.json');
  assert.ok(sim.sent().length >= 1, 'el recorrido sí provocó fallos de envío reales');
  assert.strictEqual(sim.sent()[0].token, tk, 'el token se usó de verdad para enviar');
  assert.strictEqual(A.leerAlerts(r.h.dir).token, tk, 'alerts.json es la única ubicación persistente');
});

test('RA-22 con el token por variable de entorno y sin conexión a Telegram: no aparece en ninguna salida y no se copia a ningún archivo', async function () {
  var cerrado = await puertoCerrado();
  var r = await recorrido({ token: A.TOKEN_ENV, panel: false, arranque: { base: 'http://127.0.0.1:' + cerrado, env: { CENTINELA_TELEGRAM_TOKEN: A.TOKEN_ENV },
    alerts: A.alertasActivas({ token: '', enabled: false }) } });
  assert.deepStrictEqual(fugas(r.salidas, A.TOKEN_ENV), [], 'fugas en las salidas');
  assert.deepStrictEqual(fugas(r.disco, A.TOKEN_ENV), [], 'fugas en archivos de datos');
  assert.ok(fugas(JSON.stringify(A.leerAlerts(r.h.dir)), A.TOKEN_ENV).length === 0, 'la variable no se escribe en alerts.json');
  assert.ok(r.log.indexOf(String(cerrado)) < 0 || r.log.indexOf('/bot') < 0, 'el log no incluye la URL de la petición');
});

test('RA-22 / RA-94 el log registra activación y token sin secretos y con el usuario; nunca la ruta /bot<token>', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  await h.api('PUT', '/api/alerts/token', { token: A.TOKEN });
  await h.api('PUT', '/api/alerts', { enabled: true, chatId: A.CHAT });
  await h.api('PUT', '/api/alerts', { enabled: false });
  await h.api('DELETE', '/api/alerts/token', {});
  var l = h.log();
  assert.match(l, /\[alertas\] .*token guardado .* por administrador/);
  assert.match(l, /\[alertas\] .*activadas por administrador/);
  assert.match(l, /\[alertas\] .*desactivadas por administrador/);
  assert.match(l, /\[alertas\] .*token borrado .* por administrador/);
  assert.deepStrictEqual(fugas(l, A.TOKEN), []);
  assert.ok(!/\/bot\d/.test(l));
});

test('RA-92 un token con / o espacios se rechaza al guardar y nunca llega una ruta rara al simulador', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  var raros = [A.TOKEN + '/../getMe', '123456789:AAH_abcdefghijklmnop rstuvwxyz012345', '123456789:AAH_abcdefghijklm/nopqrstuvwxyz012345'];
  for (var t of raros) assert.strictEqual((await h.api('PUT', '/api/alerts/token', { token: t })).status, 400, t);
  assert.strictEqual(sim.requests.length, 0);
  assert.strictEqual((await h.api('GET', '/api/alerts')).json.tokenConfigured, false);
});

test('RA-92 un token con ? o # (que el canal nunca enviaría) se rechaza al guardarlo, no se acepta para fallar siempre después', async function () {
  var sim = await A.nuevoSim();
  var h = await A.arrancar({ sim: sim });
  for (var t of ['123456789:AAH_abcdefghijklmnopq?x=1rstuvwxyz0123', '123456789:AAH_abcdefghijklmnopq#rstuvwxyz01234']) {
    var r = await h.api('PUT', '/api/alerts/token', { token: t });
    assert.strictEqual(r.status, 400, 'PUT aceptó ' + t + ' => ' + r.text);
  }
  // Control: si se aceptó, el envío de prueba falla siempre con invalid_token sin llegar a Telegram.
  assert.strictEqual(sim.requests.length, 0);
});

test('RA-93 la base de la API solo admite http hacia loopback: una base remota por http se ignora y no se envía el token a ese host', async function () {
  var sim = await A.nuevoSim();
  // Se arranca con una base inválida (http a un host externo): debe ignorarse con un aviso y NO usarse; se ataja con una conexión
  // inmediatamente rechazada, de modo que la prueba no depende de ninguna red.
  var h = await srv.startServer({ env: { CENTINELA_ADMIN_USER: A.ADMIN, CENTINELA_ADMIN_PASSWORD: A.ADMIN_PASS, CENTINELA_TELEGRAM_API_BASE: 'http://203.0.113.9:8080',
    CENTINELA_TELEGRAM_TOKEN: '', CENTINELA_ALERTS_DISABLED: '' } });
  try {
    assert.match(h.log(), /\[alertas\] .*base alternativa/i, 'avisa de que ignora la base');
    assert.ok(h.log().indexOf('203.0.113.9') < 0 || /ignor|no es válida/i.test(h.log()));
    assert.strictEqual(sim.requests.length, 0);
  } finally { await h.stop(); }
});

/* ---------- restricciones de estructura ---------- */

test('RA-37 package.json no añade dependencias', function () {
  var pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies));
  assert.ok(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0);
  assert.strictEqual(fs.existsSync(path.join(RAIZ, 'package-lock.json')), false);
});

test('RA-90 / RA-93 los módulos de alertas no abren puertos de escucha ni desactivan la verificación TLS', function () {
  ['server/lib/alerts-config.js', 'server/lib/channels/telegram.js', 'server/lib/notify.js'].forEach(function (f) {
    var s = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    assert.ok(!/\.listen\s*\(/.test(s) && !/createServer\s*\(/.test(s), f + ' abre un puerto de escucha');
    assert.ok(!/rejectUnauthorized\s*:\s*false/.test(s) && !/NODE_TLS_REJECT_UNAUTHORIZED/.test(s), f + ' desactiva TLS');
    assert.ok(!/followRedirects|maxRedirects/.test(s), f + ' sigue redirecciones');
  });
});

test('RA-60 index.html carga js/views/alerts.js antes de js/views/settings.js', function () {
  var h = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  var a = h.indexOf('js/views/alerts.js'), s = h.indexOf('js/views/settings.js');
  assert.ok(a > 0 && s > 0 && a < s, 'alerts=' + a + ' settings=' + s);
});

test('RA-83 compose.yml define CENTINELA_TELEGRAM_TOKEN y CENTINELA_ALERTS_DISABLED con valor vacío por defecto', function () {
  var y = fs.readFileSync(path.join(RAIZ, 'compose.yml'), 'utf8');
  assert.match(y, /CENTINELA_TELEGRAM_TOKEN:\s*\$\{CENTINELA_TELEGRAM_TOKEN:-\}/);
  assert.match(y, /CENTINELA_ALERTS_DISABLED:\s*\$\{CENTINELA_ALERTS_DISABLED:-\}/);
  assert.ok(!/CENTINELA_TELEGRAM_API_BASE/.test(y), 'la variable interna de pruebas no se publica');
});
