# Arquitectura: alertas opcionales por Telegram (2.3.0)

**Fecha:** 2026-11-19
**Requisitos:** [alertas.md](alertas.md). Cada `RA-nn` citado aquí está definido allí.

## 1. Vista general

```
scheduler ──'result'──▶ notify.js ──▶ decisión (N fallos, alerted) ──▶ agrupador por chat ──▶ cola por chat ──▶ channels/telegram.js ──https──▶ api.telegram.org
                           ▲                                                                                     ▲
server.js (rutas /api/alerts*) ──▶ alerts-config.js (data/alerts.json) ─────── chatFor(orgId) ──────────────────┘
js/views/alerts.js (Ajustes → Alertas, solo administradores) ──fetch──▶ /api/alerts*
```

Hay tres módulos nuevos de servidor, una vista nueva y cambios acotados en `server/server.js`, `js/views/settings.js`, `index.html` y `compose.yml`. No se añaden dependencias.

## 2. Módulos y contratos

### 2.1 `server/lib/alerts-config.js`: configuración (sin red)

Carga, valida y guarda `data/alerts.json` con `store.read` y `store.write`, escritura atómica con permisos 0600. Las funciones son puras salvo `load` y `save`.

```js
DEFAULTS                       // modelo de la sección 8 de los requisitos
load(storeMod, orgIds)         // -> cfg saneado. Si falta o es ilegible, usa los valores por defecto. Reescribe el archivo si el saneado cambió algo.
                               //    Quita de orgChats las organizaciones que no existen.
save(storeMod, cfg)            // escritura atómica
validateUpdate(body, cfg)      // -> { errors: [..] } | { value: nextCfg }. Estricto (RA-12, RA-13, RA-10). Ignora claves desconocidas.
                               //    Nunca toca token ni alerted.
validateToken(str)             // -> bool (RA-20)
validateChatId(str)            // -> bool (RA-13)
tokenInfo(cfg, env)            // -> { token, source: 'env'|'panel'|'none', hint: '…abcd'|'', envInvalid: bool } (RA-21)
blockedByEnv(env)              // -> bool (RA-04)
publicView(cfg, env)           // -> respuesta de GET /api/alerts. Sin `token` ni `alerted` (RA-51).
chatFor(cfg, orgId)            // -> chatId | ''. ÚNICO punto de resolución de destino (RA-11).
effectiveOn(cfg, env)          // enabled && !blockedByEnv && token && chatId
```

### 2.2 `server/lib/channels/telegram.js`: canal (solo red)

No sabe nada de objetivos ni de la configuración de Centinela.

```js
create({ apiBase, timeoutMs, maxBodyBytes, httpModules? }) -> {
  sendMessage(token, chatId, text, opts?) // -> Promise<Res>. Texto plano, link_preview_options.is_disabled
  getMe(token)                            // -> Promise<Res>
  getUpdates(token)                       // -> Promise<Res>. Sin offset, timeout=0, sin allowed_updates (anexo A)
}
Res = { ok: true, result } |
      { ok: false, code, message, transient: bool, retryAfterS?: n, migrateTo?: id, status?: n }
code ∈ invalid_token | chat_not_found | blocked | rate_limited | timeout | no_internet | unknown
chatsFromUpdates(updates)  // -> [{ id, type, title }], deduplicados, como máximo 20 (RA-52)
redact(str, token)         // sustituye el token (y `/bot<algo>/`) por `bot***` (RA-22)
classify(status, body, err) // pura, para probarla sola (anexo A)
```

- **Base:** `apiBase` vale por defecto `https://api.telegram.org`. Con `CENTINELA_TELEGRAM_API_BASE` (variable interna para pruebas) solo se acepta `http://` hacia `127.0.0.1` o `localhost`, o `https://`; cualquier otro valor se ignora con un aviso. Al arrancar se registra que se usa una base alternativa, sin el token.
- **Conexión:**
  - Se usan `https.request` o `http.request` con `timeout` y abortan al vencer `timeoutMs` (RA-36).
  - Se pasa `autoSelectFamily: true` si la versión de Node lo admite.
  - Nunca se desactiva la verificación TLS y no se siguen redirecciones (RA-93).
  - La lectura de la respuesta se corta en `maxBodyBytes`, 256 KiB (RA-95).
- **Errores:** ningún mensaje devuelto ni registrado incluye la URL ni `options.path`. Todo pasa por `redact`.

### 2.3 `server/lib/notify.js`: motor de avisos

```js
create({ store, alertsStore, channel, env, log, clock?, consts? }) -> {
  start(scheduler)      // se suscribe a 'result' solo si effectiveOn (RA-30)
  stop()                // se desuscribe, cancela temporizadores y vacía la cola (RA-03, RA-48)
  reload()              // tras PUT/DELETE: vuelve a leer la configuración, se (des)suscribe y, si se desactivó, vacía `alerted` (RA-44)
  onResult(r)           // público para pruebas unitarias
  prune()               // quita de `alerted` y de los contadores los objetivos que ya no existen (RA-44)
  test(chatIdOpt)       // -> Promise<{ ok, code?, message }>. Funciona con enabled=false, salvo bloqueo por entorno (RA-52)
  findChats()           // -> Promise<{ ok, chats, hint? } | { ok:false, code, message }>
  status()              // -> objeto de RA-53
}
```

- **Lógica de decisión (`decide`):** función pura y exportada.

  `decide(prev, status, cfg) -> { next, action: null|'down'|'degraded'|'up' }`

  `prev` es `{ fails, alerted }` y la función implementa RA-40 a RA-44:
  - Los resultados `down`, y `degraded` cuando `notifyDegraded` está activo, incrementan `fails`. Un `up` lo reinicia.
  - Al llegar a N sin estar ya avisado, la acción es aviso de caída o degradación.
  - Un `up` con `alerted` activo produce la recuperación, solo si `notifyRecovery` está activo. Si no lo está, el objetivo sale de `alerted` en silencio.
  - Un `degraded` posterior a un `down` avisado no genera aviso cuando `notifyDegraded` está apagado.
- **`alerted`:** se guarda en `alerts.json` mediante `alertsStore.save` solo cuando cambia (RA-44).
- **Agrupador:** un temporizador por chat de `GROUP_WINDOW_MS` desde el primer aviso, con el formato de RA-32 a RA-34.
- **Cola:**
  - Una por chat, con su ritmo: `TG_MIN_GAP_CHAT_MS`, el global y el de grupo (RA-47).
  - Reintentos con `BACKOFF_MS` y `retry_after` acotado (RA-45, RA-46).
  - Tope de `MAX_QUEUE`.
  - `migrate_to_chat_id` actualiza el chat guardado y reintenta una vez (anexo A).
- **`clock`:** `{ now, setTimeout, clearTimeout }`, inyectable para que las pruebas usen un reloj falso.
- **`consts`:** sustituye las constantes de la sección 4 de los requisitos en las pruebas.

## 3. Integración en `server/server.js`

1. **Instancias:**
   - `alertsStore = { load, save }` sobre `alerts-config` y `store`.
   - `channel = telegram.create({ apiBase: env o predeterminado, timeoutMs: 10000, maxBodyBytes: 262144 })`.
   - `notifier = notify.create(...)`.
   - `notifier.start(scheduler)` dentro de `listen`, después de `scheduler.start()`. `notifier.stop()` en `shutdown()`.
2. **Rutas nuevas:** en `ROUTES`, todas con `access: 'admin'` y `deniedMsg: 'Solo un administrador puede configurar las alertas'` (sección 7 de los requisitos).
   - En `api()`, los dos 403 de administrador usan `route.deniedMsg` o `known.route.deniedMsg`. Si no existe, se mantiene «Solo un administrador puede gestionar usuarios», así que las pruebas existentes no cambian.
   - Las rutas `test` y `chats` llevan su propio límite por administrador (`TEST_MIN_INTERVAL_MS` y una acción en curso a la vez), siguiendo el patrón de `hTargetCheck`: 429 con `Retry-After`.
3. **Limpieza:** `targetsChanged()` y `hOrgsRemove()` llaman a `notifier.prune()`.
4. **Registro de seguridad (RA-94):** al activar o desactivar y al guardar o borrar el token, `console.log('[alertas] …por <usuario>')`, sin secretos.
5. **Lo que no cambia:** `/api/state`, `/api/settings` y el SSE (RA-05, RA-55).

## 4. Interfaz

- **`js/views/alerts.js` (nuevo):** ES5 con namespace `NOC`. Expone `NOC.alertsPanel.mount(el)`.
  - Cliente `call()` local, igual que en `js/views/users.js`.
  - Implementa RA-60 a RA-74: controles, ayuda plegable de 6 pasos (con el estado plegado recordado en `localStorage`), aviso de privacidad, iconos «?», errores con su solución y estado.
  - Todo texto que venga del servidor pasa por `U.esc`.
- **`js/views/settings.js`:** si `NOC.auth.can('users')` (rol administrador) y el modo es en vivo, añade un panel contenedor y llama a `mount`. En modo demostración muestra «Disponible solo con el servidor» (RA-66).
- **`index.html`:** `<script src="js/views/alerts.js">` antes de `settings.js`.
- **Estilos:** solo las clases existentes (`panel`, `field`, `hint`, `btn`, `errors`, `help-list`, `seg`). Si hiciera falta un estilo nuevo, se usan los tokens de `assets/`.

## 5. Variables de entorno

| Variable | Pública | Uso |
|---|---|---|
| `CENTINELA_TELEGRAM_TOKEN` | Sí | Token con prioridad sobre el del panel (RA-21) |
| `CENTINELA_ALERTS_DISABLED` | Sí | `1` o `true` bloquea la función (RA-04) |
| `CENTINELA_TELEGRAM_API_BASE` | No (pruebas) | Base del simulador; solo `http` en loopback o `https` |
| `CENTINELA_ALERTS_GROUP_WINDOW_MS` | No (pruebas) | Ventana de agrupación en pruebas de extremo a extremo; se acota entre 0 y 60000 |

## 6. Reparto del trabajo

| Bloque | Responsable | Depende de | Archivos |
|---|---|---|---|
| A. Configuración y canal | implementador A | — | `server/lib/alerts-config.js`, `server/lib/channels/telegram.js` |
| B. Motor de avisos | implementador B | contratos 2.1 y 2.2 (usa dobles) | `server/lib/notify.js` |
| C. Integración en el servidor | implementador C | A y B terminados | `server/server.js`, `compose.yml` |
| D. Interfaz y ayuda | desarrollador-frontend | contrato de la API (sección 7 de los requisitos) | `js/views/alerts.js`, `js/views/settings.js`, `index.html` |
| Pruebas | probador | A–D | `test/alerts-*.test.js`, `test/helpers/telegram-sim.js` |

A, B y D van en paralelo; C se hace después de A y B. Ningún bloque toca `data/`: toda ejecución usa `CENTINELA_DATA` apuntando a un directorio temporal.
