'use strict';
/* Comprueba que un puerto TCP esté abierto y escuchando (80/443, 3306, 5432, etc.) y mide el tiempo de conexión. */
var net = require('net');
var u = require('../lib/util');

function checkPort(host, port, timeoutMs) {
  timeoutMs = timeoutMs || 3000;
  return new Promise(function (resolve) {
    var t0 = process.hrtime.bigint();
    var done = false;
    var sock = net.connect({ host: host, port: port });
    function finish(res) {
      if (done) return;
      done = true;
      sock.destroy();
      res.port = port;
      resolve(res);
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', function () {
      finish({ open: true, ms: u.round(Number(process.hrtime.bigint() - t0) / 1e6, 1) });
    });
    sock.once('timeout', function () { finish({ open: false, ms: null, error: 'tiempo agotado' }); });
    sock.once('error', function (e) { finish({ open: false, ms: null, error: u.friendlyError(e) }); });
  });
}

module.exports = { checkPort: checkPort };
