# Cambios del manual respecto al PDF original

Comparación entre `docs/Centinela-Manual-de-usuario.pdf` (56 páginas, versión 1.0.0, 15 de octubre de 2026) y `docs/manual/manual.md` (fecha 18 de noviembre de 2026). La fuente de verdad de cada dato es el código; entre paréntesis se indica el archivo donde se verificó.

El resto del contenido (capítulos 3 a 8 en lo no citado, 10, 15, 17 en lo no citado, 18 y anexos) se conservó tal cual. Las 30 imágenes se reutilizaron en su lugar original; la captura de portada (`p01-fig-000`) no se repite en el cuerpo. No se añadió ni quitó ninguna figura, así que la numeración (Figuras 1 a 15 y las 14 capturas del catálogo, sin número como en el original) no cambió. La Figura 8 usa sus dos imágenes (`p16-fig-008` y `p16-fig-009`), como el original.

## Cambios por sección

| Sección | Qué cambió | Por qué (fuente) |
|---|---|---|
| Portada (metadatos) | Fecha: 18 de noviembre de 2026. Versión `2.0.0`. | Indicación del encargo; la versión la fija el orquestador. |
| 1.3 Modo real y demostración | La demostración solo se activa al abrir `index.html` o si falla la comprobación inicial `/api/health`. Se añade nota: si el servidor responde pero falla la carga, el panel muestra “No se pudo cargar el panel” con **Reintentar**. | `js/services/data.js`, `js/app.js`. |
| 2.1 Requisitos | Se menciona que la imagen de contenedor trae Node 22. | `Dockerfile`. |
| 2.2 Arranque | Carpeta `centinela-monitor` (antes `noc-dashboard`). El paso 3 describe lo que imprime el arranque. Nuevo paso de inicio de sesión con la contraseña inicial. | `server/server.js` (mensajes de arranque), nombre del proyecto. |
| 2.3 Variables de entorno | `CENTINELA_ADMIN_PASSWORD`: ya no es `admin01`, es aleatoria si no se define (mín. 8 caracteres). Variables nuevas: `CENTINELA_ALLOWED_HOSTS`, `CENTINELA_COOKIE_SECURE`, `CENTINELA_CHECK_TIMEOUT_MS`. | `server/lib/auth.js`, `server/server.js`, `server/lib/scheduler.js`, `docs/despliegue-seguro.md`. |
| 2.4 Estructura de carpetas | Se quita `_legacy/` (ya no existe). Se añaden `docs/`, `test/` y los archivos de contenedor. `server/lib` también incluye usuarios y sesiones. | Árbol del proyecto. |
| 3.2 Estados | Nuevo motivo de DOWN: la verificación excede el tiempo máximo. | `server/lib/scheduler.js` (`TIMEOUT_REASON`, `down: true`). |
| 3.5 Mediciones | User-Agent: `Centinela-Monitor` sin versión (antes “Centinela-Monitor/1.0”). Tiempo agotado con respuesta a medias. Agente: máx. 1 MB. Nueva nota del plazo global de 120 s; en “verificar ahora” el plazo vencido responde 200 con el objetivo DOWN (nunca 504) y una verificación ya en curso responde 409. | `server/probes/http.js`, `server/lib/checks.js`, `server/lib/scheduler.js`, `server/server.js`. |
| 4. Recorrido | Se menciona la sección Usuarios y los iconos de usuario, llave y salida. | `js/app.js`, `index.html`. |
| 6.2 Formulario de objetivo | Token del agente: se descarta al cambiar dirección (también solo la ruta de una URL) o puerto, con aviso en el formulario (nota nueva). Servicios: el nombre debe empezar con letra o número. | `server/lib/validate.js`, `js/views/targets.js`. |
| 6.3 Errores de validación | Filas nuevas: dirección obligatoria y URL no válida. Se amplía la causa de “Nombre de servicio no válido”. | `server/lib/validate.js`. |
| 8.1 / Figura 12 | Nota bajo la figura: la captura (demostración) muestra el comando antiguo con `--token`; hoy el cuadro usa `CENTINELA_AGENT_TOKEN` y `--host`. | `js/views/settings.js`. |
| 8.2 Umbrales | Se sustituye la nota “un umbral no numérico se ignora” por las reglas actuales: aviso < crítico (SSL al revés), campos vacíos no equivalen a 0 (se omiten), avisos no pueden ser 0, errores de la API con lista, intervalo e historial se ajustan al límite. | `server/lib/validate.js` (`sanitizeSettings`, `settingsErrors`), `js/views/settings.js`. |
| 8.3 Conexión | Los datos del equipo servidor solo se entregan a administradores. | `server/server.js` (`/api/auth/me`). |
| 9.1 Usuario inicial | Reescrita: no hay `admin01`; contraseña de `CENTINELA_ADMIN_PASSWORD` (≥ 8) o aleatoria de 16 caracteres mostrada una vez en el registro (con ejemplo del registro); cambio obligatorio en el primer acceso, impuesto por el servidor con 403 `mustChange`; aviso ámbar y ventana no descartable. Texto ya sin “contraseña por defecto” en la lista. | `server/lib/auth.js`, `server/server.js`, `js/app.js`, `index.html`. |
| 9.2 Roles | El Lector hace traceroute solo sobre objetivos existentes. | `server/server.js`. |
| 9.3 Usuarios | Fila nueva “Obligar a cambiar la contraseña al entrar” (desmarcada al crear, marcada al editar, solo se aplica si hay contraseña nueva y no aparece al editar tu propio usuario, donde además cambiar la contraseña no cierra tu sesión actual); etiqueta “debe cambiar la contraseña”; límite de 200 usuarios. Notas bajo las Figuras 14 y 15 (las capturas son anteriores a esas funciones). | `js/views/users.js`, `server/lib/auth.js`. |
| 9.4 Sesiones | 12 h por inactividad y 7 días absolutos; 10 sesiones por usuario (500 en total); cookie `Secure` opcional; flujos en vivo 5 por sesión y 15 por usuario: el más antiguo se expulsa y queda en pausa (“En vivo en otra pestaña”), sin reapertura automática (se reconecta con un clic o al volver a ser visible); el cambio de contraseña exige una distinta de la actual. | `server/lib/auth.js`, `server/server.js`, `js/services/source-live.js`. |
| 9.5 Protección contra adivinar contraseñas | Convertida en tabla: 5 fallos usuario+IP → 60 s; > 20 fallos por IP en 10 min → 429; cambio de contraseña, 5 fallos → 429 y cierre de sesión; semáforo de 4 cálculos con “Servidor ocupado”. Nota del proxy. | `server/lib/auth.js`. |
| 9.6 Contraseña olvidada | El paso 3 ya no menciona `admin01`: contraseña de entorno o aleatoria nueva. | `server/lib/auth.js`. |
| 10.1 Eventos y alertas | Ejemplo de motivo nuevo (“La verificación excedió el tiempo máximo”). | `server/lib/scheduler.js`. |
| 10.2 Traceroute | Cupo de 1 traceroute por usuario además de los 3 simultáneos. | `server/server.js`. |
| 11.1 Instalación del agente | El comando usa `CENTINELA_AGENT_TOKEN=... node agent.js --port 9100 --host IP` (antes `--token`); ejemplo de PowerShell; salida esperada; nota-consejo sobre `ps`. | `agent/agent.js`, README. |
| 11.2 Parámetros del agente | Tabla actualizada: `--token` desaconsejado, variable preferida y con prioridad; `--host` recomendado; límite de 10 fallos por minuto y por IP (429); 400 ante peticiones mal formadas. | `agent/agent.js`. |
| 12. Seguridad | Reescrita: sin `admin01`; sesiones y bloqueos nuevos; filas nuevas “Hosts permitidos”, “Agente”, “Archivos de datos” (permisos 700/600), “Estado público” (sin versión); protección del navegador con 415 y escape de valores del agente y HTTP; límites ampliados. | Código citado arriba, `docs/despliegue-seguro.md`. |
| 13.1 Archivos de data/ | Permisos 700/600; `users.json` guarda la marca de cambio obligatorio. | `server/lib/store.js`, `server/lib/auth.js`. |
| 13.2 Objetivo | La estructura incluye `"browser": false` en `http`. | `server/lib/validate.js`. |
| 13.3 API REST | `/api/health` sin versión (devuelve `ok`, `mode`, `auth`); POST/PUT/DELETE siempre con `Content-Type: application/json` (415) y cuerpo objeto (400); 429 del login y del cambio de contraseña; `server` en `/api/auth/me` solo para administradores; `forceChange` en usuarios; límites de flujos en vivo; 404 al editar o borrar un objetivo inexistente; `check` responde 200 con el objetivo DOWN si vence el plazo (nunca 504) y 409 si ya hay una verificación en curso; `disabled` solo booleano; traceroute del Lector solo con `targetId` y 1 por usuario; 400 con `errors` en ajustes; 421 y 413. | `server/server.js`. |
| 14. Contenedor (intro, 14.1 a 14.6) | Imagen `node:22-bookworm-slim`; archivo `.env` con `CENTINELA_ADMIN_PASSWORD`; contraseña aleatoria en `docker logs centinela`; endurecimiento (`cap_drop: ALL` + `NET_RAW`, esta última necesaria: sin ella el ping falla por el `setcap` del binario; `no-new-privileges`, `read_only` + `tmpfs /tmp`, `mem_limit` 512m, `pids_limit` 256); `ping_group_range "0 65535"` (antes `0 2147483647`, que fallaba en Podman sin root); `/data` con permiso 700; filas nuevas en 14.4 y 14.6. | `compose.yml`, `Dockerfile`, `docs/despliegue-seguro.md`. |
| Ronda 2: seguridad y contenedor (2.3, 9.1, 11.1, 12, 14.1, 14.2) | `CENTINELA_ALLOWED_HOSTS` se pasa desde `compose.yml` (se define en `.env`), se recomienda en LAN y `localhost`, `127.0.0.1` y `::1` siempre se aceptan; la contraseña aleatoria queda en `docker logs`/`podman logs` aunque falle el arranque (cambiarla de inmediato y rotar el log); el token del agente viaja en claro (firewall o VLAN de gestión) y se añade un ejemplo de unidad systemd con `EnvironmentFile=`; en 8.2 los errores de Ajustes nombran cada umbral en español. | `server/server.js`, `server/lib/validate.js`, `compose.yml`, `docs/despliegue-seguro.md`. |
| 15.10 Pantalla de pared | Se añade la recomendación de un usuario Lector y la caducidad de sesión. | `server/lib/auth.js`. |
| 16. Solución de problemas | Filas nuevas: bloqueo por IP, servidor ocupado, contraseña inicial olvidada, cambio obligatorio, cierre por intentos, “No se pudo cargar el panel”, 421, 415, traceroute en curso, tiempo máximo excedido, agente 429, agente sin token, ajustes rechazados. Se actualizan las de sesión, demostración, conexión, ping y token del agente. | Código citado arriba. |
| 17. Limitaciones | Se añaden sesiones en memoria, límite por IP detrás de un proxy y 200 usuarios. | `server/lib/auth.js`. |
| 18. Glosario | Términos nuevos: Sesión, DNS rebinding, CSRF. | Capítulos 9 y 12. |

## Revisión 2.1.0 (fase 3)

Revisión sobre el manual 2.0.0, con la versión `2.1.0` en los metadatos y en los ejemplos de arranque (propuesta pendiente de aprobación formal). Fecha: 18 de noviembre de 2026. Fuente de verdad: el código (archivo entre paréntesis).

| Sección | Qué cambió | Por qué (fuente) |
|---|---|---|
| Portada y ejemplos (2.2, 9.1) | Versión `2.1.0`; ejemplos “Centinela 2.1.0 →”. | Propuesta del orquestador. |
| 2.3 Variables | Fila nueva `CENTINELA_TRUST_PROXY`; `CENTINELA_CHECK_TIMEOUT_MS` menciona el tope de 2 × el plazo para sondas huérfanas. | `server/server.js` (`TRUSTED_PROXIES`), `server/lib/scheduler.js`. |
| 3.5 Mediciones | Fila del agente con TLS y plazo absoluto de 10 s. Subsecciones nuevas “Verificaciones colgadas” (tope 2 × plazo, capacidad reducida, avisos de consola) y “Límites de verificar ahora” (409; 429 con `Retry-After` a menos de 5 s por objetivo; 429 con 3 simultáneas o 30 por minuto por usuario, por IP sin autenticación). | `server/lib/scheduler.js`, `server/server.js` (`hTargetCheck`), `server/lib/checks.js`. |
| 6.2 Formulario (agente) | Filas nuevas “Conexión cifrada (TLS)” y “Huella SHA-256 del certificado” (obligatoria con TLS); el token se descarta también al cambiar la huella o desactivar TLS; aviso actualizado; nota de huella obligatoria. | `server/lib/validate.js`, `js/views/targets.js`. |
| 6.3 Errores de validación | Filas nuevas: huella obligatoria y huella no válida. | `server/lib/validate.js`. |
| 8 Ajustes (Figura 12) y 8.3 | Se elimina la nota de que la captura es anterior (la figura la sustituye otra captura actual); el cuadro “Cómo medir servidores remotos” describe el paso opcional de TLS. | `js/views/settings.js`. |
| 9.3 Usuarios (Figuras 14 y 15) | Se eliminan las notas “la captura es anterior…” de ambas figuras (sustituidas por capturas actuales); los pies de figura mencionan la etiqueta y la casilla. La fila “Obligar a cambiar la contraseña al entrar” indica que la pestaña del usuario muestra el modal “Debes cambiar tu contraseña” (H-1). | `js/services/auth.js` (`verify`, `requireChange`), `js/views/users.js`. |
| 9.5 Protección contra adivinar contraseñas | El intento se cuenta antes de verificar la contraseña; mayúsculas y espacios del usuario comparten contador; la nota del proxy remite a `CENTINELA_TRUST_PROXY`. | `server/lib/auth.js` (`lockKey`, `reserve`, `cancelReserve`). |
| 11 Agente | Intro; pasos 3 y 5 de 11.1; opciones `--tls-cert`/`--tls-key` y variables `CENTINELA_AGENT_TLS_CERT`/`_KEY` en 11.2; sección nueva 11.4 “Conexión cifrada (TLS) y huella del certificado” (generación con `openssl`, arranque, huella impresa, errores, token descartado). | `agent/agent.js`, `server/lib/checks.js` (`agentFetch`). |
| 12 Seguridad y 12.1 nueva | Filas actualizadas (bloqueo de intentos, tokens, agente, límites) y fila “Proxy inverso”; sección 12.1 con el funcionamiento de `CENTINELA_TRUST_PROXY` (entrada más a la derecha no confiable, sin CIDR, puertos y `[v6]`, requisitos del proxy). | `server/server.js` (`parseForwarded`, `clientIp`). |
| 13.2 y 13.3 | `tls` y `fingerprint` en `checks.agent`; respuestas 429 de `check`. | `server/lib/validate.js`, `server/server.js`. |
| 14.2, 14.4, 14.5 y 14.6 | Notas de `CENTINELA_TRUST_PROXY` en contenedor (el `compose.yml` no la pasa); Podman: `podman restart` falla en podman sin root (“rootless netns: kill network process: permission denied”) y deja el contenedor detenido, alternativas (`podman-compose -p <proyecto> restart`, `podman stop` + `podman start`) y arranque con el equipo (`systemctl --user enable podman-restart.service`, `loginctl enable-linger $USER`); dos filas de problemas. | Laboratorio de la fase 3, `compose.yml`. |
| 16 Solución de problemas | Filas nuevas: huella ausente o distinta, agente lento, agente TLS que no arranca, 429 de verificar ahora, bloqueo compartido tras un proxy, aviso de `CENTINELA_TRUST_PROXY`, verificación huérfana, modal obligatorio, podman. | Código citado arriba. |
| 17 y 18 | Limitaciones del agente y del proxy reescritas; términos nuevos: huella, proxy de confianza, verificación huérfana. | Capítulos 11 y 12. |
| Anexos C y D (nuevos) | Tabla de variables de entorno (servidor y agente) y tabla de mensajes de error y códigos. | Todo lo anterior. |

Las figuras no cambian de número ni de posición; las imágenes de las Figuras 12, 14 y 15 las sustituye otro encargo.

## Revisión 2.2.0 (fase 4)

Revisión sobre el manual 2.1.0, con la versión `2.2.0` en los metadatos y en los ejemplos de arranque (propuesta pendiente de aprobación formal). Fecha: 18 de noviembre de 2026. Fuente de verdad: el código (archivo entre paréntesis).

| Sección | Qué cambió | Por qué (fuente) |
|---|---|---|
| Portada y ejemplos (2.2, 9.1) | Versión `2.2.0`; ejemplos “Centinela 2.2.0 →”. | Propuesta del orquestador. |
| 3.5 Mediciones (Ping) | Una muestra que no es un número finito (ausente, NaN, Infinity) cuenta como pérdida; la pérdida se redondea a 1 decimal; panel y servidor usan el mismo módulo. | `js/shared/stats.js`. |
| 6.2 Formulario (huella) y 6.3 | La huella admite 64 hexadecimales con “:” solo entre pares completos; formulario y servidor aplican el mismo formato. | `js/shared/fingerprint.js`, `js/views/targets.js`, `server/lib/validate.js`. |
| 8.2 Umbrales | Viñeta nueva con el mensaje de orden aviso/crítico (etiqueta con unidad en el formulario; sin unidad en la API; variante SSL con “se avisa con más días de margen”). | `js/shared/thresholds.js` (`orderMessage`), `js/views/settings.js`. |
| 13.3 API REST | Subsección nueva “Códigos para rutas y métodos”: 405 con `Allow`, 404, HEAD como GET (excepto `/api/stream`) y orden de comprobaciones (401, 403 en `/api/users*`, 403 de solo lectura en ruta inexistente). | `server/lib/routes.js`, `server/server.js` (`ROUTES`, `api()`). |
| 16 Solución de problemas | Fila nueva de 405; la de Ajustes cita el mensaje de orden. | Código citado arriba. |
| Anexo D | Filas nuevas: 405, 404, 405 de HEAD en `/api/stream`, 401, 403 de administrador, 403 de solo lectura y mensaje de orden de umbrales. Se aclara que antes muchos métodos no declarados daban 404 o 403. | `server/server.js` (`api()`). |

Los cambios de la fase 4 no alteran figuras ni capturas. La suite pasó a más de 380 pruebas (número final: lo fija el orquestador).

## Guía de uso 2.2.0 (documento nuevo)

Se añade `docs/manual/guia-uso.md`, una guía de uso separada del manual técnico (versión `2.2.0`, 18 de noviembre de 2026), para operadores, lectores y administradores en lo que toca a la interfaz. Se genera aparte como `docs/Centinela-Guia-de-uso.pdf` (ver `README.md`). No modifica `manual.md`. Fuente de verdad: el código de la interfaz (`index.html`, `js/app.js`, `js/views/*`, `js/widgets/*`, `js/services/auth.js`, `js/ui/grid.js`) y el manual.

- Contenido: primeros pasos, conceptos, Panel, catálogo de las 14 ventanas, Objetivos, Organizaciones, Ajustes, Usuarios y roles, recetas, preguntas frecuentes y dos anexos (glosario y matriz de roles). No incluye instalación, contenedor, variables de entorno ni API.
- Imágenes: reutiliza las de `docs/manual/img/` sin modificarlas. Las capturas `p15-fig-007` (Objetivos) y `p16-fig-008` (formulario) se usan con una nota en el pie porque son anteriores a la barra de organizaciones y a los campos de navegador, TLS y huella. No se usan `p05-fig-001`, `p11-fig-002` (anteriores a la barra de organizaciones), `p16-fig-009` (parte del agente sin TLS) ni `p40-fig-030` (solo muestra el estado vacío de Servicios del sistema). Tampoco se usan `p32-fig-019`, `p34-fig-021` y `p39-fig-029`, porque otras capturas cubren esas ventanas o la guía las describe solo con texto.

## Alertas por Telegram (versión 2.3.0, 19 de noviembre de 2026)

Capítulo nuevo en `manual.md` y en `guia-uso.md`. Los metadatos de versión de ambos documentos no cambian: los fija el usuario al aprobar el release. Fuente de verdad: el código (archivo entre paréntesis). Las capturas están pendientes: los marcadores `alertas-01.jpg` y `alertas-02.jpg` apuntan a `docs/manual/img/` (todavía no existen; hasta que se agreguen, el generador de PDF se detiene con “no se encuentra la imagen”). Los mensajes de Telegram se muestran como ejemplo en texto, sin captura.

| Documento y sección | Qué cambió | Por qué (fuente) |
|---|---|---|
| manual.md, capítulo 19 (nuevo, subsecciones 19.1 a 19.12) | Qué es y qué necesita, pasos con @BotFather, grupos, canales y bot dedicado, opciones, formato y reglas antirruido (N fallos, agrupación de 30 s, reinicios), token por entorno y `.env`, bloqueo, privacidad, rotación del token, estado y tabla de problemas frecuentes. Se numera 19 para no renumerar los capítulos y referencias existentes. | `js/views/alerts.js`, `server/lib/notify.js`, `server/lib/alerts-config.js`, `server/lib/channels/telegram.js`, `server/server.js`. |
| manual.md, 2.3 y 14.2 | Variables `CENTINELA_TELEGRAM_TOKEN` y `CENTINELA_ALERTS_DISABLED`. | `server/server.js`, `compose.yml`. |
| manual.md, 8.3 (nueva) | Remite al capítulo 19. La antigua 8.3 “Conexión y datos de demostración” pasa a ser 8.4. | `js/views/settings.js`. |
| manual.md, 12, 13.1, 13.3 | Fila de seguridad de las alertas; archivo `alerts.json`; rutas `/api/alerts*` (solo administradores, 400, 409, 429). | `server/server.js`, `server/lib/alerts-config.js`. |
| manual.md, 16, 17, 18 | Fila de solución de problemas; la limitación “Sin notificaciones externas” ya no es cierta y se reescribe (Telegram opcional y sus límites); términos nuevos (bot, token del bot, chat de destino, BotFather). | Código citado arriba. |
| manual.md, Anexos C y D | Variables nuevas y mensajes y códigos de las alertas. | Código citado arriba. |
| guia-uso.md, capítulo 11 (nuevo) | Versión breve para el administrador que lo configura: pasos, opciones, formato de avisos, estado y privacidad, y tabla de mensajes. Más 7.4 (remite al capítulo 11; la antigua 7.4 pasa a 7.5), fila en la matriz de roles, términos nuevos, la pregunta frecuente sobre correos y mensajes, y la tabla “Cómo leer esta guía”. | Código citado arriba. |

## Espera configurable de las alertas (versión 2.4.0)

Solo documentación del ajuste nuevo «Esperar antes de enviar». Los metadatos de versión de los manuales no cambian (siguen en 2.3.0) y los PDF se regeneran aparte.

| Documento y sección | Qué cambió | Por qué (fuente) |
|---|---|---|
| manual.md, 19.4 | Fila nueva «Esperar antes de enviar» (0, 10, 30 o 60 s; por defecto 30) con cuándo cambiarla. | `js/views/alerts.js`, `server/lib/alerts-config.js`. |
| manual.md, 19.5 | La fila «Agrupación» ya no dice «ventana de 30 segundos»: 30 s por defecto, configurable, y con 0 no se espera. Subsección nueva «Cuánto tarda en llegar un aviso» con la fórmula y un ejemplo (intervalo 10 s, N = 2). | `server/lib/notify.js` (`groupWindowMs`). |
| manual.md, 19.11 | Fila nueva «El aviso tarda en llegar»; la fila «Llegan muchos avisos» remite a la espera configurada. | Ídem. |
| manual.md, 13.3 | `GET, PUT /api/alerts` incluye `groupWindowSec` y su error 400. | `server/lib/alerts-config.js` (`validateUpdate`, `publicView`). |
| guia-uso.md, 11.2 y 11.3 | Fila de opción nueva, agrupación sin «30 segundos» fijos, viñeta «Cuánto tarda en llegar» con el ejemplo. | Ídem. |
| guia-uso.md, 11.5 | Fila nueva «El aviso tarda en llegar». | Ídem. |

## Tipos de alerta (versión 2.5.0, 19 de noviembre de 2026)

Documentación del panel «Qué avisar» (versión 2.5.0, aún sin publicar). Los metadatos de versión de los manuales no cambian (siguen en 2.4.0) y los PDF no se regeneran aún. Pendiente: la captura `img/alertas-02.jpg` debe regenerarse con el panel nuevo (mismo nombre de archivo; el marcador ya apunta a ella y su texto alternativo describe el panel «Qué avisar»).

| Documento y sección | Qué cambió | Por qué (fuente) |
|---|---|---|
| manual.md, 19 (introducción y 19.2) | La introducción menciona los tipos de aviso; el paso 6 manda a elegir «Qué avisar» antes de activar; texto alternativo de `alertas-02.jpg` actualizado. | `js/views/alerts.js`. |
| manual.md, 19.4 | Se quitan las filas «Avisar de recuperaciones» y «Avisar también de DEGRADADO»; fila «Qué avisar»; subsección nueva «Qué avisar» con los nueve tipos, qué dispara cada uno, umbrales de Ajustes que usa (8.2), valores por defecto, requisito de agente y aviso «Ningún tipo seleccionado». No se renumeró: va como `###` dentro de 19.4. | `server/lib/alert-types.js`, `server/lib/alerts-config.js`, `js/views/alerts.js`, `js/config/defaults.js`. |
| manual.md, 19.5 | Reglas generalizadas (N fallos, un aviso por problema, recuperación, reinicio, desactivar). Subsección nueva «Mensajes por tipo» (icono y etiqueta, recuperación, Mínimo y Completo). Subsección nueva «Reglas de cada tipo de aviso» (escalado, histéresis del disco, certificado vencido frente a caída, certificado renovado, «RECUPERADO», DNS y tiempo agotado, agente sin respuesta). Subsección nueva «Actualizar desde la 2.4.0 (y volver atrás)». Limpieza de caracteres invisibles. | `server/lib/notify.js`, `server/lib/alert-types.js`, `server/lib/alerts-config.js`. |
| manual.md, 19.11 | Filas actualizadas («No llega el aviso…», «No llega la recuperación», «Llegan muchos avisos», «Nada llega tras reiniciar») y nuevas (disco o CPU, certificado vencido, corte de DNS, «Ningún tipo seleccionado»). | Código citado arriba. |
| manual.md, 13.1, 13.3 y 17 | `alerts.json` guarda `notify` y los problemas avisados; `GET/PUT /api/alerts` con `notify` parcial, errores 400, compatibilidad con `notifyRecovery` y `notifyDegraded`, `version: 2`; `GET /api/alerts/status` con `activeByType`; la limitación de «solo avisa de cambios de estado» se reescribe. | `server/lib/alerts-config.js`, `server/lib/notify.js`, `server/server.js`. |
| guia-uso.md, 11 | Introducción, paso 6 y texto alternativo de la captura; opciones con la subsección «Qué avisar» (casillas y valores por defecto); 11.3 con tabla de mensajes y reglas en lenguaje sencillo, y «Si vienes de la versión 2.4.0»; 11.5 con filas nuevas. | Ídem. |
| CHANGELOG.md, README.md | Entrada «Sin publicar» (Agregado, Cambiado, Seguridad) y una línea en README. | Ídem. |

## Paso a paso del contenedor (versión 2.3.0)

Solo documentación; sin cambios de código ni de `compose.yml`. No se renumeró nada: las secciones 14.1 a 14.6 conservan su número y se añaden dos al final.

| Documento y sección | Qué cambió | Por qué (fuente) |
|---|---|---|
| manual.md, 14.1 | Consejo final que remite a 14.7 y 14.8. | Navegación. |
| manual.md, 14.6 | Siete filas nuevas: comando no reconocido, WSL2 o virtualización, puerto en uso, permiso en el socket de Docker, `.env` no leído, proveedor de compose o máquina de Podman. | Documentación de Docker y Podman; no verificadas en Windows. |
| manual.md, 14.7 (nueva) | Paso a paso en Linux: requisitos, obtener el proyecto, instalar Podman o Docker (Debian/Ubuntu y RHEL/Rocky/Alma), `.env`, construir, firewall, arranque automático, comprobación, mantenimiento y desinstalación. | `compose.yml`, `Dockerfile`, secciones 14.1 a 14.5. Solo se probó Podman sin root en Linux. |
| manual.md, 14.8 (nueva) | Paso a paso en Windows con Docker Desktop o Podman Desktop, con la nota de que no se probó. | Documentación de Docker, Podman y Microsoft; no probado. |
| guia-uso.md, “Antes de empezar” | Una frase que remite al capítulo 14 del manual. | La guía no duplica la instalación. |
| README.md, Contenedor | Línea que remite a 14.7 y 14.8. | Navegación. |

## Secciones sin cambios de contenido

Capítulos 3 (excepto 3.2 y 3.5), 5, 7, 10 (excepto los dos puntos indicados), 15 (excepto 15.10), Anexos A y B y el resto de las secciones 2, 6 y 8 se transcribieron del PDF. Solo hubo adaptaciones de formato: las celdas con una barra vertical se reescribieron con “o”, la nota “Cuidado” del capítulo 11 pasó a `> **Importante:**` (el generador solo admite Nota, Importante y Consejo) y las tablas de clave-valor del catálogo llevan una fila de cabecera (“Aspecto | Detalle”).

## Verificado y sin cambios

- La captura de inicio de sesión (Figura 13) no muestra ningún texto con `admin01`, por lo que no necesitó nota.
- La lista de usuarios (Figura 14) no muestra “contraseña por defecto”; se añadió nota solo por la etiqueta nueva.

## Contenedor con podman-compose 1.0.x (versión 2.5.1, 23 de noviembre de 2026)

| Sección | Cambio | Fuente |
|---|---|---|
| 14.4 | Filas de `sysctls` (forma de lista) y `healthcheck` (forma de texto), con el motivo (podman-compose 1.0.x). | `compose.yml`. |
| 14.5 | Nota nueva sobre podman-compose 1.0.x y los dos fallos de un `compose.yml` anterior. | Prueba del usuario en Ubuntu 24.04 con podman-compose 1.0.6. |
| 14.6 | Filas nuevas: «sysctl values must be in the form of KEY=VALUE» y «unhealthy» con podman-compose 1.0.x, con causa y solución. | Ídem. |
| 14.7 | Indicación para quitar el bloque `sysctls` con la línea nueva. | `compose.yml`. |
| Guía de uso | Solo cambia la versión y la fecha de la portada. | — |
