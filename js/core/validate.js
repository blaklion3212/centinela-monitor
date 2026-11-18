/*
 * Validación en el navegador (retroalimentación inmediata en el formulario y modo demostración).
 * El servidor repite estas mismas reglas: nunca confía en lo que llega del navegador.
 */
(function (NOC) {
  'use strict';
  var U = NOC.util;
  var HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
  var SERVICE_RE = /^[A-Za-z0-9_.@:-]{1,64}$/;
  var STATUS_SPEC_RE = /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/;

  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
  function int(v, min, max, d) { var n = parseInt(v, 10); return isFinite(n) ? Math.min(max, Math.max(min, n)) : d; }
  function list(v) { return Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,;\n]/) : []); }
  function isHost(h) { return !!h && h.length <= 253 && h[0] !== '-' && (U.isIp(h) || HOST_RE.test(h)); }

  NOC.validate = {
    isHost: isHost,
    SERVICE_RE: SERVICE_RE,

    target: function (input, existing, defaults) {
      var errors = [];
      input = input || {};
      var name = str(input.name, 80);
      if (!name) errors.push('El nombre es obligatorio.');
      var kind = input.kind === 'url' ? 'url' : 'host';
      var address = str(input.address, 2048);
      if (!address) errors.push('La dirección es obligatoria.');
      else if (kind === 'url') {
        try {
          var u = new URL(address);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push('La URL debe empezar con http:// o https://');
          else if (!isHost(u.hostname.replace(/^\[|\]$/g, ''))) errors.push('El host de la URL no es válido.');
        } catch (e) { errors.push('La URL no es válida (ejemplo: https://sitio.com/ruta).'); }
      } else if (!isHost(address)) errors.push('Escribe una IP o un nombre de host válido (sin http:// ni espacios).');

      var tags = [];
      list(input.tags).forEach(function (t) { t = str(t, 24); if (t && tags.indexOf(t) < 0 && tags.length < 10) tags.push(t); });

      var c = input.checks || {};
      var ports = [];
      list(c.ports).forEach(function (p) { var n = parseInt(p, 10); if (n >= 1 && n <= 65535 && ports.indexOf(n) < 0 && ports.length < 20) ports.push(n); });

      var httpCfg = null;
      if (kind === 'url') {
        var h = c.http || {};
        var spec = str(h.expectedStatus, 40) || '200-399';
        if (!STATUS_SPEC_RE.test(spec)) { errors.push('Códigos HTTP esperados no válidos (ejemplo: 200-399,401).'); spec = '200-399'; }
        httpCfg = { expectedStatus: spec.replace(/\s+/g, ''), timeoutMs: int(h.timeoutMs, 1000, 30000, 8000),
                    method: h.method === 'HEAD' ? 'HEAD' : 'GET', keyword: str(h.keyword, 100), browser: h.browser === true };
      }
      var ag = c.agent || {}, services = [];
      list(ag.services).forEach(function (s) {
        s = str(s, 64); if (!s) return;
        if (!SERVICE_RE.test(s)) errors.push('Nombre de servicio no válido: ' + s.slice(0, 20));
        else if (services.indexOf(s) < 0 && services.length < 20) services.push(s);
      });
      var isHttps = kind === 'url' && /^https:/i.test(address);
      return {
        errors: errors,
        value: {
          id: (existing && existing.id) || U.uid('t'),
          name: name, kind: kind, address: address, group: str(input.group, 40), tags: tags,
          intervalSec: int(input.intervalSec, 2, 3600, (defaults && defaults.intervalSec) || 10),
          enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
          profile: input.profile || (existing && existing.profile) || undefined,
          checks: {
            ping: typeof c.ping === 'boolean' ? c.ping : true,
            ports: ports, http: httpCfg,
            ssl: kind === 'url' ? (isHttps && c.ssl !== false) : !!c.ssl,
            agent: { enabled: !!ag.enabled, port: int(ag.port, 1, 65535, 9100), token: typeof ag.token === 'string' ? ag.token : '',
                     hasToken: !!(ag.hasToken || ag.token), services: services }
          }
        }
      };
    }
  };
})(window.NOC = window.NOC || {});
