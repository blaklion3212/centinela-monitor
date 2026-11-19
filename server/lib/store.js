'use strict';
/*
 * Persistencia en archivos JSON dentro de data/:
 *   targets.json  -> IPs y URLs a monitorear (con etiquetas y checks)
 *   settings.json -> umbrales, intervalo por defecto, tema
 *   layout.json   -> ventanas del dashboard y su posición
 *   orgs.json     -> lista de organizaciones (la primera, "default", es el host)
 *   orgs/<id>/{targets,layout}.json -> datos de cada organización adicional
 * Las escrituras son atómicas (archivo temporal + rename) para no corromper datos si se corta la luz.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Defaults = require('../../js/config/defaults.js');
var Seed = require('../../js/config/seed.js');
var validate = require('./validate');

var DATA_DIR = process.env.CENTINELA_DATA || path.join(__dirname, '..', '..', 'data');

// Si el directorio de datos existe con permisos de grupo u otros, intenta dejarlo en 0700; si no puede, avisa en el log.
function secureDataDir() {
  if (process.platform === 'win32') return 'skip';
  var st;
  try { st = fs.statSync(DATA_DIR); } catch (e) { return 'absent'; }
  if (!st.isDirectory() || (st.mode & 0o077) === 0) return 'ok';
  try { fs.chmodSync(DATA_DIR, 0o700); return 'fixed'; }
  catch (e) {
    console.warn('AVISO: el directorio de datos tiene permisos de grupo u otros y no se pudo restringir a 0700: ' + DATA_DIR);
    return 'failed';
  }
}

function file(name) { return path.join(DATA_DIR, name); }

function read(name) {
  var p = file(name);
  if (!fs.existsSync(p)) return { exists: false };
  try { return { exists: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) {
    throw new Error('data/' + name + ' no es un JSON válido (' + e.message + '). Corrígelo o renómbralo para que se regenere.');
  }
}

function write(name, obj) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true, mode: 0o700 });
  var tmp = file(name) + '.tmp';
  try { fs.unlinkSync(tmp); } catch (e) { /* no había temporal previo */ }
  var fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2) + '\n');
    fs.fsyncSync(fd); // los datos llegan a disco antes del rename
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file(name));
}

function int(v, min, max, d) { var n = Math.round(Number(v)); return isFinite(n) ? Math.min(max, Math.max(min, n)) : d; }

function sanitizeLayout(input) {
  var out = { version: 1, locked: !!(input && input.locked), widgets: [] };
  var seen = {};
  ((input && Array.isArray(input.widgets)) ? input.widgets : []).slice(0, 60).forEach(function (w) {
    if (!w || typeof w !== 'object') return;
    var id = String(w.id || '').slice(0, 40), type = String(w.type || '').slice(0, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[a-z0-9-]+$/.test(type) || seen[id]) return;
    seen[id] = true;
    var cfg = {};
    if (w.config && typeof w.config === 'object' && JSON.stringify(w.config).length < 4000) cfg = w.config;
    out.widgets.push({ id: id, type: type, x: int(w.x, 0, 11, 0), y: int(w.y, 0, 500, 0),
                       w: int(w.w, 1, 12, 4), h: int(w.h, 1, 40, 6), config: cfg });
  });
  return out;
}

var DEFAULT_ORG = 'default';
var MAX_ORGS = 50;

function orgFile(orgId, name) { return orgId === DEFAULT_ORG ? name : path.join('orgs', orgId, name); }

function cleanColor(c) { return /^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? String(c).toLowerCase() : '#4f8cff'; }
function cleanOrg(o, id) {
  var name = String(o && o.name != null ? o.name : '').trim().slice(0, 60);
  return { id: id, name: name, color: cleanColor(o && o.color), note: String((o && o.note) || '').trim().slice(0, 200) };
}
function newOrgId() { return 'o' + crypto.randomBytes(4).toString('hex'); }

function load() {
  secureDataDir();
  var settings = JSON.parse(JSON.stringify(Defaults.SETTINGS));
  var s = read('settings.json');
  if (s.exists) {
    settings = validate.sanitizeSettings(s.value, settings);
    // Si el saneado cambió algo respecto al archivo, se reescribe settings.json.
    if (JSON.stringify(settings) !== JSON.stringify(s.value)) write('settings.json', settings);
  } else write('settings.json', settings);

  // Organizaciones: la primera, "default", es el host y siempre existe (usa data/targets.json y data/layout.json).
  var orgs = [];
  var o = read('orgs.json');
  if (o.exists && Array.isArray(o.value)) {
    var seenOrg = {};
    o.value.forEach(function (x) {
      var id = x && /^[a-z0-9]{1,32}$/.test(String(x.id)) ? String(x.id) : null;
      if (!id || seenOrg[id]) return;
      var c = cleanOrg(x, id);
      if (!c.name) return;
      seenOrg[id] = true; orgs.push(c);
    });
  }
  if (!orgs.some(function (x) { return x.id === DEFAULT_ORG; })) {
    orgs.unshift({ id: DEFAULT_ORG, name: 'Host', color: '#4f8cff', note: 'Equipos y servicios propios de este servidor' });
  } else {
    orgs.sort(function (a, b) { return (b.id === DEFAULT_ORG) - (a.id === DEFAULT_ORG); });
  }
  orgs = orgs.slice(0, MAX_ORGS);
  if (!o.exists) write('orgs.json', orgs);

  var targetsBy = {}, layoutBy = {};

  function loadTargets(orgId) {
    var t = read(orgFile(orgId, 'targets.json')), list;
    if (t.exists) {
      list = (Array.isArray(t.value) ? t.value : []).map(function (x) {
        return validate.sanitizeTarget(x, { id: x && x.id, checks: x && x.checks }, settings).value;
      });
    } else if (orgId === DEFAULT_ORG) {
      list = Seed.TARGETS.map(function (x) { return validate.sanitizeTarget(x, { id: x.id, checks: x.checks }, settings).value; });
      write(orgFile(orgId, 'targets.json'), list);
    } else list = [];
    return list;
  }
  function loadLayout(orgId) {
    var l = read(orgFile(orgId, 'layout.json'));
    return l.exists ? sanitizeLayout(l.value) : null;
  }
  orgs.forEach(function (x) { targetsBy[x.id] = loadTargets(x.id); layoutBy[x.id] = loadLayout(x.id); });

  function must(orgId) { if (!targetsBy[orgId]) throw new Error('Organización no encontrada'); }

  return {
    dir: DATA_DIR,
    DEFAULT_ORG: DEFAULT_ORG, MAX_ORGS: MAX_ORGS,

    /* ---- organizaciones ---- */
    getOrgs: function () { return orgs.map(function (x) { return Object.assign({}, x, { targets: targetsBy[x.id].length }); }); },
    hasOrg: function (id) { return !!targetsBy[id]; },
    getOrg: function (id) { return orgs.filter(function (x) { return x.id === id; })[0] || null; },
    addOrg: function (input) {
      var c = cleanOrg(input, newOrgId());
      if (!c.name) return { errors: ['El nombre de la organización es obligatorio.'] };
      if (orgs.length >= MAX_ORGS) return { errors: ['Se alcanzó el máximo de ' + MAX_ORGS + ' organizaciones.'] };
      if (orgs.some(function (x) { return x.name.toLowerCase() === c.name.toLowerCase(); })) return { errors: ['Ya existe una organización con ese nombre.'] };
      // Primero a disco; la memoria solo cambia si las escrituras no lanzaron.
      try {
        write(orgFile(c.id, 'targets.json'), []);
        write('orgs.json', orgs.concat([c]));
      } catch (e) {
        // Si falla orgs.json no debe quedar el directorio huérfano de la organización.
        try { fs.rmSync(path.join(DATA_DIR, 'orgs', c.id), { recursive: true, force: true }); } catch (e2) { /* nada que limpiar */ }
        throw e;
      }
      orgs.push(c); targetsBy[c.id] = []; layoutBy[c.id] = null;
      return { value: c };
    },
    updateOrg: function (id, input) {
      var cur = orgs.filter(function (x) { return x.id === id; })[0];
      if (!cur) return { errors: ['Organización no encontrada.'] };
      var c = cleanOrg(input, id);
      if (!c.name) return { errors: ['El nombre de la organización es obligatorio.'] };
      if (orgs.some(function (x) { return x.id !== id && x.name.toLowerCase() === c.name.toLowerCase(); })) return { errors: ['Ya existe una organización con ese nombre.'] };
      write('orgs.json', orgs.map(function (x) { return x.id === id ? Object.assign({}, x, c) : x; }));
      Object.assign(cur, c);
      return { value: cur };
    },
    removeOrg: function (id) {
      if (id === DEFAULT_ORG) return { errors: ['La organización principal (Host) no se puede eliminar.'] };
      var i = orgs.findIndex(function (x) { return x.id === id; });
      if (i < 0) return { errors: ['Organización no encontrada.'] };
      write('orgs.json', orgs.filter(function (x) { return x.id !== id; }));
      orgs.splice(i, 1); delete targetsBy[id]; delete layoutBy[id];
      try { fs.rmSync(path.join(DATA_DIR, 'orgs', id), { recursive: true, force: true }); } catch (e) { /* ya no existe */ }
      return { ok: true };
    },

    /* ---- objetivos (por organización) ---- */
    getTargets: function (orgId) { orgId = orgId || DEFAULT_ORG; must(orgId); return targetsBy[orgId]; },
    saveTargets: function (orgId, arr) { must(orgId); write(orgFile(orgId, 'targets.json'), arr); targetsBy[orgId] = arr; },
    // Todos los objetivos de todas las organizaciones (los ids son únicos globalmente).
    allTargets: function () {
      var out = [];
      orgs.forEach(function (x) { targetsBy[x.id].forEach(function (t) { out.push(t); }); });
      return out;
    },
    orgOf: function (targetId) {
      for (var i = 0; i < orgs.length; i++) {
        if (targetsBy[orgs[i].id].some(function (t) { return t.id === targetId; })) return orgs[i].id;
      }
      return null;
    },
    findTarget: function (id) {
      var org = this.orgOf(id);
      return org ? targetsBy[org].filter(function (t) { return t.id === id; })[0] : null;
    },

    /* ---- configuración global y disposición por organización ---- */
    saveSettings: function (obj) { write('settings.json', obj); settings = obj; },
    getSettings: function () { return settings; },
    getLayout: function (orgId) { orgId = orgId || DEFAULT_ORG; must(orgId); return layoutBy[orgId]; },
    saveLayout: function (orgId, obj) { must(orgId); var l = sanitizeLayout(obj); write(orgFile(orgId, 'layout.json'), l); layoutBy[orgId] = l; return l; }
  };
}

module.exports = { load: load, sanitizeLayout: sanitizeLayout, DEFAULT_ORG: DEFAULT_ORG, read: read, write: write, DATA_DIR: DATA_DIR, secureDataDir: secureDataDir };
