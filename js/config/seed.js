/*
 * Objetivos de ejemplo. El servidor los copia a data/targets.json la primera vez que arranca;
 * a partir de ahí data/targets.json es la fuente de verdad y este archivo ya no se usa.
 * En modo demostración (sin servidor) se usan además DEMO_EXTRA para mostrar estados caídos/degradados.
 *
 * Estructura de un objetivo:
 *   kind:     "host" (IP o nombre de host)  |  "url" (http/https)
 *   checks.ping    true/false  -> ICMP: latencia, pérdida, jitter, TTL
 *   checks.ports   [443, 3306] -> puertos TCP que deben estar abiertos
 *   checks.http    { expectedStatus, timeoutMs, method, keyword }   (solo kind "url")
 *   checks.ssl     true/false  -> días restantes del certificado
 *   checks.agent   { enabled, port, token, services[] } -> CPU/RAM/disco/servicios (ver carpeta agent/)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.NOC = root.NOC || {}; root.NOC.Seed = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function http(extra) {
    var h = { expectedStatus: '200-399', timeoutMs: 8000, method: 'GET', keyword: '' };
    for (var k in extra) h[k] = extra[k];
    return h;
  }
  var noAgent = { enabled: false, port: 9100, token: '', services: [] };

  var TARGETS = [
    { id: 'srv-local', name: 'Servidor local (Centinela)', kind: 'host', address: '127.0.0.1',
      group: 'Infraestructura', tags: ['local'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [], http: null, ssl: false,
                agent: { enabled: true, port: 9100, token: '', services: [] } } },
    { id: 'dns-google', name: 'DNS Google', kind: 'host', address: '8.8.8.8',
      group: 'Red', tags: ['dns', 'externo'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [53], http: null, ssl: false, agent: noAgent } },
    { id: 'dns-cloudflare', name: 'DNS Cloudflare', kind: 'host', address: '1.1.1.1',
      group: 'Red', tags: ['dns', 'externo'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [53], http: null, ssl: false, agent: noAgent } },
    { id: 'web-example', name: 'Sitio de ejemplo', kind: 'url', address: 'https://example.com',
      group: 'Web', tags: ['web', 'externo'], intervalSec: 15, enabled: true,
      checks: { ping: true, ports: [443], http: http({}), ssl: true, agent: noAgent } },
    { id: 'web-google', name: 'Google', kind: 'url', address: 'https://www.google.com',
      group: 'Web', tags: ['web', 'externo'], intervalSec: 15, enabled: true,
      checks: { ping: true, ports: [], http: http({}), ssl: true, agent: noAgent } },
    { id: 'web-wikipedia', name: 'Wikipedia', kind: 'url', address: 'https://www.wikipedia.org',
      group: 'Web', tags: ['web', 'externo'], intervalSec: 15, enabled: true,
      checks: { ping: true, ports: [], http: http({}), ssl: true, agent: noAgent } }
  ];

  // Solo para el modo demostración: casos que muestran Degradado y DOWN.
  // profile: healthy | flaky (pérdida de paquetes) | slow (latencia/TTFB altos) | down | ssl-soon | disk-full
  var DEMO_EXTRA = [
    { id: 'demo-mysql', name: 'MySQL producción', kind: 'host', address: '10.20.0.15',
      group: 'Base de datos', tags: ['db', 'crítico'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [3306], http: null, ssl: false,
                agent: { enabled: true, port: 9100, token: '', services: ['mysqld'] } }, profile: 'disk-full' },
    { id: 'demo-pg', name: 'PostgreSQL reportes', kind: 'host', address: '10.20.0.16',
      group: 'Base de datos', tags: ['db'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [5432], http: null, ssl: false, agent: noAgent }, profile: 'down' },
    { id: 'demo-portal', name: 'Portal clientes', kind: 'url', address: 'https://portal.ejemplo.mx/login',
      group: 'Web', tags: ['web', 'crítico'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [443], http: http({}), ssl: true,
                agent: { enabled: true, port: 9100, token: '', services: ['nginx', 'docker'] } }, profile: 'slow' },
    { id: 'demo-api', name: 'API pagos', kind: 'url', address: 'https://api.ejemplo.mx/v1/health',
      group: 'Web', tags: ['api', 'crítico'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [443], http: http({}), ssl: true, agent: noAgent }, profile: 'ssl-soon' },
    { id: 'demo-vpn', name: 'Enlace VPN sucursal', kind: 'host', address: '172.16.4.1',
      group: 'Red', tags: ['vpn', 'enlace'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [], http: null, ssl: false, agent: noAgent }, profile: 'flaky' }
  ];

  // Solo demostración: organización de ejemplo para mostrar el selector de organizaciones y las alertas globales.
  var DEMO_ORG = { id: 'clientedemo', name: 'Cliente demo', color: '#2cc9b5', note: 'Ejemplo de una organización monitoreada desde este panel' };
  var DEMO_ORG_TARGETS = [
    { id: 'cli-erp', name: 'ERP del cliente', kind: 'url', address: 'https://erp.cliente-demo.mx',
      group: 'Aplicaciones', tags: ['erp', 'crítico'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [443], http: http({}), ssl: true, agent: noAgent }, profile: 'slow' },
    { id: 'cli-db', name: 'Base de datos Oracle', kind: 'host', address: '10.50.0.20',
      group: 'Base de datos', tags: ['db'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [1521], http: null, ssl: false, agent: noAgent }, profile: 'down' },
    { id: 'cli-vpn', name: 'Túnel VPN cliente', kind: 'host', address: '172.20.8.1',
      group: 'Red', tags: ['vpn'], intervalSec: 10, enabled: true,
      checks: { ping: true, ports: [], http: null, ssl: false, agent: noAgent }, profile: 'healthy' }
  ];

  // Perfil de simulación para los objetivos base en modo demostración.
  var DEMO_PROFILES = {
    'srv-local': 'healthy', 'dns-google': 'healthy', 'dns-cloudflare': 'healthy',
    'web-example': 'healthy', 'web-google': 'healthy', 'web-wikipedia': 'healthy'
  };

  return { TARGETS: TARGETS, DEMO_EXTRA: DEMO_EXTRA, DEMO_PROFILES: DEMO_PROFILES, DEMO_ORG: DEMO_ORG, DEMO_ORG_TARGETS: DEMO_ORG_TARGETS };
});
