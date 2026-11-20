# Requisitos: alertas opcionales por Telegram (versión 2.3.0)

> **Nota (versión 2.5.0):** este documento queda sustituido parcialmente por [alertas-tipos.md](alertas-tipos.md). Dejan de regir **RA-12** (campos `notifyRecovery` y `notifyDegraded`, ahora `notify`), **RA-40 a RA-44** (decisión de avisos por estado global del objetivo y el campo `alerted`, ahora por tipo y clave) y **RA-61** (las casillas «Avisar de recuperaciones» y «Avisar también de DEGRADADO», ahora el panel «Qué avisar»). El resto sigue vigente. Se conserva el texto original como historia de la 2.3.0 y la 2.4.0.

**Estado:** borrador para revisión del orquestador y aprobación del usuario.
**Fecha:** 2026-11-19
**Fuentes:** [plan-alertas.md](../plan-alertas.md) (secciones 2, 3 y 5), [propuesta-alertas-telegram.md](../propuesta-alertas-telegram.md), `server/lib/scheduler.js`, `server/server.js` (router declarativo y `api()`), `server/lib/validate.js`, `server/lib/store.js`, `js/views/settings.js`.

## 1. Alcance

### 1.1 Dentro del alcance (2.3.0)

- Avisos por Telegram cuando un objetivo pasa a CAÍDO (`down`), se recupera (`up`) y, opcionalmente, pasa a DEGRADADO (`degraded`).
- Función opcional, desactivada por defecto, activable solo por administradores desde Ajustes → Alertas.
- Un solo chat general, con diseño preparado para un chat por organización (función única `chatFor(orgId)`).
- Token del bot escrito en el panel (solo escritura) o en `CENTINELA_TELEGRAM_TOKEN`.
- Antirruido: N fallos seguidos, aviso de recuperación, agrupación por chat, sin reenvío al reiniciar.
- Cola con reintentos que respeta `retry_after`; envíos asíncronos con plazo de 10 s.
- Botones «Buscar mis chats» y «Enviar mensaje de prueba», indicador de estado.
- Ayuda integrada en el panel y documentación (manual, guía de uso, README, despliegue seguro, `compose.yml`).
- Pruebas automáticas con un servidor de Telegram simulado local.

### 1.2 Fuera de alcance (2.3.0)

- Interfaz para asignar un chat por organización (llega en 2.4.0; hoy el mapa existe pero está vacío).
- Horario silencioso.
- Comandos desde Telegram (`/estado`, etc.) y cualquier recepción continua de mensajes (no hay sondeo permanente de `getUpdates`).
- Otros canales (correo, webhook) y soporte de proxy HTTPS (la salida es directa).
- Persistencia de la cola entre reinicios (la cola vive en memoria; ver RA-39).
- Notificaciones de otros tipos de evento distintos de los cambios de estado de un objetivo.
- Pruebas contra el Telegram real (las hace el usuario en la fase 8 del plan).

## 2. Actores y permisos

| Actor | Permisos sobre alertas |
|---|---|
| Administrador | Ve y modifica la configuración, escribe o borra el token, usa los botones de búsqueda y prueba, ve el estado. |
| Operador (rol «standard» de escritura) | Nada: no ve la sección, el token ni los chats; sus respuestas de API no cambian. |
| Lector (`viewer`) | Nada, igual que el operador. |
| Anónimo | Nada (401). |
| Servidor de Telegram | Sistema externo (`api.telegram.org:443`); en pruebas, un servidor simulado local. |

Con `CENTINELA_AUTH=off` el usuario local ya es administrador (`LOCAL_USER`); se aplican las mismas rutas.

## 3. Supuestos

- S1. Node 18+, sin dependencias nuevas: se usa `https` nativo. La URL base de Telegram es una constante configurable (`CENTINELA_TELEGRAM_API_BASE`, solo para pruebas y no documentada para usuarios) para poder apuntar al simulador local, incluso `http://127.0.0.1:<puerto>`.
- S2. El scheduler emite `'event'` solo cuando cambia el estado (`scheduler.js` ~línea 174) y `'result'` en cada verificación. Para contar «N fallos seguidos» el módulo de notificaciones necesita `'result'` (el evento por sí solo no basta). `'result'` no trae nombre ni organización: se obtienen con `store.findTarget` y `store.getOrg(store.orgOf(id))`.
- S3. La configuración de alertas se guarda en un archivo propio, `data/alerts.json`, escrito con `store.write` (atómico, 0600). **No** va en `settings.json`: `GET /api/settings` es accesible a lectores, `/api/state` lo incluye y `broadcast('settings', …)` lo emite por SSE a todos los clientes, lo que filtraría configuración y chats a no administradores.
- S4. Las cifras de Telegram, confirmadas el 2026-11-19 con fuentes oficiales (anexo A), se tratan como constantes configurables. No se codifican valores fijos fuera de un único módulo de constantes.
- S5. Los estados de un objetivo son `up`, `degraded`, `down` (y `unknown` en la interfaz, que nunca genera aviso).
- S6. La zona horaria y el idioma de los mensajes son español; la hora del servidor se muestra en el mensaje completo.

## 4. Constantes configurables (referencia)

| Constante | Valor por defecto | Notas |
|---|---|---|
| `FAILS_BEFORE_ALERT` (ajuste `failsBeforeAlert`) | 2 | Entero 1 a 10. |
| `GROUP_WINDOW_MS` (ajuste `groupWindowSec`) | 30000 (30 s) | Ventana de agrupación por chat. Es el valor por defecto; el administrador elige 0, 10, 30 o 60 s (RA-99). |
| `SEND_TIMEOUT_MS` | 10000 | Plazo por petición a Telegram. |
| `MAX_ATTEMPTS` | 5 | Intentos por mensaje (incluye el primero). |
| `BACKOFF_MS` | 2000, 4000, 8000, 16000 | Esperas entre reintentos sin `retry_after`. |
| `MAX_QUEUE` | 200 | Tope de mensajes en cola; el exceso descarta los más antiguos y se cuenta. |
| `TG_MAX_TEXT` | 4096 | Longitud máxima de un mensaje; los grupos largos se parten. |
| `TG_MIN_GAP_CHAT_MS` | 1000 | Separación mínima entre mensajes al mismo chat. |
| `TG_MAX_PER_MIN_GROUP` | 20 | Mensajes por minuto en grupos. |
| `TG_MAX_PER_SEC_GLOBAL` | 30 | Mensajes por segundo en total. |
| `MAX_GROUP_LINES` | 20 | Líneas detalladas por mensaje agrupado; el resto se resume como «y N más». |
| `TEST_MIN_INTERVAL_MS` | 5000 | Separación entre pruebas o búsquedas por administrador. |

## 5. Requisitos

Convención: cada requisito tiene un identificador `RA-nn`. Los criterios usan Dado/Cuando/Entonces o listas comprobables. «Simulador» es el servidor de Telegram simulado local (S1). La columna «Decisión» de la sección 12 enlaza cada decisión del usuario con sus requisitos.

### 5.1 Activación

**RA-01. Desactivada por defecto.**
- Dado un `data/` sin `alerts.json`, cuando arranca el servidor, entonces la configuración vale `enabled=false`, no se crea suscripción de notificaciones y no se abre ninguna conexión de red (el simulador registra 0 peticiones tras ejecutar un ciclo completo de verificaciones con cambios de estado).
- Dado un `alerts.json` ausente o ilegible, entonces el servidor arranca igualmente con los valores por defecto (no falla).

**RA-02. Interruptor de administrador.**
- Dado un administrador, cuando envía `PUT /api/alerts` con `enabled=true` (con token y chat válidos), entonces la función queda activa y `GET /api/alerts` devuelve `enabled=true`.
- Dado un administrador, cuando activa sin token disponible o sin `chatId`, entonces recibe 400 con un mensaje que indica qué falta y `enabled` no cambia.

**RA-03. Desactivar vacía la cola y detiene el envío.**
- Dado un mensaje en cola o en espera de agrupación, cuando el administrador pone `enabled=false`, entonces la cola y las ventanas de agrupación quedan vacías, los temporizadores de reintento se cancelan y el simulador no recibe más peticiones de envío; los eventos posteriores no generan avisos.
- Las acciones explícitas de prueba y búsqueda de chats no dependen de `enabled` (ver RA-52).

**RA-04. Bloqueo por variable de entorno.**
- Dado `CENTINELA_ALERTS_DISABLED=1`, cuando el panel tiene `enabled=true`, entonces no se envía nada, el simulador recibe 0 peticiones (incluidas las de prueba y búsqueda) y `GET /api/alerts/status` informa `blockedByEnv=true`.
- Dado ese bloqueo, cuando se llama a `POST /api/alerts/test` o `/api/alerts/chats`, entonces la respuesta es 409 con `code: "alerts_disabled_by_env"` y un mensaje en español que explica la variable.
- Dado ese bloqueo, la interfaz muestra un aviso permanente en la sección y los botones de prueba y búsqueda aparecen deshabilitados con la explicación.
- Se interpreta como activa la variable con valor `1` (también `true`, sin distinguir mayúsculas); cualquier otro valor o ausencia la deja inactiva.

**RA-05. Sin efectos para no administradores.**
- Dado un operador o un lector, cuando consulta `GET /api/state`, `GET /api/settings` y el flujo `/api/stream`, entonces ninguna respuesta contiene claves `alerts`, `telegram`, `chatId`, `token` ni equivalentes, con la función activada o desactivada.
- Dado un no administrador, entonces la interfaz no muestra la entrada «Alertas» en Ajustes ni ningún aviso de configuración pendiente.
- Dado un cliente que ejecutaba la versión 2.2.x, las respuestas existentes conservan exactamente sus claves (comparación con las pruebas existentes).

**RA-06. Función desactivada = cero conexiones.**
- Dado `enabled=false` (o bloqueo por entorno), cuando se ejecutan 100 cambios de estado, entonces el simulador registra 0 peticiones y el proceso no abre sockets hacia `api.telegram.org` (verificable con un doble de `https.request` que falle si se invoca).

### 5.2 Configuración

**RA-10. Un chat general más un mapa por organización.**
- La configuración guarda `chatId` (cadena; vacía si no hay) y `orgChats` (objeto `{ orgId: chatId }`), inicialmente `{}`.
- En 2.3.0 la API no permite modificar `orgChats`: si `PUT /api/alerts` trae `orgChats` con alguna clave, responde 400 con «Los chats por organización aún no están disponibles». Un `orgChats` vacío o ausente es válido.
- Un `orgChats` presente en `alerts.json` (cargado a mano o por una versión futura) se conserva al guardar y se respeta, pero solo con claves de organizaciones existentes; las de organizaciones inexistentes se descartan al cargar.

**RA-11. Punto único de resolución de destino `chatFor(orgId)`.**
- Existe una única función `chatFor(orgId)` y todo código que decide el destino (envío, agrupación, antirruido, prueba) la usa; ninguna otra ruta de código lee `chatId` directamente para enviar.
- Hoy, para cualquier `orgId` (incluido `null`), devuelve el `chatId` general.
- Prueba unitaria: con `orgChats = { acme: "-100123" }` cargado en la configuración, `chatFor("acme")` devuelve `-100123`, `chatFor("otra")` y `chatFor(null)` devuelven el general, y el agrupador y el antirruido tratan ambos chats por separado (ver RA-31 y RA-34). Esta prueba demuestra la preparación para 2.4.0 sin exponerla en la interfaz.
- Si `chatFor` devuelve vacío (sin chat general ni propio), el aviso no se envía, se cuenta como «descartado: sin destino» en el estado y no lanza excepciones.

**RA-12. Opciones guardadas.** Campos de la configuración (modelo completo en la sección 8):
- `enabled` (booleano), `notifyDegraded` (booleano, por defecto `false`), `notifyRecovery` (booleano, por defecto `true`), `failsBeforeAlert` (1 a 10, por defecto 2), `detail` (`"minimal"` por defecto o `"full"`).
- Dado un valor fuera de rango o de tipo incorrecto, cuando se envía `PUT /api/alerts`, entonces responde 400 con `errors: [..]` (mismo formato que `settingsErrors`) y no guarda nada (la validación es atómica: todo o nada).
- Dado un cuerpo con claves desconocidas, entonces se ignoran y no se guardan.

**RA-13. Validación del chat.**
- `chatId` acepta un entero con signo de hasta 20 dígitos (p. ej. `123456789`, `-1001234567890`) dentro del rango de la Bot API (-4000000000000 a 1099511627775), o un `@usuario_canal` público (`^@[A-Za-z][A-Za-z0-9_]{4,31}$`). Se valida por rango numérico, no por el prefijo «-100». Cualquier otra cosa devuelve 400.

**RA-14. Persistencia segura.**
- La configuración se guarda con `store.write` (escritura atómica, archivo 0600, directorio 0700). Verificable comprobando permisos del archivo en Linux.
- Cada guardado de ajustes de alertas se anota en el log del servidor sin datos secretos (RA-22).

### 5.3 Token y secreto

**RA-20. Token escrito en el panel, solo escritura.**
- Dado un administrador, cuando envía `PUT /api/alerts/token` con `{ "token": "…" }` válido, entonces se guarda y la respuesta es `{ tokenConfigured: true, tokenHint: "…abcd" }` con los últimos 4 caracteres, sin el token.
- Ninguna respuesta de ninguna ruta devuelve el token completo ni una parte mayor que los últimos 4 caracteres.
- Formato válido (laxo, la validación real la hace `getMe`): número entero positivo sin cero inicial, `:`, y al menos 30 caracteres de `A-Za-z0-9_-`; longitud total ≤ 80 (`^[1-9]\d{0,17}:[A-Za-z0-9_-]{30,}$`: solo letras, dígitos, `_` y `-`); otro formato devuelve 400 con la explicación («Parece incompleto: cópialo entero desde BotFather»).
- Dado `DELETE /api/alerts/token`, cuando el token se había guardado en el panel, entonces se borra y, si estaba activada, la función queda desactivada automáticamente con un aviso en la respuesta (`enabled:false`).

**RA-21. Token por variable de entorno con prioridad.**
- Dado `CENTINELA_TELEGRAM_TOKEN` definida, cuando existe también un token guardado en el panel, entonces se usa el de la variable (`tokenSource: "env"`), el campo del panel se muestra bloqueado con una explicación y `PUT/DELETE /api/alerts/token` responden 409 con `code: "token_from_env"`.
- Dado solo el token del panel, `tokenSource` es `"panel"`; sin ninguno, `"none"`.
- La variable se lee en cada operación (no se copia a `alerts.json`): al quitarla y reiniciar, el token del panel, si existe, vuelve a usarse.
- Un valor de la variable con formato no válido se trata como no definido y `status` informa `tokenSource:"none"` con la nota «La variable no tiene formato de token».

**RA-22. El token nunca se filtra.** Dado un token conocido `T` usado en las pruebas, entonces:
- `T` (y su parte numérica del bot, antes de los dos puntos) no aparece en ninguna respuesta HTTP de la API (incluidos mensajes de error y 4xx/5xx), en el flujo `/api/stream`, en ningún evento (`scheduler.events`), en `GET /api/state`, ni en exportaciones de objetivos o ajustes.
- No aparece en la salida de `console.log/warn/error` del servidor, aun cuando una petición a Telegram falle: los mensajes de error de red o de HTTP que incluyan la URL (`/bot<TOKEN>/…`) se sanean sustituyendo el token por `bot***`.
- En `alerts.json` el token es la única ubicación persistente, junto a la variable de entorno; no se escribe en archivos de log, de depuración ni en `data/` salvo `alerts.json`.
- Las pruebas buscan `T` en todas las salidas capturadas y fallan si lo encuentran.

**RA-23. Error del canal sin URL.** Los errores devueltos al panel por «prueba» y «chats» son mensajes en español con código (`invalid_token`, `chat_not_found`, `no_internet`, `timeout`, `rate_limited`, `blocked`, `unknown`) y nunca contienen la URL de petición.

### 5.4 Envío y formato

**RA-30. Suscripción condicionada.** El módulo de notificaciones se suscribe a los eventos del planificador únicamente mientras la función está efectivamente activa (activada y no bloqueada por entorno, con token y chat). Al desactivarla se desuscribe.

**RA-31. Destino por chat.** Para cada aviso el destino se resuelve con `chatFor(ev.org)`; agrupación, antirruido, cola y límites de frecuencia se llevan por clave de chat de destino.

**RA-32. Mensaje en modo mínimo (por defecto).** Formato exacto:
- Con organización: `<icono> [<orgName>] <name>: <ESTADO>` p. ej. `🔴 [Cliente ACME] Portal intranet: CAÍDO`.
- Sin organización (`ev.org` nulo): `<icono> <name>: <ESTADO>`, sin corchetes ni espacio sobrante.
- Iconos y etiquetas: `down` → `🔴` y `CAÍDO`; `degraded` → `🟠` y `DEGRADADO`; `up` → `🟢` y `RECUPERADO`.
- No incluye dirección, motivo, IP ni hora (se verifica buscando esas cadenas en el texto enviado al simulador).
- La etiqueta se trata como texto: los caracteres especiales (`<`, `>`, `&`, `*`, `_`, `[`) de nombres de servicio u organización no alteran el formato. Se envía sin `parse_mode` o con escape completo, de modo que un nombre como `<b>x` llegue literal.

**RA-33. Mensaje en modo completo.** Añade a la línea del modo mínimo: la dirección del objetivo (de `store.findTarget(id).address`), el motivo (`ev.text`) y la hora del evento. Dado el estado `up`, el motivo es «Servicio recuperado». Campos vacíos se omiten sin dejar líneas en blanco. Todo el texto se recorta a `TG_MAX_TEXT`. Antes de enviarse, si la dirección es una URL se le quitan usuario, contraseña, query y fragmento (queda `protocolo://host[:puerto]/ruta`); un host o IP se deja tal cual. Los caracteres de control (U+0000–U+001F, U+007F, U+2028, U+2029) de nombre, etiqueta, dirección y motivo se sustituyen por espacios.

**RA-34. Agrupación por chat.**
- Dada la ventana de agrupación (30 s por defecto, configurable con `groupWindowSec`, ver RA-99), cuando llegan avisos para el mismo chat dentro de la ventana contada desde el primero, entonces se envían juntos en un solo mensaje con una línea por objetivo (en el formato del modo activo) y un encabezado con el recuento (p. ej. `3 avisos`).
- Dado un único aviso en la ventana, se envía como mensaje simple, sin encabezado de grupo.
- Dados avisos de dos chats distintos, entonces se forman grupos independientes (ver RA-11).
- Dado un grupo con más de `MAX_GROUP_LINES` líneas o más de `TG_MAX_TEXT` caracteres, entonces se parte en varios mensajes o se resume con «y N más», sin superar el límite.
- Orden de las líneas: por `ts` ascendente.

**RA-35. Orden y no bloqueo.** Los envíos son asíncronos: invocar el procesamiento de un aviso retorna antes de que Telegram responda. Con un simulador que tarda más de 10 s o que no responde, el planificador mantiene su cadencia de verificaciones (diferencia de tiempos entre verificaciones sin degradación mayor al margen de la prueba) y `scheduler.runOne` no espera por el envío.

**RA-36. Plazo de 10 s.** Cada petición a Telegram se aborta a `SEND_TIMEOUT_MS`. El aborto cuenta como intento fallido (`code: "timeout"`) y entra en reintento.

**RA-37. Sin dependencias nuevas.** `package.json` no añade dependencias; las peticiones usan `https` (o `http` si la base de pruebas lo requiere) de Node.

### 5.5 Antirruido y cola

**RA-40. Avisar tras N fallos seguidos.**
- Dado `failsBeforeAlert = N`, cuando un objetivo acumula N resultados consecutivos `down`, entonces se genera exactamente un aviso de caída (en la verificación N-ésima), y los siguientes `down` consecutivos no generan más avisos.
- Dado N = 1, el aviso se genera en la primera verificación `down`.
- Dado un `down` aislado (menos de N) seguido de `up`, entonces no se envía ningún aviso de caída ni de recuperación.
- Un resultado `degraded` no cuenta como fallo ni reinicia el contador `down`; interrumpe la racha solo un `up`.
- El contador se lleva por objetivo en memoria.

**RA-41. Aviso de recuperación.** Dado un objetivo que tuvo un aviso de caída enviado (o encolado) y vuelve a `up`, cuando `notifyRecovery` es verdadero, entonces se envía un aviso de recuperación. No se avisa recuperación de una caída que nunca se avisó (RA-40). Por defecto `notifyRecovery` es `true` (el plan indica que se avisa siempre que la función esté activa); el panel lo muestra como opción activada.

**RA-42. DEGRADADO opcional.** Con `notifyDegraded=false` (por defecto) un cambio a `degraded` no genera aviso; con `true` genera un aviso de degradación sujeto a las mismas reglas de N fallos seguidos, con N igual al valor configurado, contando resultados `degraded` o `down` consecutivos distintos de `up`. La recuperación posterior se avisa según RA-41.

**RA-43. Transiciones.** Matriz verificable por pruebas:
- `up→down` (tras N): aviso CAÍDO. `down→up`: aviso RECUPERADO (si hubo aviso previo).
- `down→degraded` (avisado como caído): nunca genera aviso, sea cual sea `notifyDegraded`; el objetivo sigue «avisado como caído» hasta `up`. Solo se avisa cuando la gravedad sube (con `notifyDegraded=true`: `up→degraded` tras N, aviso DEGRADADO).
- `degraded→down`: aviso CAÍDO tras N resultados `down` seguidos (el recuento de `down` empieza al pasar a `down`), sea cual sea `notifyDegraded`.
- `degraded→up`: aviso RECUPERADO solo si hubo aviso previo de degradación o caída.
- `unknown` no genera avisos.

**RA-44. Chat coherente tras reiniciar (decisión del usuario, 2026-11-19).**
- Centinela recuerda, en `data/alerts.json` (campo `alerted`), qué objetivos tienen una caída o degradación avisada y aún no recuperada. El campo se escribe de forma atómica y solo cuando cambia: al encolar un aviso de caída o degradación, al avisar la recuperación y al borrar un objetivo.
- Dado un reinicio y un objetivo que está en `alerted`:
  - Si sigue `down`/`degraded`, no se repite el aviso.
  - Cuando pasa a `up`, se avisa la recuperación (RA-41) y se quita de `alerted`.
- Dado un reinicio y un objetivo `down` que no está en `alerted`, se cuenta desde su primera verificación y se avisa tras N fallos seguidos (RA-40), como cualquier caída. Lo mismo vale para un objetivo `degraded` cuando `notifyDegraded` está activo.
- Un objetivo nuevo, creado con el servidor en marcha, sigue las mismas reglas: si está caído desde su primera verificación, se avisa tras N fallos.
- Los contadores de fallos viven en memoria y empiezan en 0 al arrancar.
- Los avisos que estaban en la cola o en una ventana de agrupación al reiniciar se pierden (RA-39). Su objetivo puede quedar en `alerted` sin que el aviso llegara a enviarse; se acepta, porque la recuperación sí se avisará.
- Al borrar un objetivo, sale de `alerted` y no se avisa su recuperación.
- Al desactivar la función, `alerted` se vacía: al volver a activarla se parte de cero y no se envían recuperaciones de caídas antiguas.

**RA-45. Cola con reintentos.**
- Dado un fallo transitorio (error de red, timeout, HTTP 5xx), cuando se envía un mensaje, entonces se reintenta con espera creciente (`BACKOFF_MS`) hasta `MAX_ATTEMPTS`; agotados, se descarta, se registra en el estado (`lastError`, contador de descartados) y se continúa con el siguiente.
- Dado un error definitivo (401 token inválido, 400 chat no encontrado, 403 bot bloqueado o expulsado), entonces no se reintenta, se descarta el mensaje y se registra el error. Un 401 repetido deja el estado en `error` y se muestra en el indicador, sin desactivar la función.
- Dado un fallo de un chat, los mensajes de otro chat se envían con normalidad (la cola no se bloquea entre chats).
- El tamaño de la cola está acotado por `MAX_QUEUE`; al superarse se descartan los más antiguos y se cuenta.

**RA-46. Respeto de `retry_after` (429).**
- Dado que Telegram responde 429 con `parameters.retry_after = R` (segundos), cuando se está enviando, entonces no se envía nada más a ese chat hasta pasados R segundos desde la respuesta (el simulador comprueba la separación) y el mensaje se reintenta sin consumir el contador de intentos que provoca descarte (cota: `MAX_RETRY_AFTER_S` = 3600; mayor valor se acota).
- Dado un 429 global (sin distinguir chat), se pausa todo el envío durante R segundos.
- Sin `retry_after` en un 429, se usa el siguiente valor de `BACKOFF_MS`.

**RA-47. Ritmo de envío.** Entre mensajes al mismo chat hay al menos `TG_MIN_GAP_CHAT_MS`, y el total no supera `TG_MAX_PER_SEC_GLOBAL` ni `TG_MAX_PER_MIN_GROUP` por grupo. El simulador mide intervalos y falla si se superan.

**RA-48. Parada limpia.** Al apagar el servidor (`shutdown`), los temporizadores de la cola y de la agrupación se cancelan (`unref` o limpieza) y el proceso termina sin esperar a Telegram.

**RA-39. Cola solo en memoria.** Reiniciar descarta la cola; esto es consistente con RA-44 y está documentado en la ayuda y el manual.

### 5.6 API

Todas las rutas se declaran en la tabla de rutas del router (`ROUTES`) con `access: 'admin'`. Se aplica el orden de comprobación vigente: 415 → 403 Origin → público → 401 → 403 cambio de contraseña obligatorio → 403 admin → 405 → 404.

**RA-50. Rutas y permisos.** Ver sección 7. Criterios:
- Anónimo en cualquier ruta de alertas: 401 con `login: true`.
- Operador o lector en cualquier ruta de alertas existente (con método válido o no): 403; el mensaje debe decir que se requiere administrador (no reutilizar «gestionar usuarios»; el mensaje se parametriza por ruta).
- Administrador con la contraseña temporal sin cambiar: 403 `mustChange`.
- Método no declarado en un patrón existente: 405 con cabecera `Allow` (p. ej. `DELETE /api/alerts` → 405 con `Allow: GET, PUT`), solo después de 401 y 403.
- Escritura sin `Content-Type: application/json`: 415. Origin ajeno: 403.
- Ruta de alertas inexistente (`/api/alerts/otra`): misma respuesta que cualquier ruta inexistente de la API (404; un lector que escribe recibe el 403 general de solo lectura). Decisión del 2026-11-19. Anónimos, 401.
- Cuerpo JSON inválido o demasiado grande: 400 (comportamiento de `readBody` existente).

**RA-51. `GET /api/alerts`.** Devuelve la configuración sin token: ver sección 7. Contiene `tokenConfigured`, `tokenHint`, `tokenSource` y `blockedByEnv`, y no contiene la clave `token`.

**RA-52. `POST /api/alerts/test` y `POST /api/alerts/chats`.**
- Son acciones explícitas del administrador y funcionan aunque `enabled=false` (necesarias antes de activar, según los pasos de la ayuda), salvo bloqueo por entorno (RA-04). Este es el único caso en que con la función desactivada se conecta a Telegram, y solo por un clic del administrador.
- `test` envía un mensaje de prueba a `chatFor(null)` (el chat general guardado, o el `chatId` opcional del cuerpo para probar uno aún no guardado). El mensaje de prueba lleva el texto fijo `✅ Centinela: mensaje de prueba` y la versión; no incluye datos de objetivos.
- `chats` consulta `getUpdates` (una sola llamada, sin sondeo permanente) y devuelve una lista deduplicada `{ id, type, title }` de los chats que contactaron al bot (privado, grupo, supergrupo, canal), máximo 20, sin los mensajes ni nombres de usuario de personas distintos del título del chat. Sin resultados: `chats: []` y una pista («Escríbele un mensaje al bot y vuelve a pulsar»).
- Resultados: 200 `{ ok: true }` o `{ ok: false, code, message }` para fallos esperados de Telegram (token inválido, chat no encontrado, sin internet, plazo agotado); el cuerpo `ok:false` con 200 permite a la interfaz mostrar el mensaje con su solución. Errores internos inesperados: 500 genérico sin detalles.
- 400 si falta token o no hay chat (`test`) con mensaje claro.
- 429 con cabecera `Retry-After` si se repite antes de `TEST_MIN_INTERVAL_MS` por administrador, o si hay otra prueba en curso (patrón de `hTargetCheck`).

**RA-53. `GET /api/alerts/status`.** Devuelve `state` (`off`, `ok`, `error`, `blocked`), `lastSentAt`, `lastError` `{ at, code, message }`, `queued`, `inWindow`, `sentTotal`, `failedTotal`, `droppedTotal`, `tokenSource`. No incluye texto de mensajes ni nombres de objetivos. Los mensajes de error pasan por el saneado de RA-22.

**RA-54. Respuestas coherentes.** Los errores de validación usan `{ errors: [..] }` con 400, y los demás `{ error: "…" }`, igual que el resto de la API. Todos los textos van en español.

**RA-55. Difusión por SSE.** Los cambios de configuración de alertas **no** se difunden por `/api/stream` (S3). Un administrador con varias pestañas ve el estado actualizado al abrir la sección o al pulsar «Actualizar estado»; no hay requisito de tiempo real.

### 5.7 Interfaz (Ajustes → Alertas)

**RA-60. Sección solo para administradores.** Dado un administrador, aparece «Alertas» en Ajustes (JS ES5, namespace `NOC`, sin dependencias). Dado otro rol, no se renderiza ni se solicita `/api/alerts`.

**RA-61. Controles.** La sección contiene: interruptor «Enviar alertas por Telegram» (apagado por defecto), campo de token (tipo contraseña, solo escritura, con botones Guardar token y Borrar token), campo Chat de destino con el botón «Buscar mis chats», selector de detalle (Mínimo/Completo), número «Avisar tras N fallos seguidos» (1 a 10, por defecto 2), casillas «Avisar de recuperaciones» y «Avisar también de DEGRADADO», botón «Enviar mensaje de prueba» e indicador de estado (último envío correcto, último error, cola).
- Sin horario silencioso ni selector de chat por organización (RA-90).

**RA-62. Token en la interfaz.** Dado un token guardado, el campo muestra «configurado (…abcd)» y nunca el valor completo; el campo de escritura queda vacío tras guardar; el campo `input` no se prellena y lleva `autocomplete="off"`. Con token por variable (`tokenSource:"env"`), el campo aparece bloqueado (deshabilitado) con el texto explicativo.

**RA-63. Estados de la interfaz.** Todos los botones muestran estado de carga (deshabilitados mientras la acción está en curso), el resultado de la prueba se muestra con color e icono y texto (no solo color), y los errores del servidor se muestran en un bloque `role="alert"` como en el resto de Ajustes.

**RA-64. Accesibilidad.** Cada campo tiene `label` asociado, los iconos de ayuda son botones alcanzables por teclado con `aria-label` y `aria-describedby`/región plegable que los referencia; el foco visible y el contraste cumplen la guía de diseño del proyecto (`checklist-diseno-accesibilidad`).

**RA-65. Texto escapado.** Todo texto proveniente del servidor (títulos de chats, mensajes de error) se inserta escapado (`U.esc`) para evitar inyección de HTML. Un chat llamado `<img onerror=…>` se muestra como texto.

**RA-66. Modo demo.** Si la aplicación corre en modo demostración sin servidor (datos en el navegador), la sección muestra un aviso «Disponible solo con el servidor» y no llama a la API.

**RA-67. Sin cambios en otros ajustes.** Guardar el formulario de ajustes existente no modifica la configuración de alertas ni viceversa (archivos y rutas independientes).

### 5.8 Ayuda integrada

**RA-70. Panel «Cómo configurarlo».** Dentro de la sección Alertas, plegable, abierto la primera vez que un administrador entra (mientras no haya token ni chat; el estado plegado se recuerda por navegador), con los seis pasos numerados del plan: 1) abrir @BotFather y enviar `/newbot` para copiar el token; 2) pegar el token en Centinela; 3) escribirle un mensaje al bot o añadirlo al grupo; 4) pulsar «Buscar mis chats» y elegir el destino; 5) pulsar «Enviar mensaje de prueba»; 6) activar el interruptor y guardar.
- Cada paso indica el botón o campo correspondiente con el mismo texto que la interfaz.
- Verificable: una prueba de interfaz comprueba la presencia de los seis pasos y que los textos de los botones citados existen en la sección.

**RA-71. Aviso de privacidad.** El panel incluye visible el texto sobre qué datos salen de la red local (nombre del servicio, organización, y en modo completo dirección y motivo), que pasan por los servidores de Telegram, que los chats con bots no tienen cifrado de extremo a extremo y que se necesita salida HTTPS al puerto 443 de `api.telegram.org`.

**RA-72. Ayuda por campo.** Cada campo (token, chat, detalle, N fallos, recuperación, DEGRADADO, interruptor) tiene un icono «?» con una explicación de máximo dos frases en español.

**RA-73. Errores con solución.** Cada código de error de RA-23 se traduce a un mensaje con la causa y la acción:
- `invalid_token`: «Telegram rechazó el token (401): revisa que lo copiaste completo desde @BotFather».
- `chat_not_found`: «Telegram no encuentra ese chat: escríbele primero al bot o añádelo al grupo y usa “Buscar mis chats”».
- `no_internet`: «No hay conexión con api.telegram.org: el servidor necesita salida a Internet por el puerto 443».
- `timeout`, `rate_limited` (con los segundos de espera), `blocked` (bot bloqueado o expulsado) y `unknown`.
- Verificable: una prueba por código simula el fallo en el simulador y comprueba que el texto mostrado contiene la solución indicada.

**RA-74. Primera vez y estado vacío.** Sin token ni chat, el indicador de estado dice «Sin configurar» y orienta al panel de ayuda, sin mostrar errores.

### 5.9 Documentación

**RA-80. Capítulo en el manual y la guía de uso.** `docs/manual/manual.md` y `docs/manual/guia-uso.md` incluyen el capítulo «Alertas por Telegram» (activación, pasos, privacidad, antirruido, solución de problemas), con capturas, y los PDF correspondientes se regeneran (regla del proyecto de mantener el manual PDF al día). Verificable: los títulos existen y la fecha o versión de los PDF es posterior.

**RA-81. README.** Documenta `CENTINELA_ALERTS_DISABLED` y `CENTINELA_TELEGRAM_TOKEN` (valores vacíos por defecto) y enlaza el capítulo.

**RA-82. `docs/despliegue-seguro.md`.** Nueva sección: token en `.env` y no en el repositorio, salida HTTPS al puerto 443, comportamiento en contenedor, y la nota de que no hay proxy soportado en 2.3.0.

**RA-83. `compose.yml`.** Añade `CENTINELA_TELEGRAM_TOKEN: ${CENTINELA_TELEGRAM_TOKEN:-}` y `CENTINELA_ALERTS_DISABLED: ${CENTINELA_ALERTS_DISABLED:-}` con comentarios en español. Con ambos vacíos el comportamiento es el de 2.2.x.

**RA-84. Problemas frecuentes.** Tabla síntoma / causa / solución con, como mínimo, los códigos de RA-23, «no llegan avisos tras reiniciar», «llegan muchos avisos» y «el bot no aparece en Buscar mis chats».

**RA-85. Versionado y bitácora.** CHANGELOG con la entrada 2.3.0, versión única en la fuente existente y registro en `docs/BITACORA.md`. Subir versión, etiquetar y publicar requieren aprobación del usuario.

### 5.10 Seguridad

**RA-90. Sin ampliación de superficie.** No se abre ningún puerto de escucha nuevo ni se reciben conexiones de Telegram (sin webhook).

**RA-91. Minimización por defecto.** El modo mínimo no incluye dirección ni motivo (RA-32). Los avisos de prueba no incluyen datos de objetivos.

**RA-92. Inyección y abuso.** Los nombres de objetivos y organizaciones llegan a Telegram solo como texto (RA-32); la ruta de prueba está limitada por frecuencia (RA-52); el `chatId` se valida (RA-13); la URL del canal se construye solo con el token validado por expresión regular (no admite `/`, `?`, `#`, espacios).

**RA-93. Redirecciones y TLS.** Las peticiones validan el certificado TLS (no se desactiva la verificación) y no siguen redirecciones.

**RA-94. Registro de eventos de seguridad.** Se registran en el log (sin secretos): activación, desactivación, alta y baja de token (indicando la fuente, no el valor), con el usuario que lo hizo.

**RA-95. Límite de tamaño de respuesta.** La lectura de respuestas de Telegram se limita (p. ej. 256 KiB) y se descarta el resto, para evitar consumo de memoria.

### 5.11 Pruebas y verificabilidad

**RA-96. Servidor simulado.** Las pruebas se ejecutan sin Internet con un servidor HTTP local que imita `sendMessage` y `getUpdates` de Telegram: registra peticiones (ruta, cuerpo, instante), permite programar respuestas (200, 401, 400, 403, 429 con `retry_after`, 5xx, silencio) y retardos. La base se inyecta con `CENTINELA_TELEGRAM_API_BASE` o por parámetro del módulo; se usa un reloj controlable (o plazos configurables reducidos) para no esperar tiempos reales de 30 s.

**RA-97. Cobertura mínima.** Existe al menos una prueba automática por cada criterio de aceptación de RA-01 a RA-67 y RA-90 a RA-95 marcado como verificable por prueba, y las pruebas existentes de la suite siguen pasando (sin modificarlas salvo que el contrato las requiera, en cuyo caso se informa).

**RA-98. Escenarios obligatorios** (derivan de la sección 6 del plan):
1. Desactivada: 0 peticiones al simulador con cambios de estado.
2. Activación con configuración válida y envío de un `down` tras N fallos.
3. Servicio que alterna caído/activo: no más de un aviso por ciclo según N.
4. Caída de Telegram (silencio y 5xx): las verificaciones siguen a cadencia normal.
5. 429 con `retry_after`: se respeta la espera.
6. Token no aparece en respuestas, logs ni eventos.
7. Permisos: lector, operador y anónimo reciben 403/401 en todas las rutas.
8. Agrupación por chat y prueba unitaria de `chatFor` con mapa.
9. Reinicio simulado: las caídas ya avisadas no se repiten, la recuperación pendiente se avisa y una caída no avisada se avisa tras N fallos (RA-44).
10. Variable `CENTINELA_ALERTS_DISABLED=1` y token por variable con prioridad.

### 5.12 Cambios de la versión 2.4.0

**RA-99. Espera configurable antes de enviar (`groupWindowSec`).** Hasta la 2.3.0 la ventana de agrupación era fija de 30 s; ahora es un ajuste cuyo valor por defecto sigue siendo 30 s. Motivo: el aviso de recuperación tardaba (intervalo de comprobación + 30 s).
- Campo `groupWindowSec` (entero, segundos) en `data/alerts.json`, en `GET /api/alerts` y en `PUT /api/alerts`. Valores permitidos: 0, 10, 30 y 60. Por defecto 30.
- Dado otro valor o tipo en `PUT /api/alerts`, entonces responde 400 con `errors` que incluye «La espera antes de enviar debe ser 0, 10, 30 o 60 segundos.» y no guarda nada.
- Dado un valor no válido en `alerts.json` al cargar, se trata como 30 y el archivo se reescribe saneado.
- Dado `groupWindowSec = 0`, el aviso se envía en cuanto se detecta el cambio, sin esperar; se siguen respetando `TG_MIN_GAP_CHAT_MS`, `TG_MAX_PER_MIN_GROUP` y la cola con reintentos (RA-45 a RA-47).
- El cambio se aplica a los avisos que se generen después de guardar; los ya en espera conservan su plazo.
- Interfaz: Ajustes → Alertas muestra el desplegable «Esperar antes de enviar» con «Sin espera (al instante)», «10 segundos», «30 segundos (recomendado)» y «60 segundos», con ayuda: «Tiempo que Centinela junta los cambios antes de enviarlos en un solo mensaje. Con 0 avisa al instante, pero si caen muchos servicios a la vez recibirás más mensajes.»
- La variable interna de pruebas `CENTINELA_ALERTS_GROUP_WINDOW_MS`, si se define, manda sobre el ajuste (solo pruebas).
- Tiempo aproximado hasta recibir un aviso: caída ≈ N fallos × intervalo del objetivo + espera; recuperación ≈ hasta un intervalo + espera; más 1 a 2 s de Telegram.

## 6. Casos límite

- Objetivo eliminado mientras había un aviso en cola: el aviso se envía igualmente con los datos ya capturados en el evento; el modo completo usa la dirección guardada en el momento del aviso, no una consulta posterior.
- Organización eliminada con chat propio en `orgChats`: la clave se limpia (hoy no aplica a la interfaz, pero el borrado de organización debe llamar a la limpieza del mapa).
- Objetivo deshabilitado: no genera resultados ni avisos; su contador se reinicia.
- Cambio de `failsBeforeAlert` en caliente: aplica a los contadores en curso sin reiniciarlos (si el nuevo N ya se cumple, el aviso sale en la siguiente verificación `down`).
- Cambio de `chatId` con avisos en cola o en ventana de agrupación: los ya encolados se envían al chat con el que se resolvieron; los nuevos usan el nuevo.
- Reloj del sistema con saltos: los plazos usan temporizadores relativos, no comparaciones de hora absoluta.
- Nombre muy largo (más de 200 caracteres): se recorta con «…» en la línea.
- Tormenta de eventos (p. ej. 500 objetivos caen a la vez): se agrupa y se parte según RA-34, sin superar `MAX_QUEUE`.
- Respuesta de Telegram con JSON inválido o `ok:false` sin descripción: error `unknown`, sin excepción no controlada.
- Dos pestañas de administrador guardando a la vez: gana la última escritura; no hay corrupción del archivo (escritura atómica).
- Servidor sin `data/` escribible: la API responde 500 genérico al guardar, la función sigue con la configuración en memoria y el error se registra en el log sin secretos.
- Un `chatId` de grupo migrado a supergrupo: Telegram devuelve `parameters.migrate_to_chat_id`. Si coincide con el chat general (o con uno de `orgChats`), se actualiza en `alerts.json`, se reintenta una vez, se registra en el log y el estado lo muestra («El grupo pasó a supergrupo; chat actualizado»). En la prueba con un `chatId` no guardado solo se informa del nuevo id.

## 7. Propuesta de rutas de API

Todas con `access: 'admin'`; escritura exige `Content-Type: application/json`; todos los textos en español.

| Método | Ruta | Cuerpo | Respuestas |
|---|---|---|---|
| GET | `/api/alerts` | — | 200 configuración (sin token); 401; 403; 405 no aplica |
| PUT | `/api/alerts` | Campos editables de la sección 8 | 200 configuración guardada; 400 `{errors}`; 401; 403; 415 |
| PUT | `/api/alerts/token` | `{ token }` | 200 `{ tokenConfigured, tokenHint, tokenSource }`; 400; 401; 403; 409 `token_from_env`; 415 |
| DELETE | `/api/alerts/token` | — | 200 `{ tokenConfigured:false, enabled }`; 401; 403; 409 `token_from_env` |
| POST | `/api/alerts/test` | `{ chatId? }` | 200 `{ ok, code?, message }`; 400 sin token o chat; 401; 403; 409 `alerts_disabled_by_env`; 415; 429 con `Retry-After` |
| POST | `/api/alerts/chats` | `{}` | 200 `{ ok, chats:[…], hint? }` o `{ ok:false, code, message }`; 401; 403; 409; 415; 429 con `Retry-After` |
| GET | `/api/alerts/status` | — | 200 estado (RA-53); 401; 403 |

Comportamiento común:
- 401 `{ error, login:true }` para anónimos. 403 para no administradores (mensaje específico de alertas) y con contraseña temporal pendiente `{ mustChange:true }`.
- 405 `{ error:'Método no permitido' }` con `Allow` cuando el patrón existe con otro método: `/api/alerts` admite GET y PUT; `/api/alerts/token`, PUT y DELETE; `/api/alerts/test` y `/api/alerts/chats`, POST; `/api/alerts/status`, GET (HEAD se trata como GET en las rutas GET).
- 404 para rutas bajo `/api/alerts/` no declaradas (tras 401 y 403).
- 429 en `test` y `chats` (RA-52). Las rutas de configuración no requieren límite de frecuencia salvo el tope general existente.
- Se separa el token del PUT general para que ninguna respuesta de configuración lo contenga ni lo refleje.

Ejemplo de respuesta de `GET /api/alerts`:

```json
{
  "enabled": false, "blockedByEnv": false,
  "tokenConfigured": true, "tokenHint": "…abcd", "tokenSource": "panel",
  "chatId": "-1001234567890", "orgChats": {},
  "detail": "minimal", "failsBeforeAlert": 2,
  "notifyRecovery": true, "notifyDegraded": false,
  "version": 1
}
```

## 8. Modelo de datos (`data/alerts.json`, 0600)

```json
{
  "version": 1,
  "enabled": false,
  "token": "",
  "chatId": "",
  "orgChats": {},
  "detail": "minimal",
  "failsBeforeAlert": 2,
  "groupWindowSec": 30,
  "notifyRecovery": true,
  "notifyDegraded": false,
  "alerted": {}
}
```

| Campo | Tipo | Valores y notas |
|---|---|---|
| `version` | entero | 1; permite migraciones futuras. |
| `enabled` | booleano | Por defecto `false`. |
| `token` | cadena | Solo en este archivo; vacía si no hay token del panel. **Nunca** se devuelve por API, log, evento ni exportación; `GET /api/alerts` lo sustituye por `tokenConfigured`, `tokenHint`, `tokenSource`. |
| `chatId` | cadena | Chat general (RA-13). |
| `orgChats` | objeto | `{ orgId: chatId }`; vacío en 2.3.0 (RA-10). |
| `detail` | `minimal` o `full` | Por defecto `minimal`. |
| `failsBeforeAlert` | entero 1–10 | Por defecto 2. |
| `groupWindowSec` | 0, 10, 30 o 60 | Espera antes de enviar, en segundos. Por defecto 30; un valor inválido en el archivo se trata como 30 (RA-99). |
| `notifyRecovery` | booleano | Por defecto `true`. |
| `notifyDegraded` | booleano | Por defecto `false`. |
| `alerted` | objeto | `{ targetId: "down" \| "degraded" }`. Lo gestiona el servidor (RA-44); no es editable por API. |

Estado en memoria (no persistente): contador de fallos por objetivo, ventanas de agrupación por chat, cola, contadores y último error. Reglas de saneado: igual que `sanitizeSettings`, tolerante al cargar (valores inválidos pasan a los valores por defecto y se reescribe el archivo) y estricto al recibir de la API (400).

## 9. Cambios previstos en el código (orientativo para la fase de arquitectura)

- `server/lib/notify.js` (núcleo), `server/lib/channels/telegram.js` (canal), validación en `server/lib/validate.js` o módulo propio, carga y guardado con `store.read/write`, rutas en `ROUTES` de `server/server.js`, vista en `js/views/` (ES5, namespace `NOC`).
- Ninguna ruta existente cambia su contrato.

## 10. Trazabilidad con las decisiones del usuario

| Decisión | Requisitos |
|---|---|
| 1. Opcional, desactivada por defecto, bloqueo por entorno | RA-01 a RA-06, RA-30, RA-52, RA-60 |
| 2. Un chat, diseño por organización con `chatFor(orgId)` | RA-10, RA-11, RA-31, RA-34, RA-98 (escenario 8) |
| 3. Token en panel (solo escritura) o variable; manda la variable | RA-20 a RA-23, RA-62, RA-98 (escenarios 6 y 10) |
| 4. Detalle mínimo con etiqueta de organización; opción completa | RA-32, RA-33, RA-61, RA-91 |
| 5. Ayuda integrada y documentación | RA-70 a RA-74, RA-80 a RA-84 |
| 6. Antirruido, cola, `retry_after`, plazo de 10 s, no bloqueo | RA-35, RA-36, RA-40 a RA-48, RA-98 |
| 7. Variante básica sin horario silencioso ni chats por organización en UI | Sección 1.2, RA-10, RA-61 |

## 11. Riesgos y dependencias

- El antirruido por N fallos exige conocer cada resultado, no solo los cambios de estado (S2): el diseño debe suscribirse a `'result'`, lo que amplía el contrato respecto a lo descrito en el plan (que mencionaba solo `'event'`).
- Las cifras de límites de Telegram están confirmadas (anexo A); el diseño las aísla en constantes por si Telegram las cambia.
- `GET /api/settings` y el SSE de ajustes llegan a lectores: por eso la configuración va separada (S3). Quien implemente no debe «aprovechar» `settings.json`.
- El mensaje 403 existente de la ruta `admin` dice «gestionar usuarios»; hay que parametrizarlo para alertas (RA-50).

## 12. Resoluciones de las preguntas (2026-11-19)

- **P1. Probar y buscar chats con la función desactivada: se acepta.** Son acciones explícitas del administrador y las únicas conexiones posibles con `enabled=false`. Con `CENTINELA_ALERTS_DISABLED=1` responden 409.
- **P2 y P3. Reinicio y objetivos nuevos:** el usuario eligió «chat siempre coherente». Se recuerdan las caídas avisadas y, tras un reinicio, se avisa la recuperación pendiente. Un objetivo nuevo caído se avisa tras N fallos. Ver RA-44.
- **P4. Recuperación:** se avisa en el primer `up`, solo si antes se avisó la caída de ese objetivo.
- **P5. Cola solo en memoria: se acepta.** Persistirla contradice «no reenviar al reiniciar».
- **P6. `CENTINELA_TELEGRAM_API_BASE`: se acepta** como variable interna para pruebas, sin documentarla para usuarios. Las pruebas de integración arrancan el servidor como proceso aparte y no pueden inyectar parámetros. El token nunca se envía a un host distinto del configurado.
- **P7. Cifras de Telegram:** confirmadas, ver el anexo A.
- **P8. Chat en el cuerpo de `test`: se acepta.** Permite probar el chat elegido en «Buscar mis chats» antes de guardarlo.

## Anexo A. Datos confirmados de la Bot API (investigación del 2026-11-19)

Fuentes: https://core.telegram.org/bots/faq, https://core.telegram.org/bots/api, https://core.telegram.org/api/bots/ids, https://core.telegram.org/bots/features y el código del servidor oficial (github.com/tdlib/telegram-bot-api).

**Límites:** como máximo 1 mensaje por segundo en un mismo chat, 20 por minuto en grupos y unos 30 por segundo en total.

**Errores:** la respuesta lleva `ok:false`, `error_code`, `description` y, opcionalmente, `parameters`. El reintento se decide por la clase del error, no por el texto de `description`, porque Telegram lo puede cambiar.

| Respuesta | Qué hacer |
|---|---|
| 429 | Esperar `parameters.retry_after` segundos y reintentar |
| 5xx o error de red | Reintentar con retroceso exponencial |
| 401 o 404 | Token o URL inválidos; no reintentar |
| 400 «chat not found» | Chat inválido; no reintentar |
| 400 con `parameters.migrate_to_chat_id` | El grupo pasó a supergrupo: actualizar el `chatId` guardado, reintentar una vez y registrarlo en el estado |
| 403 (bot bloqueado, expulsado o no es miembro) | Destino inválido; no reintentar |
| 409 en `getUpdates` | Hay un webhook activo u otro proceso leyendo el bot; explicar que hace falta un bot dedicado |

**`sendMessage`:**
- `text` de 1 a 4096 caracteres; se envía texto plano, sin `parse_mode`, para no tener que escapar caracteres.
- `link_preview_options: {is_disabled:true}` (`disable_web_page_preview` está obsoleto).
- `disable_notification` está disponible.

**`getUpdates` («Buscar mis chats»):**
- Se llama sin `offset` y con `timeout=0`, para no confirmar ni borrar actualizaciones que otro consumidor pudiera necesitar.
- No se envía `allowed_updates`, porque Telegram lo guarda como ajuste persistente del bot.
- Telegram guarda las actualizaciones 24 h.
- Los chats se obtienen de `message`, `channel_post` y `my_chat_member`.
- En grupos con privacy mode hay que escribir `/start@nombre_del_bot` o basta con añadir el bot, porque llega `my_chat_member`.
- En canales, el bot debe ser administrador.
- Siempre hay un campo manual para el `chatId` como alternativa.

**Identificadores:**
- El token sigue el formato `<id>:<secreto>`; el servidor oficial rechaza un token con 0 inicial, con `/`, sin `:` o con más de 80 caracteres.
- `chat_id` es positivo para usuarios, negativo para grupos y de -1000000000001 a -1997852516352 para supergrupos y canales.
- Todos caben en un `Number` de JavaScript (52 bits).

**Red:** basta HTTPS de salida a `api.telegram.org:443`. Hay reportes de IPv6 intermitente con `api.telegram.org`, así que se usa `autoSelectFamily` cuando Node lo soporta, con un plazo de 10 s. Si hace falta, se documenta forzar IPv4.

**Privacidad y token:**
- Los chats con bots son «cloud chats»: cifrados entre cliente y servidor, no de extremo a extremo.
- El token viaja en la ruta de la URL: nunca se registra en logs la URL ni `options.path`, y todo texto que se registre pasa por una función que oculta el token.
- Si el token se filtra, se rota con `/token` en @BotFather.
