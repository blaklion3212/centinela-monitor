'use strict';
/*
 * Genera certificados autofirmados con `openssl` en un directorio temporal (nunca se versionan claves en el repo).
 * Si openssl no está disponible, hayOpenssl() devuelve false y las pruebas que lo necesitan se omiten explícitamente.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var spawnSync = require('child_process').spawnSync;
var tmp = require('./tmp');

var disponible = null;
function hayOpenssl() {
  if (disponible === null) {
    var r = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    disponible = !r.error && r.status === 0;
  }
  return disponible;
}

/*
 * Crea un par clave/certificado (curva P-256, 1 día) y devuelve { dir, cert, key, certPem, keyPem, fingerprint }.
 * `fingerprint` es la huella SHA-256 en el formato 'AA:BB:...' que usa el agente. Hay que borrar `dir` con tmp.rmTmp.
 */
function generar(cn) {
  var dir = tmp.mkTmp('centinela-tls-');
  var cert = path.join(dir, 'agent.crt'), key = path.join(dir, 'agent.key');
  var r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=' + (cn || 'centinela-agent-prueba')], { encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) { tmp.rmTmp(dir); throw new Error('openssl no pudo generar el certificado: ' + (r.error || r.stderr)); }
  var certPem = fs.readFileSync(cert);
  return { dir: dir, cert: cert, key: key, certPem: certPem, keyPem: fs.readFileSync(key),
           fingerprint: new crypto.X509Certificate(certPem).fingerprint256 };
}

module.exports = { hayOpenssl: hayOpenssl, generar: generar };
