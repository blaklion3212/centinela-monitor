'use strict';
/* R4: usuarios, contraseñas y sesiones (server/lib/auth.js) con datos en un directorio temporal. */
var tmp = require('./helpers/tmp');
var DATA = tmp.mkTmp('centinela-auth-');
process.env.CENTINELA_DATA = DATA; // debe fijarse antes de cargar store/auth
delete process.env.CENTINELA_ADMIN_USER;
delete process.env.CENTINELA_ADMIN_PASSWORD;

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var authLib = require('../server/lib/auth.js');

test.after(function () { tmp.rmTmp(DATA); });

// Instancia nueva: borra users.json para que se siembre de nuevo el administrador.
function fresh(env) {
  try { fs.unlinkSync(path.join(DATA, 'users.json')); } catch (e) { /* no existía */ }
  delete process.env.CENTINELA_ADMIN_PASSWORD;
  delete process.env.CENTINELA_ADMIN_USER;
  Object.keys(env || {}).forEach(function (k) { process.env[k] = env[k]; });
  var a = authLib.create();
  delete process.env.CENTINELA_ADMIN_PASSWORD;
  delete process.env.CENTINELA_ADMIN_USER;
  return a;
}
var IP = '10.1.1.1';

// Contraseña inicial aleatoria de una instancia recién sembrada.
function pw(a) { return a.seeded.generatedPassword; }

test('R4: ya no existe contraseña por defecto: se genera una aleatoria con mustChange', async function () {
  var a = fresh();
  assert.strictEqual(authLib.DEFAULT_PASS, undefined, 'DEFAULT_PASS fue eliminada');
  assert.strictEqual(a.count(), 1);
  assert.strictEqual(a.seeded.username, authLib.DEFAULT_USER);
  assert.strictEqual(a.seeded.isDefault, true);
  assert.strictEqual(typeof pw(a), 'string');
  assert.ok(pw(a).length >= 12, 'longitud suficiente: ' + pw(a).length);
  assert.ok(!/[01OlI]/.test(pw(a)), 'sin caracteres ambiguos');
  var u = a.list()[0];
  assert.strictEqual(u.role, 'admin');
  assert.strictEqual(u.mustChange, true);
  assert.strictEqual((await a.login(authLib.DEFAULT_USER, 'admin01', IP)).status, 401, 'admin01 ya no funciona');
  var r = await a.login(authLib.DEFAULT_USER, pw(a), '10.5.5.5');
  assert.ok(r.sid, 'el login con la contraseña generada funciona');
  assert.strictEqual(r.user.mustChange, true);
});

test('R4: dos siembras distintas generan contraseñas distintas', function () {
  assert.notStrictEqual(pw(fresh()), pw(fresh()));
});

test('R4: contraseña de entorno válida (>= 8) => defaultPassword=false y sin generada; débil => true', async function () {
  var fuerte = fresh({ CENTINELA_ADMIN_PASSWORD: 'una-clave-larga-123', CENTINELA_ADMIN_USER: 'jefe' });
  assert.strictEqual(fuerte.seeded.username, 'jefe');
  assert.strictEqual(fuerte.seeded.generatedPassword, null);
  assert.strictEqual(fuerte.seeded.isDefault, false);
  assert.strictEqual(fuerte.list()[0].mustChange, false);
  assert.ok((await fuerte.login('jefe', 'una-clave-larga-123', IP)).sid);
  var limite = fresh({ CENTINELA_ADMIN_PASSWORD: '12345678' });
  assert.strictEqual(limite.list()[0].mustChange, false, 'exactamente 8 caracteres cumple la política');
  var debil = fresh({ CENTINELA_ADMIN_PASSWORD: 'corta' });
  assert.strictEqual(debil.list()[0].mustChange, true);
  assert.strictEqual(debil.seeded.isDefault, true);
  assert.strictEqual(debil.seeded.generatedPassword, null, 'la débil de entorno no se sustituye por una generada');
  assert.ok((await debil.login(authLib.DEFAULT_USER, 'corta', IP)).sid);
});

test('R4: la contraseña nunca se guarda en claro y el archivo es 0600', function () {
  fresh({ CENTINELA_ADMIN_PASSWORD: 'secreto-muy-visible-42' });
  var p = path.join(DATA, 'users.json');
  var txt = fs.readFileSync(p, 'utf8');
  assert.ok(txt.indexOf('secreto-muy-visible-42') < 0);
  assert.ok(/"salt"/.test(txt) && /"hash"/.test(txt));
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
});

test('R4: login es asíncrono: el event loop sigue vivo mientras se calcula el hash', async function () {
  var a = fresh();
  var ticks = 0, iv = setInterval(function () { ticks++; }, 1);
  var inmediato = false;
  setImmediate(function () { inmediato = true; });
  var p = a.login(authLib.DEFAULT_USER, pw(a), IP);
  assert.ok(p && typeof p.then === 'function');
  assert.strictEqual(inmediato, false, 'login devolvió el control sin esperar al hash');
  var terminado = false;
  p.then(function () { terminado = true; });
  await new Promise(function (r) { setImmediate(r); });
  assert.strictEqual(inmediato, true, 'un setImmediate se ejecuta con el login aún en curso');
  assert.strictEqual(terminado, false, 'el login seguía calculando el hash');
  var r = await p;
  clearInterval(iv);
  assert.ok(r.sid);
  assert.ok(ticks >= 2, 'los temporizadores avanzaron durante el hash (ticks=' + ticks + ')');
});

test('R4: usuario o contraseña incorrectos => 401 con mensaje genérico', async function () {
  var a = fresh();
  var mal = await a.login(authLib.DEFAULT_USER, 'incorrecta', IP);
  var noExiste = await a.login('fantasma', 'incorrecta', IP);
  assert.strictEqual(mal.status, 401);
  assert.strictEqual(noExiste.status, 401);
  assert.strictEqual(mal.error, noExiste.error);
  assert.strictEqual(mal.sid, undefined);
});

test('R4: usuario deshabilitado recibe el mismo mensaje genérico que una clave errónea', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var c = await a.create({ username: 'operador1', role: 'operator', password: 'clave-operador-1' });
  assert.ok(c.value, JSON.stringify(c));
  var upd = await a.update(c.value.id, { disabled: true }, admin.id);
  assert.ok(upd.value, JSON.stringify(upd));
  var dis = await a.login('operador1', 'clave-operador-1', IP);       // clave correcta pero deshabilitado
  var mal = await a.login('operador1', 'clave-equivocada-9', '10.1.1.2');
  assert.strictEqual(dis.status, 401);
  assert.strictEqual(dis.error, mal.error);
  assert.strictEqual(dis.sid, undefined);
});

test('R4: 5 fallos bloquean (429), incluso con la clave correcta; otra IP no se ve afectada', async function () {
  var a = fresh();
  for (var i = 0; i < 5; i++) {
    var r = await a.login(authLib.DEFAULT_USER, 'mala' + i, IP);
    assert.strictEqual(r.status, 401, 'intento ' + (i + 1));
  }
  var bloqueado = await a.login(authLib.DEFAULT_USER, pw(a), IP);
  assert.strictEqual(bloqueado.status, 429);
  assert.strictEqual(bloqueado.sid, undefined);
  var otra = await a.login(authLib.DEFAULT_USER, pw(a), '10.9.9.9');
  assert.ok(otra.sid, 'otra IP puede entrar');
});

test('R4: más de 20 fallos desde una IP dan 429 aunque cambie el usuario', async function () {
  var a = fresh();
  var last;
  for (var i = 0; i < 22; i++) last = await a.login('usuario' + i, 'x', '10.7.7.7');
  assert.strictEqual(last.status, 429);
});

test('R4: siempre queda al menos un administrador activo', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var otro = await a.create({ username: 'operador2', role: 'operator', password: 'clave-operador-2' });
  // Degradar, deshabilitar o eliminar al único administrador se rechaza.
  assert.ok((await a.update(admin.id, { role: 'viewer' }, otro.value.id)).errors);
  assert.ok((await a.update(admin.id, { disabled: true }, otro.value.id)).errors);
  assert.ok(a.remove(admin.id, otro.value.id).errors);
  assert.strictEqual(a.list().filter(function (u) { return u.role === 'admin' && !u.disabled; }).length, 1);
  // No puedes eliminarte ni deshabilitarte a ti mismo.
  assert.ok(a.remove(admin.id, admin.id).errors);
  assert.ok((await a.update(admin.id, { disabled: true }, admin.id)).errors);
  // Con un segundo administrador activo sí se puede degradar al primero.
  var seg = await a.create({ username: 'admin2', role: 'admin', password: 'clave-admin-2-ok' });
  assert.ok((await a.update(admin.id, { role: 'viewer' }, seg.value.id)).value);
});

test('R4: cambiar la contraseña propia cierra las demás sesiones y conserva la actual', async function () {
  var a = fresh();
  var uid = a.list()[0].id;
  var s1 = (await a.login(authLib.DEFAULT_USER, pw(a), IP)).sid;
  var s2 = (await a.login(authLib.DEFAULT_USER, pw(a), IP)).sid;
  var s3 = (await a.login(authLib.DEFAULT_USER, pw(a), IP)).sid;
  var cerradas = [];
  a.onSessionsDropped = function (sids) { cerradas = cerradas.concat(sids); };
  var r = await a.changeOwnPassword(uid, pw(a), 'nueva-clave-segura', s2);
  assert.ok(r.value, JSON.stringify(r));
  assert.strictEqual(r.value.mustChange, false);
  assert.ok(a.fromSid(s2), 'la sesión desde la que se cambió sigue viva');
  assert.strictEqual(a.fromSid(s1), null);
  assert.strictEqual(a.fromSid(s3), null);
  assert.deepStrictEqual(cerradas.sort(), [s1, s3].sort());
  assert.strictEqual((await a.login(authLib.DEFAULT_USER, pw(a), '10.2.2.2')).status, 401);
  assert.ok((await a.login(authLib.DEFAULT_USER, 'nueva-clave-segura', '10.2.2.2')).sid);
});

test('R4: changeOwnPassword rechaza clave actual errónea, corta o igual a la actual', async function () {
  var a = fresh();
  var uid = a.list()[0].id;
  assert.ok((await a.changeOwnPassword(uid, 'no-es-esta', 'nueva-clave-segura')).errors);
  assert.ok((await a.changeOwnPassword(uid, pw(a), 'corta')).errors);
  assert.ok((await a.changeOwnPassword(uid, pw(a), pw(a))).errors);
  assert.ok((await a.changeOwnPassword('inexistente', 'x', 'nueva-clave-segura')).errors);
});

test('R4: el administrador que cambia la clave de otro usuario cierra todas sus sesiones', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var c = await a.create({ username: 'viewer1', role: 'viewer', password: 'clave-viewer-01' });
  var sid = (await a.login('viewer1', 'clave-viewer-01', IP)).sid;
  assert.ok(a.fromSid(sid));
  var r = await a.update(c.value.id, { password: 'otra-clave-viewer' }, admin.id);
  assert.ok(r.value);
  assert.strictEqual(a.fromSid(sid), null);
});

test('R4: tope de 10 sesiones por usuario (se expulsa la más antigua)', async function () {
  var a = fresh();
  var sids = [];
  for (var i = 0; i < 11; i++) sids.push((await a.login(authLib.DEFAULT_USER, pw(a), IP)).sid);
  var vivas = sids.filter(function (s) { return a.fromSid(s, true); });
  assert.strictEqual(vivas.length, 10);
  assert.strictEqual(a.fromSid(sids[0], true), null, 'la más antigua fue expulsada');
  assert.ok(a.fromSid(sids[10], true));
});

test('R4: logout invalida la sesión; usuario deshabilitado pierde la suya', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var s = (await a.login(authLib.DEFAULT_USER, pw(a), IP)).sid;
  a.logout(s);
  assert.strictEqual(a.fromSid(s), null);
  var c = await a.create({ username: 'viewer2', role: 'viewer', password: 'clave-viewer-02' });
  var sv = (await a.login('viewer2', 'clave-viewer-02', IP)).sid;
  await a.update(c.value.id, { disabled: true }, admin.id);
  assert.strictEqual(a.fromSid(sv), null);
});

test('R4: create valida usuario, rol, contraseña y duplicados', async function () {
  var a = fresh();
  assert.ok((await a.create({ username: 'a', role: 'viewer', password: 'clave-larga-1' })).errors);
  assert.ok((await a.create({ username: 'buen.nombre', role: 'dios', password: 'clave-larga-1' })).errors);
  assert.ok((await a.create({ username: 'buen.nombre', role: 'viewer', password: 'corta' })).errors);
  assert.ok((await a.create({ username: authLib.DEFAULT_USER.toUpperCase(), role: 'viewer', password: 'clave-larga-1' })).errors);
  assert.ok((await a.create(null)).errors);
});

test('R4: parseCookies', function () {
  assert.deepStrictEqual(authLib.parseCookies('a=1; centinela_sid=abc; x'), { a: '1', centinela_sid: 'abc' });
  assert.deepStrictEqual(authLib.parseCookies(undefined), {});
});

/* ---------- Ronda 1: N-02, semáforo, forceChange, M1, persistencia ---------- */

test('R4 N-02: el 5.º fallo de la contraseña actual da 429, cierra la sesión y avisa', async function () {
  var a = fresh();
  var uid = a.list()[0].id;
  var sid = (await a.login(authLib.DEFAULT_USER, pw(a), '10.3.3.3')).sid;
  var cerradas = [];
  a.onSessionsDropped = function (sids) { cerradas = cerradas.concat(sids); };
  for (var i = 1; i <= 4; i++) {
    var r = await a.changeOwnPassword(uid, 'incorrecta-' + i, 'nueva-clave-segura', sid, '10.3.3.3');
    assert.ok(r.errors, 'intento ' + i);
    assert.notStrictEqual(r.status, 429, 'los 4 primeros fallos no bloquean (intento ' + i + ')');
    assert.ok(!r.closeSession);
    assert.ok(a.fromSid(sid, true), 'la sesión sigue viva hasta el bloqueo');
  }
  var quinto = await a.changeOwnPassword(uid, 'incorrecta-5', 'nueva-clave-segura', sid, '10.3.3.3');
  assert.strictEqual(quinto.status, 429);
  assert.strictEqual(quinto.closeSession, true);
  assert.ok(quinto.errors && quinto.errors.length);
  assert.strictEqual(a.fromSid(sid, true), null, 'la sesión se cerró');
  assert.deepStrictEqual(cerradas, [sid]);
});

test('R4 N-02: tras el bloqueo ni la clave correcta cambia la contraseña ni el login entra desde esa IP', async function () {
  var a = fresh();
  var uid = a.list()[0].id;
  for (var i = 0; i < 5; i++) await a.changeOwnPassword(uid, 'mala' + i, 'nueva-clave-segura', null, '10.4.4.4');
  var r = await a.changeOwnPassword(uid, pw(a), 'nueva-clave-segura', null, '10.4.4.4');
  assert.strictEqual(r.status, 429, 'incluso con la clave correcta');
  assert.strictEqual(r.value, undefined);
  assert.strictEqual((await a.login(authLib.DEFAULT_USER, pw(a), '10.4.4.4')).status, 429, 'el bloqueo es compartido con el login');
  // Otra IP no se ve afectada.
  assert.ok((await a.changeOwnPassword(uid, pw(a), 'nueva-clave-segura', null, '10.4.4.5')).value);
});

test('R4 N-02: una contraseña actual correcta reinicia el contador de fallos', async function () {
  var a = fresh();
  var uid = a.list()[0].id;
  for (var i = 0; i < 4; i++) await a.changeOwnPassword(uid, 'mala' + i, 'otra-clave-segura', null, '10.4.6.6');
  var ok = await a.changeOwnPassword(uid, pw(a), 'otra-clave-segura', null, '10.4.6.6');
  assert.ok(ok.value, JSON.stringify(ok));
  // Con el contador a cero, 4 fallos más siguen sin bloquear.
  for (i = 0; i < 4; i++) {
    var r = await a.changeOwnPassword(uid, 'mala-b' + i, 'tercera-clave-ok', null, '10.4.6.6');
    assert.notStrictEqual(r.status, 429, 'fallo ' + (i + 1));
  }
});

test('R4: el semáforo de 4 hashes compartido devuelve 429 "Servidor ocupado" a login, create, update y changeOwnPassword', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var op = await a.create({ username: 'operador9', role: 'operator', password: 'clave-operador-9' });
  assert.ok(op.value);
  // 4 logins simultáneos con IP distinta (para no activar bloqueos) ocupan todo el semáforo.
  var ocupados = [1, 2, 3, 4].map(function (i) { return a.login('operador9', 'clave-operador-9', '10.8.0.' + i); });
  var login5 = await a.login('operador9', 'clave-operador-9', '10.8.0.5');
  assert.strictEqual(login5.status, 429);
  assert.match(login5.error, /ocupado/i);
  var cr = await a.create({ username: 'nuevo-ocupado', role: 'viewer', password: 'clave-nuevo-1' });
  assert.strictEqual(cr.status, 429);
  assert.match(cr.errors[0], /ocupado/i);
  var up = await a.update(op.value.id, { password: 'clave-cambiada-9' }, admin.id);
  assert.strictEqual(up.status, 429);
  var co = await a.changeOwnPassword(admin.id, pw(a), 'clave-propia-nueva', null, '10.8.0.9');
  assert.strictEqual(co.status, 429);
  assert.match(co.errors[0], /ocupado/i);
  // Las 4 en curso terminan bien y el semáforo se libera.
  var res = await Promise.all(ocupados);
  res.forEach(function (r) { assert.ok(r.sid); });
  assert.ok((await a.login('operador9', 'clave-operador-9', '10.8.0.6')).sid, 'el semáforo se liberó');
  assert.strictEqual(a.list().some(function (u) { return u.username === 'nuevo-ocupado'; }), false, 'el alta rechazada no se creó');
  assert.ok((await a.update(op.value.id, { password: 'clave-cambiada-9' }, admin.id)).value);
});

test('R4: un cálculo de hash que falla libera el semáforo (no se agota con errores)', async function () {
  var a = fresh();
  // Muchos logins con usuarios inexistentes seguidos no deben acabar en 429 "ocupado".
  for (var i = 0; i < 8; i++) {
    var r = await a.login('fantasma' + i, 'x', '10.8.1.' + i);
    assert.strictEqual(r.status, 401);
  }
});

test('R4: forceChange en create deja la contraseña como "por cambiar"; sin él, no', async function () {
  var a = fresh();
  var c1 = await a.create({ username: 'forzado1', role: 'viewer', password: 'clave-forzada-1', forceChange: true });
  assert.strictEqual(c1.value.mustChange, true);
  assert.strictEqual((await a.login('forzado1', 'clave-forzada-1', IP)).user.mustChange, true);
  var c2 = await a.create({ username: 'normal1', role: 'viewer', password: 'clave-normal-01' });
  assert.strictEqual(c2.value.mustChange, false);
  var c3 = await a.create({ username: 'texto1', role: 'viewer', password: 'clave-texto-01', forceChange: 'true' });
  assert.strictEqual(c3.value.mustChange, false, 'solo el booleano true cuenta');
});

test('R4: forceChange en update (con y sin contraseña nueva)', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var c = await a.create({ username: 'usuario-fc', role: 'viewer', password: 'clave-usuario-1' });
  assert.strictEqual(c.value.mustChange, false);
  var u1 = await a.update(c.value.id, { forceChange: true }, admin.id);
  assert.strictEqual(u1.value.mustChange, true, 'forceChange sin contraseña nueva marca el cambio');
  assert.ok((await a.login('usuario-fc', 'clave-usuario-1', IP)).sid, 'la clave no cambió');
  var u2 = await a.update(c.value.id, { password: 'clave-usuario-2' }, admin.id);
  assert.strictEqual(u2.value.mustChange, false, 'contraseña nueva sin forceChange limpia la marca');
  var u3 = await a.update(c.value.id, { password: 'clave-usuario-3', forceChange: true }, admin.id);
  assert.strictEqual(u3.value.mustChange, true);
  // Y el usuario la limpia al cambiar la suya.
  var own = await a.changeOwnPassword(c.value.id, 'clave-usuario-3', 'clave-usuario-4', null, '10.6.6.6');
  assert.strictEqual(own.value.mustChange, false);
});

test('R4 M1: un update con contraseña no pisa un cambio de rol hecho mientras se calculaba el hash', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var c = await a.create({ username: 'concurrente1', role: 'operator', password: 'clave-concurr-1' });
  var lenta = a.update(c.value.id, { password: 'clave-concurr-2' }, admin.id); // queda esperando el hash
  var rapida = await a.update(c.value.id, { role: 'viewer' }, admin.id);
  assert.ok(rapida.value);
  var r = await lenta;
  assert.ok(r.value, JSON.stringify(r));
  var u = a.list().filter(function (x) { return x.id === c.value.id; })[0];
  assert.strictEqual(u.role, 'viewer', 'el cambio de rol sobrevive');
  assert.ok((await a.login('concurrente1', 'clave-concurr-2', IP)).sid, 'y la contraseña nueva también');
});

test('R4 M1: si el usuario se deshabilita durante el hash, el update posterior no lo rehabilita', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var c = await a.create({ username: 'concurrente2', role: 'viewer', password: 'clave-concurr-1' });
  var lenta = a.update(c.value.id, { password: 'clave-concurr-2' }, admin.id);
  await a.update(c.value.id, { disabled: true }, admin.id);
  var r = await lenta;
  assert.ok(r.value || r.errors);
  var u = a.list().filter(function (x) { return x.id === c.value.id; })[0];
  assert.strictEqual(u.disabled, true);
});

test('R4 M1: si el usuario se elimina durante el hash, el update responde 404 y no lo resucita', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var c = await a.create({ username: 'concurrente3', role: 'viewer', password: 'clave-concurr-1' });
  var lenta = a.update(c.value.id, { password: 'clave-concurr-2' }, admin.id);
  assert.ok(a.remove(c.value.id, admin.id).ok);
  var r = await lenta;
  assert.ok(r.errors, 'no hay valor');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(a.list().some(function (x) { return x.id === c.value.id; }), false);
});

test('R4 M1: dos altas simultáneas con el mismo nombre crean solo una', async function () {
  var a = fresh();
  var res = await Promise.all([
    a.create({ username: 'duplicado', role: 'viewer', password: 'clave-dup-0001' }),
    a.create({ username: 'DUPLICADO', role: 'viewer', password: 'clave-dup-0002' })
  ]);
  assert.strictEqual(res.filter(function (r) { return r.value; }).length, 1);
  assert.strictEqual(a.list().filter(function (u) { return u.username.toLowerCase() === 'duplicado'; }).length, 1);
});

test('R4: si no se puede escribir users.json, la memoria no cambia (create, update, remove)', async function () {
  var a = fresh();
  var admin = a.list()[0];
  var c = await a.create({ username: 'persist1', role: 'viewer', password: 'clave-persist-1' });
  assert.ok(c.value);
  var antes = JSON.stringify(a.list());
  // Un directorio no vacío en lugar del archivo hace fallar el rename atómico (simula disco con error).
  var p = path.join(DATA, 'users.json');
  var respaldo = fs.readFileSync(p);
  fs.rmSync(p, { force: true });
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, 'bloqueo'), 'x');
  try {
    await assert.rejects(a.create({ username: 'persist2', role: 'viewer', password: 'clave-persist-2' }));
    await assert.rejects(a.update(c.value.id, { role: 'operator' }, admin.id));
    assert.throws(function () { a.remove(c.value.id, admin.id); });
    assert.strictEqual(JSON.stringify(a.list()), antes, 'la lista en memoria no cambió');
    var l = await a.login('persist1', 'clave-persist-1', '10.9.1.1');
    assert.strictEqual(l.status, 500, 'login sin poder guardar no crea sesión');
    assert.strictEqual(l.sid, undefined);
  } finally {
    fs.rmSync(p, { recursive: true, force: true });
    fs.writeFileSync(p, respaldo, { mode: 0o600 });
  }
});
