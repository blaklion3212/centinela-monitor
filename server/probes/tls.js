'use strict';
/*
 * Lectura del certificado TLS: días restantes, emisor, sujeto y si la cadena es confiable.
 * Se conecta con rejectUnauthorized:false a propósito, para poder reportar certificados vencidos o inválidos
 * en lugar de fallar sin más.
 */
var tls = require('tls');
var net = require('net');
var u = require('../lib/util');

function describe(sock) {
  var cert = sock.getPeerCertificate();
  if (!cert || !cert.valid_to) return { error: 'el servidor no presentó certificado' };
  var to = Date.parse(cert.valid_to), from = Date.parse(cert.valid_from);
  var subj = cert.subject || {}, iss = cert.issuer || {};
  return {
    daysLeft: Math.floor((to - Date.now()) / 86400000),
    validFrom: isFinite(from) ? new Date(from).toISOString() : null,
    validTo: isFinite(to) ? new Date(to).toISOString() : null,
    subject: subj.CN || (Array.isArray(subj.O) ? subj.O[0] : subj.O) || null,
    issuer: iss.O ? (Array.isArray(iss.O) ? iss.O[0] : iss.O) : (iss.CN || null),
    protocol: sock.getProtocol ? sock.getProtocol() : null,
    authorized: !!sock.authorized,
    authError: sock.authorized ? null : String(sock.authorizationError || '')
  };
}

// Conexión TLS independiente (cuando no hay una petición HTTPS de la que reutilizar el certificado).
function probe(host, port, ip, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  return new Promise(function (resolve) {
    var done = false;
    var opts = { host: ip || host, port: port || 443, rejectUnauthorized: false, timeout: timeoutMs };
    if (!net.isIP(host)) opts.servername = host;
    var sock = tls.connect(opts);
    function finish(res) { if (done) return; done = true; sock.destroy(); resolve(res); }
    sock.once('secureConnect', function () { finish(describe(sock)); });
    sock.once('timeout', function () { finish({ error: 'tiempo agotado' }); });
    sock.once('error', function (e) { finish({ error: u.friendlyError(e) }); });
  });
}

module.exports = { probe: probe, describe: describe };
