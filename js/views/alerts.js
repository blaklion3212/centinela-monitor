/* Sección «Alertas» de Ajustes (solo administradores): avisos por Telegram, con ayuda integrada.
   Consume /api/alerts*. Expone NOC.alertsPanel.mount(el). ES5, sin dependencias. */
(function (NOC) {
  'use strict';
  var U = NOC.util, ui = NOC.ui;

  var HELP_KEY = 'centinela.alerts.helpOpen'; // '1' abierto, '0' plegado (por navegador)
  var seq = 0; // prefijo único para ids si se monta más de una vez

  // Errores esperados de Telegram (RA-73): causa y acción.
  var ERR = {
    invalid_token: 'Telegram rechazó el token (401): revisa que lo copiaste completo desde @BotFather.',
    chat_not_found: 'Telegram no encuentra ese chat: escríbele primero al bot o añádelo al grupo y usa “Buscar mis chats”.',
    no_internet: 'No hay conexión con api.telegram.org: el servidor necesita salida a Internet por el puerto 443.',
    timeout: 'Telegram no respondió a tiempo: reintenta en un momento y revisa la salida a Internet del servidor.',
    rate_limited: 'Telegram pidió esperar antes de enviar más mensajes: reintenta pasado ese tiempo.',
    blocked: 'El bot fue bloqueado o expulsado del chat: vuelve a añadirlo o desbloquéalo y reintenta.',
    chat_is_bot: 'Ese destino es un bot (quizá el propio bot): un bot no puede escribir a otro. Escríbele al bot desde tu cuenta de Telegram y elige tu chat con “Buscar mis chats”.',
    not_started: 'Aún no has iniciado el chat con el bot: ábrelo en Telegram, pulsa “Iniciar” (/start) y reintenta.',
    unknown: 'Telegram devolvió un error inesperado: revisa el token y el chat, y reintenta.',
    no_token: 'Falta el token del bot: pégalo y pulsa “Guardar token”.',
    no_chat: 'Falta el chat de destino: pulsa “Buscar mis chats” o escribe su identificador.',
    alerts_disabled_by_env: 'Las alertas están desactivadas por la variable de entorno CENTINELA_ALERTS_DISABLED: quítala y reinicia el servidor.'
  };

  var STATE_TXT = { off: ['paused', 'Desactivadas'], ok: ['up', 'Funcionando'], error: ['down', 'Con errores'], blocked: ['degraded', 'Bloqueadas por el entorno'] };

  // Ayuda por campo (máximo dos frases).
  var HELP = {
    enabled: 'Si lo activas, Centinela avisa por Telegram cuando un servicio cambia de estado. Necesita token y chat de destino.',
    token: 'Es la clave del bot que te da @BotFather. Se guarda en el servidor y nunca se vuelve a mostrar completa.',
    chat: 'Es tu chat, grupo o canal donde llegarán los avisos, no el usuario del bot. Búscalo con el botón (tras escribirle al bot) o escribe su identificador o el @canal público.',
    detail: 'Mínimo envía solo el nombre del servicio, su organización y el estado. Completo añade además la dirección y el motivo.',
    fails: 'Cuántas comprobaciones fallidas seguidas hacen falta antes de avisar. Un número mayor evita falsas alarmas.',
    wait: 'Tiempo que Centinela junta los cambios antes de enviarlos en un solo mensaje. Con 0 avisa al instante, pero si caen muchos servicios a la vez recibirás más mensajes.',
    recovery: 'Envía un aviso cuando un servicio que estaba caído vuelve a funcionar.',
    degraded: 'Avisa también cuando un servicio pasa a DEGRADADO, no solo cuando cae. Genera más mensajes.'
  };

  function call(method, url, body) {
    var opts = { method: method, cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET') opts.body = JSON.stringify(body || {});
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (r.status === 401 && NOC.auth) NOC.auth.onUnauthorized();
        if (r.status === 403 && j && j.mustChange && NOC.auth) NOC.auth.requireChange();
        if (!r.ok) {
          var e = new Error((j && (j.error || (j.errors && j.errors[0]))) || 'Error HTTP ' + r.status);
          e.status = r.status; e.body = j; e.errors = (j && j.errors) || [e.message];
          e.retryAfter = parseInt(r.headers.get('Retry-After'), 10) || (j && j.retryAfter) || 0;
          throw e;
        }
        return j;
      });
    }, function () {
      var e = new Error('No se pudo contactar con el servidor de Centinela.'); e.status = 0; e.errors = [e.message]; throw e;
    });
  }

  function readHelpOpen(def) {
    try { var v = localStorage.getItem(HELP_KEY); if (v === '1') return true; if (v === '0') return false; } catch (e) { /* sin almacenamiento */ }
    return def;
  }
  function saveHelpOpen(open) { try { localStorage.setItem(HELP_KEY, open ? '1' : '0'); } catch (e) { /* sin almacenamiento */ } }

  function mount(el) {
    var id = 'al' + (++seq) + '-';
    var cfg = null, st = null, chats = null;

    function q(sel) { return el.querySelector(sel); }
    function helpBtn(key, label) {
      return '<button type="button" class="icon-btn al-q" data-help-for="' + key + '" aria-expanded="false" aria-controls="' + id + 'h-' + key + '" aria-label="Ayuda: ' + label + '">' + ui.icon('help') + '</button>';
    }
    function helpTxt(key) { return '<span class="hint al-help" id="' + id + 'h-' + key + '" data-help-text="' + key + '" hidden>' + U.esc(HELP[key]) + '</span>'; }
    function labelRow(forId, text, key) { return '<div class="al-lblrow"><label for="' + forId + '">' + text + '</label>' + helpBtn(key, text) + '</div>'; }

    function setBusy(btn, on) {
      if (!btn) return;
      btn.disabled = !!on; if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
      var s = btn.querySelector('.spin'); if (on && !s) { btn.insertAdjacentHTML('afterbegin', '<span class="spin" aria-hidden="true"></span>'); } else if (!on && s) { s.parentNode.removeChild(s); }
      if (!on) applyLocks();
    }

    // Texto y solución de un error con código (RA-73).
    function errHtml(code, serverMsg, wait) {
      var sol = ERR[code] || ERR.unknown;
      if (code === 'rate_limited' && wait) sol = 'Telegram pidió esperar ' + wait + ' s antes de enviar más mensajes: reintenta pasado ese tiempo.';
      var extra = serverMsg && serverMsg !== sol ? '<div class="muted al-detail">Detalle: ' + U.esc(serverMsg) + '</div>' : '';
      return '<div class="al-res al-res--err" data-code="' + U.esc(code || 'unknown') + '">' + ui.statusIcon('down') + '<div><b>No se pudo completar.</b> ' + U.esc(sol) + extra + '</div></div>';
    }
    function okHtml(text) { return '<div class="al-res al-res--ok">' + ui.statusIcon('up') + '<div>' + U.esc(text) + '</div></div>'; }
    function showResult(html) { var r = q('[data-result]'); if (r) r.innerHTML = html; }
    function showErrors(list) {
      q('[data-errors]').innerHTML = '<div class="errors" role="alert"><ul>' + list.map(function (x) { return '<li>' + U.esc(x) + '</li>'; }).join('') + '</ul></div>';
    }
    // Maneja un error HTTP de una acción (test/chats): 429, 409 y el resto.
    function actionError(er) {
      // 429 HTTP = limitador local de Centinela: se muestra su mensaje (no confundir con el aviso de Telegram).
      if (er.status === 429) return '<div class="al-res al-res--err">' + ui.statusIcon('down') + '<div><b>No se pudo completar.</b> ' + U.esc(er.message) + '</div></div>';
      if (er.status === 409 && er.body && er.body.error === 'alerts_disabled_by_env') return errHtml('alerts_disabled_by_env');
      if (er.status === 409 && er.body && er.body.code) return errHtml(er.body.code, er.message);
      return '<div class="al-res al-res--err">' + ui.statusIcon('down') + '<div><b>No se pudo completar.</b> ' + U.esc(er.message) + '</div></div>';
    }
    function bodyError(j) { return errHtml(j.code || 'unknown', j.message, j.code === 'rate_limited' ? j.retryAfter : 0); }

    function tokenText() {
      if (!cfg.tokenConfigured) return 'Sin token guardado.';
      return 'configurado (' + U.esc(cfg.tokenHint || '…') + ')' + (cfg.tokenSource === 'env' ? ' · definido por variable de entorno' : '');
    }

    function renderStatus() {
      var box = q('[data-status]'); if (!box) return;
      var empty = !cfg.tokenConfigured && !cfg.chatId, kind, label;
      if (empty) { kind = 'unknown'; label = 'Sin configurar'; }
      else { var m = STATE_TXT[(st && st.state) || (cfg.blockedByEnv ? 'blocked' : cfg.enabled ? 'ok' : 'off')] || STATE_TXT.off; kind = m[0]; label = m[1]; }
      var h = '<span class="status status--' + kind + '" data-state>' + ui.statusIcon(kind) + U.esc(label) + '</span>';
      if (empty) h += '<p class="muted al-detail">Aún no hay token ni chat. Sigue los pasos de “Cómo configurarlo”, más arriba.</p>';
      else if (st) {
        h += '<ul class="help-list al-stats">' +
          '<li>Último envío correcto: ' + (st.lastSentAt ? U.esc(U.fmt.dateTime(st.lastSentAt)) : 'ninguno todavía') + '</li>' +
          '<li>Último error: ' + (st.lastError ? U.esc(U.fmt.dateTime(st.lastError.at)) + ' · ' + U.esc(st.lastError.message || st.lastError.code || '') : 'ninguno') + '</li>' +
          '<li>En cola: ' + U.esc(String(st.queued || 0)) + ' · enviados: ' + U.esc(String(st.sentTotal || 0)) + ' · fallidos: ' + U.esc(String(st.failedTotal || 0)) + ' · descartados: ' + U.esc(String(st.droppedTotal || 0)) + '</li></ul>';
      }
      // Notas del servidor (p. ej. grupo migrado a supergrupo o variable de token no válida).
      if (st && st.note) h += '<p class="hint al-detail" data-note>' + U.esc(st.note) + '</p>';
      box.innerHTML = h;
    }

    function renderToken() {
      var t = q('[data-token-state]'); if (t) t.innerHTML = tokenText();
      var inp = q('#' + id + 'token'); if (inp) inp.value = '';
      applyLocks();
    }

    // Bloqueos por configuración (token por entorno, bloqueo global) sin tocar los botones en curso.
    function applyLocks() {
      if (!cfg) return;
      var env = cfg.tokenSource === 'env', blocked = !!cfg.blockedByEnv;
      var tk = q('#' + id + 'token'); if (tk) tk.disabled = env;
      [['[data-save-token]', env], ['[data-del-token]', env || !cfg.tokenConfigured], ['[data-test]', blocked], ['[data-find]', blocked]].forEach(function (p) {
        var b = q(p[0]); if (b && b.getAttribute('aria-busy') !== 'true') b.disabled = p[1];
      });
    }

    function renderChats() {
      var box = q('[data-chats]'); if (!box) return;
      if (!chats) { box.innerHTML = ''; return; }
      if (!chats.list.length) { box.innerHTML = '<p class="muted" data-chats-empty>' + U.esc(chats.hint || 'No se encontró ningún chat. Escríbele un mensaje al bot y vuelve a pulsar “Buscar mis chats”.') + '</p>'; return; }
      box.innerHTML = '<p class="muted al-detail">Elige el chat de destino (se rellena el campo; luego pulsa “Guardar”):</p><ul class="al-chats">' + chats.list.map(function (c) {
        return '<li><button type="button" class="btn btn--sm" data-chat-id="' + U.esc(String(c.id)) + '">' + ui.icon('link') + '<span><b>' + U.esc(c.title || '(sin título)') + '</b> · ' + U.esc(c.type || '') + (c.username ? ' · @' + U.esc(String(c.username).replace(/^@/, '')) : '') + ' · <code>' + U.esc(String(c.id)) + '</code></span></button></li>';
      }).join('') + '</ul><p class="muted al-detail" data-chats-check>Comprueba con “Enviar mensaje de prueba” que es el chat correcto.</p>' + (chats.hint ? '<p class="muted al-detail">' + U.esc(chats.hint) + '</p>' : '');
    }

    function helpPanel() {
      var def = !cfg.tokenConfigured && !cfg.chatId, open = readHelpOpen(def);
      return '<div class="al-guide" data-guide>' +
        '<h3 class="al-guide-h"><button type="button" class="btn btn--ghost al-guide-btn" data-guide-toggle aria-expanded="' + open + '" aria-controls="' + id + 'guide">' + ui.icon('help') + ' Cómo configurarlo</button></h3>' +
        '<div id="' + id + 'guide" class="al-guide-body" role="region" aria-label="Cómo configurarlo"' + (open ? '' : ' hidden') + '>' +
        '<ol class="help-list" data-steps>' +
        '<li>Abre <b>@BotFather</b> en Telegram, envía <code>/newbot</code>, sigue las preguntas y copia el token que te entrega.</li>' +
        '<li>Pega el token en el campo <b>Token del bot</b> y pulsa <b>Guardar token</b>.</li>' +
        '<li>Escríbele un mensaje al bot, o añádelo al grupo o canal donde quieres recibir los avisos.</li>' +
        '<li>Pulsa <b>Buscar mis chats</b> y elige el destino (se rellena el campo <b>Chat de destino</b>).</li>' +
        '<li>Pulsa <b>Enviar mensaje de prueba</b> y comprueba que llega a Telegram.</li>' +
        '<li>Activa <b>Enviar alertas por Telegram</b> y pulsa <b>Guardar</b>.</li></ol>' +
        '<p class="hint al-note"><b>Grupos:</b> si el bot no aparece en la búsqueda, escribe <code>/start@nombre_del_bot</code> en el grupo (o vuelve a añadirlo). <b>Canales:</b> el bot debe ser administrador del canal. Usa un <b>bot dedicado</b> a Centinela: si otro programa lo lee o tiene un webhook, la búsqueda falla. Siempre puedes escribir el chat a mano.</p>' +
        '</div>' +
        // El aviso de privacidad queda fuera de la región plegable: siempre visible (RA-71).
        '<p class="al-privacy" data-privacy>' + ui.icon('lock') + '<span><b>Privacidad.</b> Cada aviso sale de tu red local con el nombre del servicio y su organización; en modo Completo, también la dirección y el motivo. Pasa por los servidores de Telegram, y los chats con bots no tienen cifrado de extremo a extremo. El servidor necesita salida HTTPS al puerto 443 de <code>api.telegram.org</code>.</span></p>' +
        '</div>';
    }

    function form() {
      var env = cfg.tokenSource === 'env';
      return '<div data-env-warn>' + (cfg.blockedByEnv ? '<div class="errors" role="alert" data-blocked>' + ui.icon('alert') + ' Las alertas están bloqueadas por la variable de entorno CENTINELA_ALERTS_DISABLED. Quítala y reinicia el servidor para poder enviar, probar o buscar chats.</div>' : '') + '</div>' +
        helpPanel() +
        '<form id="' + id + 'form" novalidate autocomplete="off"><div data-errors></div>' +
        '<div class="field"><div class="al-lblrow"><label class="check" for="' + id + 'enabled"><input id="' + id + 'enabled" type="checkbox"' + (cfg.enabled ? ' checked' : '') + (cfg.blockedByEnv ? ' disabled' : '') + ' aria-describedby="' + id + 'h-enabled"> Enviar alertas por Telegram</label>' + helpBtn('enabled', 'Enviar alertas por Telegram') + '</div>' + helpTxt('enabled') + '</div>' +
        '<div class="field">' + labelRow(id + 'token', 'Token del bot', 'token') +
          '<div class="al-inline"><input id="' + id + 'token" type="password" autocomplete="off" spellcheck="false" maxlength="100" aria-describedby="' + id + 'h-token ' + id + 'token-st"' + (env ? ' disabled' : '') + '>' +
          '<button type="button" class="btn btn--sm" data-save-token>Guardar token</button><button type="button" class="btn btn--sm btn--danger" data-del-token>Borrar token</button></div>' +
          '<span class="hint" id="' + id + 'token-st" data-token-state>' + tokenText() + '</span>' +
          (env ? '<span class="hint" data-token-env>El token viene de la variable de entorno CENTINELA_TELEGRAM_TOKEN y no se puede cambiar desde aquí. Para usar otro, quita la variable y reinicia el servidor.</span>' : '') + helpTxt('token') + '</div>' +
        '<div class="field">' + labelRow(id + 'chat', 'Chat de destino', 'chat') +
          '<div class="al-inline"><input id="' + id + 'chat" type="text" autocomplete="off" spellcheck="false" maxlength="40" placeholder="-1001234567890 o @canal" value="' + U.esc(cfg.chatId || '') + '" aria-describedby="' + id + 'h-chat">' +
          '<button type="button" class="btn btn--sm" data-find>' + ui.icon('search') + ' Buscar mis chats</button></div>' +
          '<div data-chats aria-live="polite"></div>' + helpTxt('chat') + '</div>' +
        '<div class="row c2"><div class="field"><span class="lbl" id="' + id + 'detail-l">Nivel de detalle</span>' + '<div class="al-lblrow">' +
          '<div class="seg" role="group" aria-labelledby="' + id + 'detail-l" aria-describedby="' + id + 'h-detail"><button type="button" data-detail="minimal" aria-pressed="' + (cfg.detail !== 'full') + '">Mínimo</button><button type="button" data-detail="full" aria-pressed="' + (cfg.detail === 'full') + '">Completo</button></div>' + helpBtn('detail', 'Nivel de detalle') + '</div>' + helpTxt('detail') + '</div>' +
          '<div class="field">' + labelRow(id + 'fails', 'Avisar tras N fallos seguidos', 'fails') + '<input id="' + id + 'fails" type="number" min="1" max="10" step="1" value="' + U.esc(String(cfg.failsBeforeAlert || 2)) + '" aria-describedby="' + id + 'fails-h ' + id + 'h-fails"><span class="hint" id="' + id + 'fails-h">De 1 a 10.</span>' + helpTxt('fails') + '</div></div>' +
        '<div class="row c2"><div class="field">' + labelRow(id + 'wait', 'Esperar antes de enviar', 'wait') + '<select id="' + id + 'wait" aria-describedby="' + id + 'h-wait">' +
          [[0, 'Sin espera (al instante)'], [10, '10 segundos'], [30, '30 segundos (recomendado)'], [60, '60 segundos']].map(function (o) {
            var cur = typeof cfg.groupWindowSec === 'number' ? cfg.groupWindowSec : 30;
            return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select>' + helpTxt('wait') + '</div></div>' +
        '<div class="field"><div class="al-lblrow"><label class="check" for="' + id + 'recovery"><input id="' + id + 'recovery" type="checkbox"' + (cfg.notifyRecovery ? ' checked' : '') + ' aria-describedby="' + id + 'h-recovery"> Avisar de recuperaciones</label>' + helpBtn('recovery', 'Avisar de recuperaciones') + '</div>' + helpTxt('recovery') + '</div>' +
        '<div class="field"><div class="al-lblrow"><label class="check" for="' + id + 'degraded"><input id="' + id + 'degraded" type="checkbox"' + (cfg.notifyDegraded ? ' checked' : '') + ' aria-describedby="' + id + 'h-degraded"> Avisar también de DEGRADADO</label>' + helpBtn('degraded', 'Avisar también de DEGRADADO') + '</div>' + helpTxt('degraded') + '</div>' +
        '<div class="toolbar" style="margin:16px 0 0"><button type="submit" class="btn btn--primary" data-save>Guardar</button>' +
        '<button type="button" class="btn" data-test>' + ui.icon('zap') + ' Enviar mensaje de prueba</button></div>' +
        '<div data-result role="status" aria-live="polite" style="margin-top:10px"></div></form>' +
        '<h3 class="sec-title">Estado</h3><div class="al-statusrow"><div data-status></div><button type="button" class="btn btn--sm" data-refresh>' + ui.icon('reset') + ' Actualizar estado</button></div>';
    }

    function draw() {
      q('[data-body]').innerHTML = form();
      renderStatus(); renderChats(); applyLocks();
    }

    function loadStatus() {
      return call('GET', '/api/alerts/status').then(function (j) { st = j; }, function () { st = null; });
    }

    function load() {
      var body = q('[data-body]');
      body.innerHTML = '<p class="muted" data-loading><span class="spin" aria-hidden="true"></span> Cargando alertas…</p>';
      return call('GET', '/api/alerts').then(function (j) {
        cfg = j; return loadStatus();
      }).then(draw, function (er) {
        body.innerHTML = '<div class="errors" role="alert" data-load-error>No se pudo cargar la configuración de alertas: ' + U.esc(er.message) + '</div><button type="button" class="btn btn--sm" data-reload>Reintentar</button>';
      });
    }

    // Valor del desplegable de espera; si no es uno permitido se conserva el guardado (30 por defecto).
    function waitValue() {
      var v = String(q('#' + id + 'wait').value || '');
      return /^(0|10|30|60)$/.test(v) ? Number(v) : (typeof cfg.groupWindowSec === 'number' ? cfg.groupWindowSec : 30);
    }

    function currentChat() { return q('#' + id + 'chat').value.trim(); }

    function onSave(btn) {
      if (btn && btn.disabled) return; // ya hay un guardado en curso
      var errs = [], n = Number(q('#' + id + 'fails').value.trim());
      if (!/^\d+$/.test(q('#' + id + 'fails').value.trim()) || n < 1 || n > 10) errs.push('“Avisar tras N fallos seguidos” debe ser un número entero de 1 a 10.');
      var enabled = q('#' + id + 'enabled').checked;
      if (errs.length) { showErrors(errs); return; }
      q('[data-errors]').innerHTML = '';
      var body = { enabled: enabled, detail: q('[data-detail][aria-pressed="true"]').getAttribute('data-detail'),
        failsBeforeAlert: n, groupWindowSec: waitValue(), notifyRecovery: q('#' + id + 'recovery').checked, notifyDegraded: q('#' + id + 'degraded').checked };
      // El chat solo se envía si cambió respecto a lo guardado (evita pisar una migración hecha por el servidor).
      if (currentChat() !== (cfg.chatId || '')) body.chatId = currentChat();
      setBusy(btn, true);
      call('PUT', '/api/alerts', body).then(function (j) {
        cfg = j; ui.toast('Alertas guardadas', 'ok');
        q('#' + id + 'enabled').checked = !!cfg.enabled; q('#' + id + 'chat').value = cfg.chatId || '';
        return loadStatus().then(renderStatus);
      }, function (er) {
        if (er.status === 400 && er.errors && er.errors.length) showErrors(er.errors); else showErrors([er.message]);
      }).then(function () { setBusy(btn, false); });
    }

    function onSaveToken(btn) {
      var inp = q('#' + id + 'token'), v = inp.value.trim();
      if (!v) { showErrors(['Escribe o pega el token del bot antes de pulsar “Guardar token”.']); inp.focus(); return; }
      q('[data-errors]').innerHTML = '';
      setBusy(btn, true);
      call('PUT', '/api/alerts/token', { token: v }).then(function (j) {
        cfg.tokenConfigured = j.tokenConfigured; cfg.tokenHint = j.tokenHint; cfg.tokenSource = j.tokenSource || cfg.tokenSource;
        renderToken(); ui.toast('Token guardado', 'ok');
        return loadStatus().then(renderStatus);
      }, function (er) {
        inp.value = '';
        if (er.status === 409) showErrors(['El token viene de una variable de entorno y no se puede cambiar desde aquí.']);
        else showErrors(er.errors && er.errors.length ? er.errors : [er.message]);
      }).then(function () { setBusy(btn, false); });
    }

    function onDelToken(btn) {
      ui.confirm('Borrar token', '¿Borrar el token del bot? Las alertas dejarán de enviarse hasta que guardes uno nuevo.', 'Borrar', function () {
        q('[data-errors]').innerHTML = '';
        setBusy(btn, true);
        call('DELETE', '/api/alerts/token').then(function (j) {
          cfg.tokenConfigured = false; cfg.tokenHint = ''; if (j && typeof j.enabled === 'boolean') { cfg.enabled = j.enabled; q('#' + id + 'enabled').checked = j.enabled; }
          renderToken(); ui.toast('Token borrado', 'ok');
          return loadStatus().then(renderStatus);
        }, function (er) { showErrors(er.status === 409 ? ['El token viene de una variable de entorno y no se puede borrar desde aquí.'] : (er.errors || [er.message])); })
          .then(function () { setBusy(btn, false); });
      }, true);
    }

    function onTest(btn) {
      showResult('');
      var chat = currentChat();
      if (!cfg.tokenConfigured) { showResult(errHtml('no_token')); return; }
      if (!chat) { showResult(errHtml('no_chat')); return; }
      var body = chat !== (cfg.chatId || '') ? { chatId: chat } : {};
      setBusy(btn, true);
      call('POST', '/api/alerts/test', body).then(function (j) {
        // Tras una migración a supergrupo el servidor devuelve el chat nuevo: se refleja en el campo.
        if (j && j.ok && j.migratedTo) { cfg.chatId = String(j.migratedTo); q('#' + id + 'chat').value = cfg.chatId; }
        // Si se probó un chat que aún no está guardado, se recuerda que los avisos siguen yendo al guardado.
        var unsaved = j && j.ok && !j.migratedTo && body.chatId && body.chatId !== (cfg.chatId || '');
        showResult(j && j.ok ? okHtml('Mensaje de prueba enviado: revisa el chat en Telegram.' + (unsaved ? ' Pulsa “Guardar” para que los avisos vayan a este chat: hasta entonces se envían al chat guardado.' : '')) : bodyError(j || {}));
        return loadStatus().then(renderStatus);
      }, function (er) { showResult(actionError(er)); }).then(function () { setBusy(btn, false); });
    }

    function onFind(btn) {
      showResult(''); chats = null; renderChats();
      if (!cfg.tokenConfigured) { showResult(errHtml('no_token')); return; }
      setBusy(btn, true);
      call('POST', '/api/alerts/chats', {}).then(function (j) {
        if (j && j.ok) { chats = { list: j.chats || [], hint: j.hint || '' }; renderChats(); }
        else showResult(bodyError(j || {}));
      }, function (er) { showResult(actionError(er)); }).then(function () { setBusy(btn, false); });
    }

    function onRefresh(btn) {
      setBusy(btn, true);
      var inp = q('#' + id + 'chat'), clean = !inp || inp.value.trim() === (cfg.chatId || ''); // sin cambios sin guardar en el chat
      call('GET', '/api/alerts').then(function (j) { cfg = j; return loadStatus(); }).then(function () {
        renderStatus(); renderToken(); if (clean && inp) inp.value = cfg.chatId || ''; setBusy(btn, false);
      }, function (er) { setBusy(btn, false); ui.toast(er.message, 'err'); });
    }

    // Esqueleto fijo; el cuerpo se pinta tras cargar.
    el.innerHTML = '<div class="panel-head"><h2 id="' + id + 'title">' + ui.icon('zap') + ' Alertas</h2><span class="muted">Avisos por Telegram · solo administradores</span></div>' +
      '<div class="panel-body" data-body></div>';
    el.setAttribute('data-alerts', '');
    el.setAttribute('aria-labelledby', id + 'title');

    el.addEventListener('click', function (e) {
      var b;
      if ((b = e.target.closest('[data-help-for]'))) {
        var k = b.getAttribute('data-help-for'), t = q('[data-help-text="' + k + '"]'), open = b.getAttribute('aria-expanded') !== 'true';
        b.setAttribute('aria-expanded', String(open)); if (t) t.hidden = !open; return;
      }
      if ((b = e.target.closest('[data-guide-toggle]'))) {
        var o = b.getAttribute('aria-expanded') !== 'true';
        b.setAttribute('aria-expanded', String(o)); q('#' + id + 'guide').hidden = !o; saveHelpOpen(o); return;
      }
      if ((b = e.target.closest('[data-detail]'))) { el.querySelectorAll('[data-detail]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); return; }
      if ((b = e.target.closest('[data-chat-id]'))) { var inp = q('#' + id + 'chat'); inp.value = b.getAttribute('data-chat-id'); inp.focus(); ui.toast('Chat elegido: pulsa “Guardar” para conservarlo', 'ok'); return; }
      if ((b = e.target.closest('[data-reload]'))) return load();
      if (!(b = e.target.closest('button')) || b.disabled) return;
      if (b.hasAttribute('data-save-token')) onSaveToken(b);
      else if (b.hasAttribute('data-del-token')) onDelToken(b);
      else if (b.hasAttribute('data-test')) onTest(b);
      else if (b.hasAttribute('data-find')) onFind(b);
      else if (b.hasAttribute('data-refresh')) onRefresh(b);
    });
    el.addEventListener('submit', function (e) { e.preventDefault(); onSave(q('[data-save]')); });
    // Enter en el campo del token guarda el token (no el formulario completo).
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === id + 'token') { e.preventDefault(); var tb = q('[data-save-token]'); if (tb && !tb.disabled) onSaveToken(tb); }
    });

    load();
  }

  NOC.alertsPanel = { mount: mount };
})(window.NOC = window.NOC || {});
