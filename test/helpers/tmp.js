'use strict';
/* Utilidades para directorios de datos temporales (nunca se toca data/). */
var fs = require('fs');
var os = require('os');
var path = require('path');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'centinela-test-'));
}
function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ya no existe */ }
}
module.exports = { mkTmp: mkTmp, rmTmp: rmTmp };
