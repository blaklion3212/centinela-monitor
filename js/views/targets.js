/* Vista Objetivos: alta, edición, baja y etiquetado de IPs y URLs. Importar/exportar JSON o CSV. */
(function (NOC) {
  'use strict';
  var U = NOC.util, F = U.fmt, ui = NOC.ui, store = NOC.store, bus = NOC.bus;
  var root, filter = '';

  function checksChips(t) {
    var c = t.checks, out = [];
    if (c.ping) out.push('Ping');
    if (c.http) out.push('HTTP');
    if (c.ssl) out.push('SSL');
    if (c.ports && c.ports.length) out.push('Puertos ' + c.ports.join(','));
    if (c.agent && c.agent.enabled) out.push('Agente');
    return out.map(function (x) { return '<span class="chip">' + U.esc(x) + '</span>'; }).join('') || '<span class="muted">ninguno</span>';
  }

  function render() {
    if (!root) return;
    var org = store.org(store.state.orgId), ot = root.querySelector('[data-org-title]');
    if (ot) ot.innerHTML = org ? '<span class="org-chip" style="--oc:' + U.esc(org.color) + '"><i></i>' + U.esc(org.name) + '</span>' : '';
    var all = store.targets(), q = filter.toLowerCase();
    var list = all.filter(function (t) { return !q || (t.name + ' ' + t.address + ' ' + (t.group || '') + ' ' + (t.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0; });
    var body = root.querySelector('[data-body]');
    if (!all.length) {
      body.innerHTML = '<div class="empty">' + ui.icon('server', 'ico--lg') + '<b>Todavía no hay objetivos</b><span>Agrega la IP de un servidor o la URL de un servicio para empezar a monitorearlo.</span><button type="button" class="btn btn--primary" data-add>' + ui.icon('plus') + ' Agregar objetivo</button></div>';
      return;
    }
    body.innerHTML = '<table class="tbl"><thead><tr><th>Estado</th><th>Nombre del servicio</th><th>Tipo</th><th>Dirección</th><th>Etiquetas</th><th>Qué se mide</th><th class="r">Cada</th><th>Activo</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map(function (t) {
        return '<tr data-id="' + U.esc(t.id) + '"><td>' + ui.status(store.statusOf(t)) + '</td>' +
          '<td><div class="tname">' + U.esc(t.name) + '</div>' + (t.group ? '<span class="chip chip--kind">' + U.esc(t.group) + '</span>' : '') + '</td>' +
          '<td>' + (t.kind === 'url' ? 'URL' : (U.isIp(t.address) ? 'IP' : 'Host')) + '</td><td class="taddr" style="font-size:12px">' + U.esc(t.address) + '</td>' +
          '<td><div class="tags-line">' + (t.tags || []).map(function (g) { return '<span class="chip">' + U.esc(g) + '</span>'; }).join('') + '</div></td>' +
          '<td><div class="tags-line">' + checksChips(t) + '</div></td><td class="r num">' + t.intervalSec + ' s</td>' +
          '<td><label class="check"><input type="checkbox" data-toggle ' + (t.enabled ? 'checked' : '') + ' aria-label="Activo"></label></td>' +
          '<td style="white-space:nowrap"><button type="button" class="icon-btn" data-edit title="Editar" aria-label="Editar ' + U.esc(t.name) + '">' + ui.icon('edit') + '</button>' +
          '<button type="button" class="icon-btn danger" data-del title="Eliminar" aria-label="Eliminar ' + U.esc(t.name) + '">' + ui.icon('trash') + '</button></td></tr>';
      }).join('') : '<tr><td colspan="9" class="muted" style="text-align:center;padding:20px">Ningún objetivo coincide con la búsqueda.</td></tr>') + '</tbody></table>';
    root.querySelector('[data-count]').textContent = all.length + (all.length === 1 ? ' objetivo' : ' objetivos');
  }

  /* ---------- formulario ---------- */
  function listStr(a) { return (a || []).join(', '); }
  function form(t) {
    var isNew = !t, c = (t && t.checks) || { ping: true, ports: [], http: { expectedStatus: '200-399', timeoutMs: 8000, method: 'GET', keyword: '' }, ssl: false, agent: { enabled: false, port: 9100, services: [] } };
    var kind = (t && t.kind) || 'host', h = c.http || { expectedStatus: '200-399', timeoutMs: 8000, method: 'GET', keyword: '' }, ag = c.agent || {};
    var groups = store.groups().map(function (g) { return '<option value="' + U.esc(g) + '">'; }).join('');
    function v(x) { return U.esc(x == null ? '' : x); }
    var html = '<form id="tf" novalidate><div data-errors></div>' +
      '<div class="field"><label for="f-name">Nombre del servicio</label><input id="f-name" type="text" maxlength="80" value="' + v(t && t.name) + '" placeholder="Ej. Portal de clientes, MySQL producción" required></div>' +
      '<div class="field"><span class="lbl">Tipo de objetivo</span><div class="seg" role="group" aria-label="Tipo"><button type="button" data-kind="host" aria-pressed="' + (kind === 'host') + '">IP o host</button><button type="button" data-kind="url" aria-pressed="' + (kind === 'url') + '">URL (web / API)</button></div></div>' +
      '<div class="field"><label for="f-addr" data-addr-label></label><input id="f-addr" type="text" maxlength="2048" value="' + v(t && t.address) + '" autocomplete="off" spellcheck="false" required><span class="hint" data-addr-hint></span></div>' +
      '<div class="row c2"><div class="field"><label for="f-group">Grupo (opcional)</label><input id="f-group" type="text" list="groups" maxlength="40" value="' + v(t && t.group) + '" placeholder="Ej. Base de datos"><datalist id="groups">' + groups + '</datalist></div>' +
      '<div class="field"><label for="f-tags">Etiquetas</label><input id="f-tags" type="text" value="' + v(listStr(t && t.tags)) + '" placeholder="crítico, produccion, ivr"><span class="hint">Separadas por coma.</span></div></div>' +
      '<div class="row c2"><div class="field"><label for="f-int">Medir cada (segundos)</label><input id="f-int" type="number" min="2" max="3600" value="' + v((t && t.intervalSec) || store.state.settings.intervalSec) + '"></div>' +
      '<div class="field"><span class="lbl">Estado</span><label class="check" style="padding-top:6px"><input id="f-en" type="checkbox" ' + (!t || t.enabled ? 'checked' : '') + '> Monitoreo activo</label></div></div>' +
      '<fieldset><legend>Qué medir</legend>' +
        '<div class="field"><label class="check"><input id="f-ping" type="checkbox" ' + (c.ping ? 'checked' : '') + '> Ping: latencia, pérdida de paquetes, jitter y TTL</label></div>' +
        '<div class="field"><label for="f-ports">Puertos TCP que deben estar abiertos</label><input id="f-ports" type="text" value="' + v(listStr(c.ports)) + '" placeholder="80, 443, 3306, 5432"></div>' +
        '<div data-url-only><div class="row c2"><div class="field"><label for="f-exp">Códigos HTTP esperados</label><input id="f-exp" type="text" value="' + v(h.expectedStatus) + '"><span class="hint">Ej. 200-399 o 200,401. Otro código = DOWN.</span></div>' +
        '<div class="field"><label for="f-kw">Texto que debe aparecer (opcional)</label><input id="f-kw" type="text" maxlength="100" value="' + v(h.keyword) + '"></div></div>' +
        '<div class="row c2"><div class="field"><label for="f-method">Método</label><select id="f-method"><option value="GET"' + (h.method !== 'HEAD' ? ' selected' : '') + '>GET</option><option value="HEAD"' + (h.method === 'HEAD' ? ' selected' : '') + '>HEAD</option></select></div>' +
        '<div class="field"><label for="f-to">Tiempo máximo (ms)</label><input id="f-to" type="number" min="1000" max="30000" step="500" value="' + v(h.timeoutMs) + '"></div></div>' +
        '<div class="field"><label class="check"><input id="f-browser" type="checkbox" ' + (h.browser ? 'checked' : '') + '> Identificarse como un navegador (Chrome)</label><span class="hint">Actívalo si en tu navegador la página abre pero aquí sale 403, 429 o 503: algunos sitios rechazan a los monitores. Las redirecciones (hasta 10) y sus cookies se siguen siempre.</span></div></div>' +
        '<div class="field"><label class="check"><input id="f-ssl" type="checkbox" ' + (c.ssl ? 'checked' : '') + '> Vigilar caducidad del certificado SSL/TLS</label></div></fieldset>' +
      '<fieldset><legend>Salud del servidor (agente)</legend>' +
        '<div class="field"><label class="check"><input id="f-ag" type="checkbox" ' + (ag.enabled ? 'checked' : '') + '> Medir CPU, RAM, disco, I/O wait, ancho de banda y servicios</label><span class="hint">Requiere el agente (carpeta <code>agent/</code>) en ese servidor. En el mismo equipo del panel (127.0.0.1) no hace falta instalarlo.</span></div>' +
        '<div data-agent><div class="row c2"><div class="field"><label for="f-agport">Puerto del agente</label><input id="f-agport" type="number" min="1" max="65535" value="' + v(ag.port || 9100) + '"></div>' +
        '<div class="field"><label for="f-agtoken">Token del agente</label><input id="f-agtoken" type="password" autocomplete="new-password" placeholder="' + (ag.hasToken ? 'Guardado — déjalo vacío para conservarlo' : 'Opcional en 127.0.0.1') + '"></div></div>' +
        '<div class="field"><label class="check"><input id="f-agtls" type="checkbox" ' + (ag.tls ? 'checked' : '') + '> Conexión cifrada (TLS)</label></div>' +
        '<div class="field" data-fp-field><label for="f-agfp">Huella SHA-256 del certificado (obligatoria con TLS)</label><input id="f-agfp" type="text" maxlength="95" autocomplete="off" spellcheck="false" aria-describedby="f-agfp-h" value="' + v(ag.fingerprint) + '" placeholder="64 caracteres hexadecimales, con o sin :"><span class="hint" id="f-agfp-h">Obligatoria con TLS: el agente la imprime al arrancar con --tls-cert/--tls-key.</span></div>' +
        '<div class="hint" data-token-warn role="status" hidden style="color:var(--degraded);margin-bottom:8px">Al cambiar la dirección o el puerto, al cambiar la huella o desactivar TLS, se descarta el token guardado del agente; vuelve a escribirlo.</div>' +
        '<div class="field"><label for="f-svc">Servicios a vigilar</label><input id="f-svc" type="text" value="' + v(listStr(ag.services)) + '" placeholder="nginx, docker, mysqld"><span class="hint">Nombre del servicio o proceso, separados por coma.</span></div></div></fieldset></form>';
    return { html: html, kind: kind, isNew: isNew };
  }

  function openForm(t) {
    var f = form(t), kind = f.kind;
    var m = ui.modal({ title: t ? 'Editar objetivo' : 'Agregar objetivo', body: f.html, wide: true,
      actions: [{ label: 'Cancelar' }, { label: t ? 'Guardar cambios' : 'Agregar', kind: 'primary', onClick: function (close, rootEl) { save(rootEl, t, kind, close); } }],
      onOpen: function (rootEl) {
        function sync() {
          var url = kind === 'url';
          rootEl.querySelector('[data-addr-label]').textContent = url ? 'URL completa' : 'Dirección IP o nombre de host';
          rootEl.querySelector('#f-addr').placeholder = url ? 'https://portal.miempresa.com/login' : '10.20.0.15  o  servidor.miempresa.com';
          rootEl.querySelector('[data-addr-hint]').textContent = url ? 'Incluye http:// o https://. Se mostrará qué IP resuelve el nombre.' : 'Sin http://. Para nombres se muestra la IP resuelta; para IPs, el nombre inverso (PTR).';
          rootEl.querySelector('[data-url-only]').hidden = !url;
          var sslBox = rootEl.querySelector('#f-ssl').closest('.field');
          sslBox.hidden = false;
          rootEl.querySelectorAll('[data-kind]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-kind') === kind)); });
          var tlsOn = rootEl.querySelector('#f-agtls').checked;
          rootEl.querySelector('[data-fp-field]').hidden = !tlsOn;
          rootEl.querySelector('#f-agfp').required = tlsOn; // con TLS la huella es obligatoria
          rootEl.querySelector('[data-agent]').style.opacity = rootEl.querySelector('#f-ag').checked ? 1 : .5;
        }
        rootEl.addEventListener('click', function (e) { var b = e.target.closest('[data-kind]'); if (b) { kind = b.getAttribute('data-kind'); if (!t) rootEl.querySelector('#f-ssl').checked = kind === 'url'; sync(); } });
        rootEl.querySelector('#f-ag').addEventListener('change', sync);
        rootEl.querySelector('#f-agtls').addEventListener('change', sync);
        // Con token guardado, cambiar dirección o puerto lo descarta en el servidor: se avisa en el formulario.
        if (t && t.checks && t.checks.agent && t.checks.agent.hasToken) {
          var warn = rootEl.querySelector('[data-token-warn]'), addr0 = String(t.address || ''), port0 = String(t.checks.agent.port || 9100), tls0 = !!t.checks.agent.tls;
          // Huella comparada normalizada: sin ':' y en mayúsculas.
          var nfp = function (s) { return String(s || '').replace(/:/g, '').trim().toUpperCase(); }, fp0 = nfp(t.checks.agent.fingerprint);
          var chk = function () { warn.hidden = !(nfp(rootEl.querySelector('#f-agfp').value) !== fp0 || rootEl.querySelector('#f-addr').value.trim() !== addr0 || rootEl.querySelector('#f-agport').value.trim() !== port0 || (tls0 && !rootEl.querySelector('#f-agtls').checked)); };
          rootEl.querySelector('#f-addr').addEventListener('input', chk);
          rootEl.querySelector('#f-agport').addEventListener('input', chk);
          rootEl.querySelector('#f-agtls').addEventListener('change', chk);
          rootEl.querySelector('#f-agfp').addEventListener('input', chk);
        }
        rootEl.querySelector('#tf').addEventListener('submit', function (e) { e.preventDefault(); save(rootEl, t, kind, m.close); });
        sync();
      } });
  }

  function save(rootEl, existing, kind, close) {
    function val(id) { var el = rootEl.querySelector(id); return el ? el.value : ''; }
    function chk(id) { return rootEl.querySelector(id).checked; }
    var payload = {
      name: val('#f-name'), kind: kind, address: val('#f-addr'), group: val('#f-group'), tags: val('#f-tags'),
      intervalSec: val('#f-int'), enabled: chk('#f-en'),
      checks: { ping: chk('#f-ping'), ports: val('#f-ports'), ssl: chk('#f-ssl'),
        http: kind === 'url' ? { expectedStatus: val('#f-exp'), keyword: val('#f-kw'), method: val('#f-method'), timeoutMs: val('#f-to'), browser: !!(rootEl.querySelector('#f-browser') && rootEl.querySelector('#f-browser').checked) } : null,
        agent: { enabled: chk('#f-ag'), port: val('#f-agport'), token: val('#f-agtoken'), tls: chk('#f-agtls'), fingerprint: chk('#f-agtls') ? val('#f-agfp').trim() : '', services: val('#f-svc') } }
    };
    // Validación en cliente: con TLS la huella es obligatoria (64 hex, con o sin ':').
    if (payload.checks.agent.enabled && payload.checks.agent.tls && !/^[0-9a-fA-F]{64}$/.test(payload.checks.agent.fingerprint.replace(/:/g, ''))) {
      var eb = rootEl.querySelector('[data-errors]');
      eb.innerHTML = '<div class="errors" role="alert"><ul><li>Con TLS activado, la huella SHA-256 del certificado es obligatoria: 64 caracteres hexadecimales, con o sin “:”.</li></ul></div>';
      rootEl.querySelector('.modal__body').scrollTop = 0;
      return;
    }
    var p = existing ? NOC.data.updateTarget(existing.id, payload) : NOC.data.createTarget(payload);
    p.then(function () { close(); ui.toast(existing ? 'Cambios guardados' : 'Objetivo agregado', 'ok'); })
     .catch(function (e) {
       var box = rootEl.querySelector('[data-errors]');
       box.innerHTML = '<div class="errors" role="alert"><ul>' + (e.errors || [e.message]).map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul></div>';
       rootEl.querySelector('.modal__body').scrollTop = 0;
     });
  }

  /* ---------- importar / exportar ---------- */
  function parseCsv(text) {
    var rows = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (rows.length && /^(nombre|name)\b/i.test(rows[0])) rows.shift();
    return rows.map(function (line) {
      var c = line.split(/[,;\t]/).map(function (x) { return x.trim(); });
      var addr = c[1] || '', isUrl = /^https?:\/\//i.test(addr);
      return { name: c[0], address: addr, kind: isUrl ? 'url' : 'host', tags: (c[2] || '').split('|'), group: c[4] || '',
        checks: { ping: true, ports: (c[3] || '').split('|'), ssl: isUrl && /^https:/i.test(addr), http: isUrl ? { expectedStatus: '200-399' } : null } };
    });
  }
  function importFile(file) {
    var rd = new FileReader();
    rd.onload = function () {
      var list;
      try {
        var txt = String(rd.result);
        if (/^\s*[\[{]/.test(txt)) { var j = JSON.parse(txt); list = Array.isArray(j) ? j : j.targets; }
        else list = parseCsv(txt);
      } catch (e) { ui.toast('El archivo no se pudo leer: ' + e.message, 'err'); return; }
      if (!Array.isArray(list) || !list.length) { ui.toast('El archivo no contiene objetivos.', 'err'); return; }
      ui.modal({ title: 'Importar ' + list.length + ' objetivos', body: '<p>¿Cómo quieres importarlos?</p>', actions: [
        { label: 'Cancelar' },
        { label: 'Reemplazar los actuales', kind: 'danger', onClick: function (close) { close(); apply(list, true); } },
        { label: 'Agregar a los actuales', kind: 'primary', onClick: function (close) { close(); apply(list, false); } }] });
    };
    rd.readAsText(file);
  }
  function apply(list, replace) {
    var current = store.targets().map(function (t) { var c = U.clone(t); c.id = undefined; return c; });
    var merged = replace ? list : current.concat(list);
    // los existentes conservan su id para no perder historial
    if (!replace) store.targets().forEach(function (t, i) { merged[i].id = t.id; });
    NOC.data.replaceTargets(merged).then(function () { ui.toast('Importación completa', 'ok'); })
      .catch(function (e) { ui.modal({ title: 'No se pudo importar', body: '<div class="errors"><ul>' + (e.errors || [e.message]).map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul></div>', actions: [{ label: 'Cerrar' }] }); });
  }
  function exportJson() {
    var out = store.targets().map(function (t) { var c = U.clone(t); delete c.id; if (c.checks && c.checks.agent) { delete c.checks.agent.hasToken; delete c.checks.agent.token; } return c; });
    ui.download('objetivos-centinela.json', JSON.stringify({ targets: out }, null, 2));
  }

  NOC.views = NOC.views || {};
  NOC.views.targets = {
    mount: function (el) {
      root = el;
      el.innerHTML = '<div class="toolbar"><div><h1 class="page-title">Objetivos <span class="org-title" data-org-title></span></h1><div class="page-sub">IPs y URLs que se monitorean en la organización activa. Ponles nombre y etiquetas para identificar cada servicio. <span data-count></span></div></div><span class="sp"></span>' +
        '<input type="search" id="t-q" placeholder="Buscar…" aria-label="Buscar objetivos" style="width:200px">' +
        '<button type="button" class="btn" data-import>' + ui.icon('upload') + ' Importar</button><input type="file" id="t-file" accept=".json,.csv,.txt" hidden>' +
        '<button type="button" class="btn" data-export>' + ui.icon('download') + ' Exportar</button>' +
        '<button type="button" class="btn btn--primary" data-add>' + ui.icon('plus') + ' Agregar objetivo</button></div>' +
        '<div class="panel"><div class="table-scroll" data-body></div></div>' +
        '<p class="muted" style="margin-top:10px;font-size:12px">Importar CSV: <code>nombre,dirección,etiquetas|con|barra,puertos|con|barra,grupo</code> (una fila por objetivo; si la dirección empieza con http se trata como URL).</p>';
      el.addEventListener('click', function (e) {
        if (e.target.closest('[data-add]')) return openForm(null);
        if (e.target.closest('[data-import]')) return el.querySelector('#t-file').click();
        if (e.target.closest('[data-export]')) return exportJson();
        var row = e.target.closest('tr[data-id]'); if (!row) return;
        var t = store.getTarget(row.getAttribute('data-id')); if (!t) return;
        if (e.target.closest('[data-edit]')) openForm(t);
        if (e.target.closest('[data-del]')) ui.confirm('Eliminar objetivo', '¿Eliminar <b>' + U.esc(t.name) + '</b> (' + U.esc(t.address) + ')? Se pierde su historial.', 'Eliminar', function () {
          NOC.data.removeTarget(t.id).then(function () { ui.toast('Objetivo eliminado', 'ok'); }, function (er) { ui.toast(er.message, 'err'); });
        }, true);
      });
      el.addEventListener('change', function (e) {
        if (e.target.matches('#t-file') && e.target.files[0]) { importFile(e.target.files[0]); e.target.value = ''; return; }
        if (e.target.matches('[data-toggle]')) {
          var t = store.getTarget(e.target.closest('tr').getAttribute('data-id')); if (!t) return;
          var body = U.clone(t); body.enabled = e.target.checked;
          NOC.data.updateTarget(t.id, body).catch(function (er) { ui.toast(er.message, 'err'); render(); });
        }
      });
      el.querySelector('#t-q').addEventListener('input', function (e) { filter = e.target.value; render(); });
      bus.on('targets', render); bus.on('data', render);
      render();
    }
  };
})(window.NOC = window.NOC || {});
