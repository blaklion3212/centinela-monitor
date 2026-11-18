'use strict';
/* R5: persistencia (server/lib/store.js): permisos 0600 y atomicidad memoria/disco. */
var tmp = require('./helpers/tmp');
var DATA = tmp.mkTmp('centinela-store-');
process.env.CENTINELA_DATA = DATA; // antes de cargar el módulo

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var storeLib = require('../server/lib/store.js');

test.after(function () { tmp.rmTmp(DATA); });

function reset() {
  fs.readdirSync(DATA).forEach(function (n) { fs.rmSync(path.join(DATA, n), { recursive: true, force: true }); });
}
function mode(p) { return fs.statSync(p).mode & 0o777; }
// Sustituye un archivo por un directorio no vacío: el rename atómico sobre él fallará (simula disco con error).
function sabotage(name) {
  var p = path.join(DATA, name);
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, 'bloqueo'), 'x');
}

test('R5: write crea el archivo con permisos 0600 y sin temporal residual', function () {
  reset();
  storeLib.write('prueba.json', { a: 1 });
  var p = path.join(DATA, 'prueba.json');
  assert.strictEqual(mode(p), 0o600);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 });
  assert.strictEqual(fs.existsSync(p + '.tmp'), false);
});

test('R5: reescribir un archivo existente conserva 0600', function () {
  reset();
  storeLib.write('p.json', { v: 1 });
  storeLib.write('p.json', { v: 2 });
  assert.strictEqual(mode(path.join(DATA, 'p.json')), 0o600);
  assert.strictEqual(storeLib.read('p.json').value.v, 2);
});

test('R5: write crea subdirectorios (orgs/<id>/) y el directorio es privado (0700)', function () {
  reset();
  storeLib.write(path.join('orgs', 'oabc', 'targets.json'), []);
  assert.strictEqual(mode(path.join(DATA, 'orgs', 'oabc', 'targets.json')), 0o600);
  assert.strictEqual(mode(path.join(DATA, 'orgs', 'oabc')), 0o700);
});

test('R5: load() genera settings, orgs y targets con permisos 0600', function () {
  reset();
  var s = storeLib.load();
  ['settings.json', 'orgs.json', 'targets.json'].forEach(function (n) {
    assert.strictEqual(mode(path.join(DATA, n)), 0o600, n);
  });
  assert.ok(s.getOrgs().some(function (o) { return o.id === 'default'; }));
});

test('R5: read de un JSON corrupto lanza error explícito; inexistente => exists:false', function () {
  reset();
  assert.strictEqual(storeLib.read('nada.json').exists, false);
  fs.writeFileSync(path.join(DATA, 'roto.json'), '{ no es json');
  assert.throws(function () { storeLib.read('roto.json'); }, /JSON válido/);
});

test('R5: si write lanza en saveTargets, la memoria no cambia', function () {
  reset();
  var s = storeLib.load();
  var antes = JSON.stringify(s.getTargets('default'));
  sabotage('targets.json');
  assert.throws(function () { s.saveTargets('default', [{ id: 'x1', name: 'x' }]); });
  assert.strictEqual(JSON.stringify(s.getTargets('default')), antes);
  assert.strictEqual(s.findTarget('x1'), null);
});

test('R5: si write lanza en saveSettings, los ajustes en memoria no cambian', function () {
  reset();
  var s = storeLib.load();
  var antes = JSON.stringify(s.getSettings());
  sabotage('settings.json');
  var nuevo = JSON.parse(antes); nuevo.intervalSec = 777;
  assert.throws(function () { s.saveSettings(nuevo); });
  assert.strictEqual(JSON.stringify(s.getSettings()), antes);
});

test('R5: si write lanza en addOrg, la lista de organizaciones no cambia', function () {
  reset();
  var s = storeLib.load();
  var n = s.getOrgs().length;
  sabotage('orgs.json');
  assert.throws(function () { s.addOrg({ name: 'Cliente A' }); });
  assert.strictEqual(s.getOrgs().length, n);
});

test('R5: si write lanza en updateOrg o removeOrg, la organización queda como estaba', function () {
  reset();
  var s = storeLib.load();
  var o = s.addOrg({ name: 'Cliente B', color: '#112233' }).value;
  sabotage('orgs.json');
  assert.throws(function () { s.updateOrg(o.id, { name: 'Renombrada' }); });
  assert.strictEqual(s.getOrg(o.id).name, 'Cliente B');
  assert.throws(function () { s.removeOrg(o.id); });
  assert.ok(s.hasOrg(o.id));
});

test('R5: saveLayout fallido no cambia el layout en memoria', function () {
  reset();
  var s = storeLib.load();
  var antes = JSON.stringify(s.getLayout('default'));
  sabotage('layout.json');
  assert.throws(function () { s.saveLayout('default', { widgets: [{ id: 'w1', type: 'ping', x: 0, y: 0, w: 4, h: 4 }] }); });
  assert.strictEqual(JSON.stringify(s.getLayout('default')), antes);
});

test('R5: camino feliz de organizaciones y objetivos', function () {
  reset();
  var s = storeLib.load();
  var o = s.addOrg({ name: 'Cliente C' }).value;
  assert.ok(s.addOrg({ name: 'cliente c' }).errors, 'nombre duplicado sin distinguir mayúsculas');
  assert.ok(s.addOrg({ name: '  ' }).errors);
  s.saveTargets(o.id, [{ id: 't1', name: 'a', enabled: true }]);
  assert.strictEqual(s.orgOf('t1'), o.id);
  assert.ok(s.removeOrg('default').errors, 'el host no se puede eliminar');
  assert.ok(s.removeOrg(o.id).ok);
  assert.strictEqual(s.findTarget('t1'), null);
});
