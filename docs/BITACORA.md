# Bitácora del proyecto Centinela

Registro cronológico de trabajo para poder retomar el proyecto en cualquier momento.
Toda la documentación del proyecto vive en `docs/`.

## Cómo retomar
1. Lee este archivo de arriba abajo (la entrada más reciente está al final).
2. Revisa la sección **Pendientes** de la última entrada.
3. Hallazgos detallados de la auditoría inicial: `docs/auditoria-2026-11-18.md`.
4. Reglas de trabajo del repositorio (orquestación, versionado): `CLAUDE.md`.

---

## 2026-11-18 · Fase 1: análisis y auditoría inicial

**Estado:** ✅ completada.

**Qué se hizo**
- Lectura del README y del código (~5 000 líneas: servidor Node sin dependencias, frontend vanilla JS, agente, Docker).
- Revisión de seguridad (auditor-seguridad) y de calidad (revisor-qa) en paralelo, en modo de solo lectura.
- El orquestador verificó en el código los hallazgos principales.

**Resultado:** 23 hallazgos de seguridad (1 crítico, 5 altos) y 7 bugs funcionales confirmados (1 crítico). Detalle en `docs/auditoria-2026-11-18.md`.

**Decisiones**
- El despliegue es **solo en red local** (respuesta del usuario). Por eso la protección contra SSRF hacia metadatos de la nube queda en prioridad baja.

---

## 2026-11-18 · Fase 2: correcciones

**Estado:** ⏳ en curso.

**Preparación**
- Respaldo previo a los cambios, sin `data/`: `/home/ozz-minia/Proyectos/centinela-monitor-respaldo-20261118.tar.gz`. El proyecto no tiene git.

**Reparto**

| Bloque | Responsable | Archivos |
|---|---|---|
| Servidor: autenticación, API, almacén | implementador A | `server/server.js`, `server/lib/auth.js`, `server/lib/store.js` |
| Validación, sondas, planificador, agente | implementador B | `server/lib/{validate,checks,scheduler,util}.js`, `server/probes/*`, `agent/*` |
| Frontend | implementador C | `js/**`, `index.html`, `assets/css/**`, README (2 líneas) |
| Docker y compose | orquestador | `Dockerfile`, `compose.yml` |

**Cambios del orquestador (Docker)**
- `Dockerfile`: `node:20-bookworm-slim` → `node:22-bookworm-slim`. Node 20 está sin soporte desde abril de 2026.
- `compose.yml`:
  - La contraseña `admin01` ya no está escrita en el archivo. Se lee de `${CENTINELA_ADMIN_PASSWORD}` en un archivo `.env`.
  - Endurecimiento: `cap_drop: ALL` (más `NET_RAW`), `no-new-privileges`, `read_only` con `tmpfs /tmp`, `mem_limit 512m` y `pids_limit 256`.
  - ⚠️ **Sin verificar:** en este equipo no hay Docker ni Podman. Hay que comprobar que `ping` funciona en el contenedor con `no-new-privileges`. Se apoya en `net.ipv4.ping_group_range`; si falla, quitar `no-new-privileges`.

**Implementador A (servidor) ✅**
- **Contraseña por defecto:** mientras el usuario tenga la contraseña por defecto, toda la API responde 403 `{mustChange:true}`. Solo quedan libres `/api/auth/me`, `/api/auth/password`, `/api/auth/logout` y `/api/health`.
- **Login:** `crypto.scrypt` asíncrono; semáforo de 4 logins simultáneos; más de 20 fallos por IP en 10 min dan 429.
- **Bloqueo de intentos:** `attempts.clear()` se sustituye por la expulsión de entradas antiguas, y los contadores caducan a los 15 min.
- **Sesiones:** como máximo 10 por usuario y caducidad absoluta de 7 días (la de 12 h por inactividad se mantiene). El usuario deshabilitado recibe el mensaje genérico.
- **Cookie:** `CENTINELA_COOKIE_SECURE=1` añade `Secure`.
- **`Host` permitidos:** `CENTINELA_ALLOWED_HOSTS` responde 421. Se aplica siempre que `CENTINELA_AUTH=off`; con la autenticación activa, solo si la variable está definida.
- **Entrada:** `readBody` rechaza JSON que no sea objeto (400). PUT y DELETE sobre un objetivo inexistente dan 404.
- **Traceroute:** el lector solo puede usarlo con `targetId`; cupo de 1 por usuario.
- **SSE:** como máximo 3 flujos por sesión y 200 en total; limpieza explícita; corte por contrapresión; revocación inmediata al caer la sesión.
- **`/api/health`:** ya no expone la versión.
- **`store.js`:** escribe a disco antes de actualizar la memoria; `fsync`; permisos 0600 en archivos y 0700 en el directorio.

**Implementador B (validación, sondas, agente) ✅**
- **Servicios:** `SERVICE_RE` exige que el primer carácter sea alfanumérico, y `--` va antes del nombre en `systemctl` y `pgrep`.
- **Token del agente:** se pierde si cambia la dirección o el puerto. Ojo: cambiar solo la ruta de una URL también lo pierde.
- **`agentFetch`:** siempre resuelve, admite como máximo 1 MB y la respuesta pasa por `normalizeAgent`.
- **Planificador:**
  - Plazo global de 120 s en `runOne`. Si vence, se conserva el resultado anterior; no se marca DOWN.
  - `reschedule` es selectivo: solo reprograma los objetivos que cambiaron.
- **`sanitizeSettings`:** ignora los valores vacíos y valida que el aviso sea menor que el crítico (en SSL, al revés).
- **Sondas:**
  - `http.js`: si vence el plazo con el cuerpo a medias, informa tiempo agotado; el User-Agent lleva la versión.
  - `dns.js`: `ptrCache` limitado a 1000 entradas.
- **Agente:** token por `CENTINELA_AGENT_TOKEN`; opción `--host`; tras 10 fallos de token por IP en un minuto responde 429.

**Implementador C (frontend) ✅**
- **Formularios:**
  - Ya se guardan los objetivos URL (`targets.js`).
  - Ajustes omite los campos vacíos y valida aviso/crítico.
- **Evaluación y gráficas:**
  - `evaluate.js`: HTTP correcto cuenta como "vivo" aunque falle el ping.
  - `charts.js`: el primer punto de la serie se sombrea bien.
- **Ventanas:** `grid.js` elimina el fondo huérfano de la ventana ampliada (`clearMaxBack`).
- **Seguridad:** valores del agente y de HTTP escapados en `infrastructure.js` y `application.js`.
- **Carga de datos:**
  - Sin carrera al cambiar de organización (`fetchState` y `switchSeq`).
  - Ante errores del servidor muestra "Reintentar" en lugar de pasar a demo.
- **Mensajes del servidor:**
  - Modal de cambio de contraseña obligatorio que no se puede cerrar (`ui.modal({persistent:true})`).
  - Se muestran los mensajes de 429 y 421.
  - El login ya no se queda colgado.
- **README:** quitado `_legacy/` y corregida la frase sobre permisos.

**Comprobación integrada del orquestador ✅**
- `node --check` pasa en todos los `.js`.
- Prueba de humo en loopback: `admin01` da 403 hasta cambiar la contraseña, el objetivo URL se crea (201), `/api/health` no lleva versión y los permisos de los datos son 0600/0700.

**Observaciones abiertas, para revisar en la verificación**
- Al cambiar la contraseña, los intentos fallidos con la contraseña actual no cuentan para el límite de intentos.
- Detrás de un proxy, el límite por IP es compartido por todos los usuarios.
- En Docker con `CENTINELA_AUTH=off` hay que definir `CENTINELA_ALLOWED_HOSTS`.
- Falta probar en un navegador el modal obligatorio, el botón "Reintentar" y la ventana ampliada.

**Pruebas (probador) ✅**
- Suite `node:test` en `test/`, sin dependencias. Se ejecuta con `npm test` (`node --test test/*.test.js`). El orquestador la volvió a ejecutar: **127/127 en verde, ~3 s**.
- **Archivos:** `evaluate`, `validate`, `auth`, `store`, `scheduler`, `agent-checks`, `parsers`, `charts` y `api` (integración con el servidor como proceso hijo en loopback). Helpers en `test/helpers/`.
- **Datos:** usa directorios temporales (`CENTINELA_DATA`) y no hace peticiones a Internet.
- **Cobertura del plazo de 120 s:** se prueba acortando `setTimeout`, porque la constante es interna.
- **Hallazgos menores, sin corregir:**
  - `tracert` registra `<1 ms` como 1 ms (`traceroute.js` ~28).
  - `charts.js` ~39 no sombrea la caída si toda la serie es `null`.
  - Un DELETE sin `Content-Type` JSON da 415.
- **Pendiente:** completar `.claude/proyecto/pruebas.md`; no hay umbral de cobertura ni CI.

**Pendientes**
- [x] Recibir e integrar los reportes de los implementadores A, B y C.
- [x] Suite `node:test` (probador) y ejecución en verde.
- [x] Prueba de laboratorio del contenedor con podman-compose (ver abajo).

**Laboratorio del contenedor ✅** (podman 5.7.0, podman-compose 1.5.0, rootless, Ubuntu 26.04)

El usuario instaló podman y podman-compose. El laboratorio usó el proyecto `podman-compose -p centinela-lab`.

**Bug encontrado y corregido:** con `net.ipv4.ping_group_range: "0 2147483647"` el contenedor no arranca en podman rootless (`crun: write to /proc/sys/net/ipv4/ping_group_range: Invalid argument`), porque los GID mayores de 65535 no existen en el espacio de nombres de usuario. Se cambió a `"0 65535"` en `compose.yml`, que sirve para Docker y para podman.

Resultado de las comprobaciones:

| Prueba | Resultado |
|---|---|
| Construcción con `node:22-bookworm-slim` | ✅ |
| Healthcheck | ✅ healthy |
| `/api/health` sin versión | ✅ |
| Acceso desde la IP de la LAN | ✅ 200 |
| Login con `admin01` | ✅ 403 `mustChange` hasta cambiar la contraseña, después 200 |
| Crear objetivo y chequeo en vivo | ✅ UP, ping 4/4, puerto 9595 abierto |
| Traceroute | ✅ |
| Ping externo (1.1.1.1) | ✅ con endurecimiento completo |
| Capacidades del proceso | `CapEff=0x2000` (solo NET_RAW) y `NoNewPrivs=1` |
| Usuario y sistema de archivos | `node` (1000); `/app` de solo lectura |
| Permisos de `/data/*.json` | 0600 |
| Persistencia tras parar y arrancar | ✅ objetivos y contraseña nueva conservados; `admin01` rechazada |

**Notas del laboratorio**
- `podman restart` y `podman-compose restart` fallan en este equipo con `rootless netns: kill network process: permission denied`, mientras que `podman start` funciona. Se atribuye al entorno (red rootless con pasta o el sandbox de ejecución), sin confirmar. Hay que comprobarlo en el servidor real.
- Podman con formato OCI ignora el `HEALTHCHECK` del Dockerfile (solo es un aviso). El healthcheck de `compose.yml` sí funciona.
- `/data` queda con permisos 0755, porque el directorio lo crea la imagen y no `store.js`. Los archivos sí están en 0600. Corregido: `chmod 700 /data` añadido en el Dockerfile.
- Con la autenticación activa y sin `CENTINELA_ALLOWED_HOSTS`, un `Host` ajeno se acepta (200). Es lo diseñado.

**Limpieza:** `down -v` y luego `rm`/`rmi`/`prune` de contenedores, pods, imágenes (incluida la base `node:22`), volúmenes, red y caché de construcción. Verificado: 0 contenedores, 0 imágenes, 0 volúmenes, solo la red por defecto `podman`, puerto 9595 libre y `data/` del proyecto intacto. podman y podman-compose siguen instalados.
- [ ] Verificación por revisor-qa y auditor-seguridad.
- [ ] Documentación final en `docs/`: guía de despliegue seguro y variables de entorno.
- [ ] Iniciar git, crear el CHANGELOG y proponer la versión SemVer. Requiere aprobación del usuario.

---

## 2026-11-18 · Fase 2b: verificación y ronda de correcciones 1

**Verificación de calidad (revisor-qa):** no se puede cerrar todavía. Hallazgos:
- **A1 (Alta) · Regresión de SSE:** el tope de 3 flujos por sesión deja el panel sin datos en vivo con la 4.ª pestaña o con `CENTINELA_AUTH=off`.
- **M1 · Usuarios:** cambios concurrentes que se pisan.
- **M2 · Ajustes:** los umbrales en 0 que guardó el bug anterior no se reparan.
- **M3 · Agente:** se cae con una URL malformada.
- **Bajos:** B1–B8.
- **Posibles:** P1 (falsas caídas en URLs lentas) y P2–P3.
- **Pruebas:** algunas no detectarían la regresión que dicen cubrir. Por ejemplo, la de "login asíncrono" o la de PUT concurrente.

**Verificación de seguridad (auditor-seguridad):**
- **Hallazgos originales:**
  - 16 corregidos.
  - 4 parciales: H-02, H-08, H-09 y H-18.
  - H-17 pendiente por acuerdo.
  - H-06, H-22 y H-23 aceptados.
- **Comprobado:** con `admin01`, ninguna ruta escapa del 403, y no hay XSS en el frontend.
- **Nuevos de severidad media:**
  - N-01: el agente se cae, el mismo fallo que M3.
  - N-02: el cambio de contraseña no tiene límite de intentos y su hash no pasa por el semáforo.
  - N-03: el primero que entra con `admin01` se queda con la cuenta de administrador.
  - N-04: el límite de intentos por IP se comparte detrás de un proxy.
- **Bajos e informativos:** N-05 a N-10.

**Decisiones del usuario**
- **N-03:** la contraseña inicial será **aleatoria y se mostrará una sola vez en el log de arranque**, y habrá que cambiarla al entrar. Ya no se usa `admin01`.

**Decisiones del orquestador**
- **A1:** al superar el tope se expulsa el flujo más antiguo de la misma clave, en lugar de rechazar el nuevo. Con la autenticación desactivada, la clave es la IP. El cliente se reconecta con espera exponencial.
- **N-04:** el proxy queda en el backlog, porque el despliegue es en LAN sin proxy.
- **Plazo global vencido:** se emite DOWN con su motivo y el id se mantiene en `running` hasta que la promesa termine, para evitar solapes.

**Ronda 1 (iteración 1 de 3), en curso**
- **Implementador A** (`server.js`, `auth.js`, `store.js`): A1, N-03, M1, N-02, N-09, B3, B4, B5, N-07, 504 por plazo vencido, 400 en ajustes y `server` en `/me` solo para admins.
- **Implementador B** (`validate`, `scheduler`, `checks`, `util`, `probes`, `agent`):
  - Agente: M3/N-01 y fin de `fails.clear()`.
  - Validación: M2 y `settingsErrors`.
  - Planificador: B2/N-05 y `CENTINELA_CHECK_TIMEOUT_MS`.
  - Sondas: P1, B6, el User-Agent sin versión y B8.
  - Análisis: si `NET_RAW` hace falta en el contenedor.
- **Implementador C** (frontend y documentación):
  - Frontend:
    - Reconexión de SSE con espera exponencial.
    - P2 y B7.
    - Aviso de token en el formulario de objetivos.
    - Casilla "obligar a cambiar" la contraseña.
    - Errores de ajustes.
  - Documentación: README y nuevo `docs/despliegue-seguro.md`.
- **Después:** probador refuerza la suite, y luego revisor-qa y auditor-seguridad hacen la verificación final.

**Resultados de la ronda 1**
- **Implementador A ✅**
  - SSE: tope de 5 flujos por clave y 15 por usuario o IP; al superarlo se expulsa el más antiguo. El global de 200 sigue dando 429.
  - Contraseña inicial aleatoria, mostrada en el log (`auth.seeded.generatedPassword`). Se elimina `DEFAULT_PASS`.
  - M1 resuelto con `planUpdate`, que valida antes y después del hash.
  - N-02: al 5.º fallo de la contraseña actual, 429 y cierre de la sesión. Semáforo compartido por todos los hashes.
  - `forceChange` disponible en el alta y la edición de usuarios.
  - Se escribe `users.json` antes de mutar la memoria. `addOrg` limpia lo que deja a medias.
  - Validación estricta del `Host` (400 si está mal formado, 421 si no está permitido).
  - `/check` respondía 504 si vencía el plazo; código eliminado después, ver Fase 2c. PUT de ajustes responde 400 con `errors`. `/me` devuelve `server` solo a administradores.
- **Implementador B ✅**
  - El agente resiste URLs malformadas (400) y tiene `clientError`. Se elimina `fails.clear()`.
  - `sanitizeSettings` repara los avisos en 0. Nueva función `settingsErrors`.
  - Plazo vencido: resultado DOWN con `code timeout`. Nueva variable `CENTINELA_CHECK_TIMEOUT_MS` (mín. 5000).
  - Sonda HTTP: P1 y B6 resueltos; User-Agent sin versión.
  - Traceroute: `<1 ms` se registra como 0.5.
  - Análisis N-10: `NET_RAW` y `setcap` probablemente sobran; `ping` funciona gracias a `ping_group_range`. Falta confirmarlo en el laboratorio.
- **Implementador C ✅**
  - Reconexión de SSE con espera exponencial y `catch` en `switchOrg`.
  - Sombreado de la gráfica con la serie vacía.
  - Aviso del token en el formulario de objetivos.
  - Casilla "obligar a cambiar" la contraseña y errores 400 de ajustes en el formulario.
  - README actualizado y nuevo `docs/despliegue-seguro.md`.
- **Orquestador**
  - Comentarios de `compose.yml` y la etiqueta "debe cambiar la contraseña" en usuarios.
  - Límites de SSE sincronizados en `despliegue-seguro.md`.

**Pendiente: manual de usuario en PDF**
- El usuario pidió que `docs/Centinela-Manual-de-usuario.pdf` se actualice siempre que algo cambie.
- El PDF (56 páginas) lo generó ReportLab y su fuente no está en el proyecto.
- **Plan, tras la verificación final:**
  - Pasar el manual a Markdown en `docs/manual/`.
  - Crear el script `docs/manual/generar_manual.py` con ReportLab en un entorno virtual.
  - Actualizar los capítulos 2, 9, 11, 12, 13, 14 y 16 y regenerar el PDF.
- **Regla en adelante:** todo cambio funcional actualiza `docs/manual/` y regenera el PDF.

---

## 2026-11-18 · Fase 2c: pruebas reforzadas, laboratorio final y manual

**Pruebas (probador) ✅**
- `npm test`: **196/196 en verde** (~14 s). El orquestador las volvió a ejecutar y quedan sin procesos huérfanos.
- **Archivos nuevos:** `test/api-extra.test.js` (SSE, Host, cookie Secure, semáforo, `forceChange`), `test/http-probe.test.js` y `test/agent-server.test.js`.
- **Refuerzos:**
  - "Login asíncrono": ahora comprueba que el event loop no se bloquea.
  - PUT con borrado concurrente.
  - `withTimeout` sin temporizadores colgados.
  - `charts` con datos realistas.
- **Hallazgo H1:** el 504 de `/check` era inalcanzable, porque `runOne` devuelve DOWN en lugar de lanzar. El orquestador eliminó ese código muerto en `server.js`, y la suite sigue en verde.

**Laboratorio final del contenedor ✅** (código final, podman rootless)
- **Contraseña inicial:** el log de arranque muestra la aleatoria una sola vez y no queda escrita en `/data`.
  - `admin01` → 401.
  - Con la aleatoria → login 200, pero 403 en el resto de rutas hasta cambiarla; después, 200.
- **Monitoreo y aislamiento:** chequeo real a 1.1.1.1 UP (4/4); traceroute con 9 saltos; `/data` en 0700; `CapEff` solo NET_RAW y `NoNewPrivs=1`.
- **N-10, comprobado:** sin `NET_RAW`, `ping` falla ("Operation not permitted"), porque el binario tiene `setcap cap_net_raw+ep` y el kernel impide ejecutarlo si esa capacidad no está permitida al contenedor. `traceroute` funciona sin ella. **Se mantiene `cap_add: NET_RAW`.** El análisis teórico de que sobraba era incorrecto.
- **Limpieza:** 0 contenedores, imágenes, volúmenes y pods; solo la red `podman`; puerto 9595 libre. podman y podman-compose siguen instalados.

**Documentación**
- README y `despliegue-seguro.md` corregidos: el cambio obligatorio en el primer acceso solo aplica a la contraseña aleatoria, o a una de entorno de menos de 8 caracteres. Con una contraseña propia válida no se obliga, que es el comportamiento del código.
- **Manual:**
  - `docs/manual/manual.md` (fuente, 18 capítulos y anexos A y B), `docs/manual/CAMBIOS-MANUAL.md` (qué cambió respecto al PDF original) y `docs/manual/img/` (31 capturas extraídas del PDF original, nombradas `pNN-fig-XXX`).
  - `docs/manual/generar_manual.py` (ReportLab) y `docs/manual/README.md`. ReportLab lo instaló el usuario con `python3-reportlab`.
  - Primera generación: 70 páginas. Imágenes demasiado grandes y Figura 8 partida en dos páginas. **En ajuste.**
  - Capturas desactualizadas: Figuras 12, 14 y 15. Se conservan, con una nota que explica la diferencia. Habrá que rehacerlas cuando sea posible.

**Pendientes**
- [ ] Ajuste del generador del manual y sustitución de `docs/Centinela-Manual-de-usuario.pdf`.
- [ ] Verificación final (revisor-qa y auditor-seguridad), en curso.
- [ ] Cierre: iniciar git, CHANGELOG y proponer la versión SemVer. Requiere aprobación del usuario.
- [ ] **Backlog:**
  - N-04 (proxy de confianza).
  - H-17 (límite de frecuencia de `/check`).
  - Capturas nuevas para el manual.
  - Completar `.claude/proyecto/pruebas.md`.
  - Enrutador declarativo de `api()`.
  - Compartir la validación entre cliente y servidor.

---

## 2026-11-18 · Fase 2d: verificación final y ronda de correcciones 2

**Glosario de IDs de la verificación de calidad** (para consulta futura)
- **B1:** un orden aviso/crítico inválido en Ajustes se ignoraba en silencio. Ahora responde 400 con `errors`.
- **B2:** un plazo global vencido dejaba el estado obsoleto.
- **B3:** `auth.js` mutaba la memoria antes de escribir en disco.
- **B4:** `addOrg` dejaba directorios huérfanos.
- **B5:** sin autenticación, el cupo de traceroute era compartido por toda la red.
- **B6:** un cuerpo HTTP cortado contaba como éxito.
- **B7:** la gráfica no sombreaba la caída si toda la serie era nula.
- **B8:** `tracert` registraba `<1 ms` como 1 ms.
- **P1:** falsas caídas en URLs lentas.
- **P2:** `switchOrg` sin `catch`.
- **P3:** el token del agente se descartaba sin aviso al cambiar la dirección.

**Verificación final de calidad (revisor-qa):** NO apta todavía.
- Cerrados: A1, M1, M2, M3, B2 y B6–B8, P1 y P2, y las pruebas débiles. Suite 196/196 en 3 ejecuciones.
- **QA-1 (Media) · Carrusel SSE:** con más de 5 pestañas se roban el flujo cada 3 s, porque EventSource reconecta solo tras un cierre limpio.
- **QA-2:** el manual aún menciona el 504.
- **Bajos:** QA-3 (un admin que edita su propia contraseña se expulsa), QA-4 (`forceChange` no corta los flujos en vivo), QA-5 (claves internas en los errores de Ajustes), QA-6, QA-7 (`/check` en curso), QA-8 (pruebas con esperas fijas) y QA-9 (`disabled:"false"`).

**Verificación final de seguridad (auditor-seguridad):** NO apta todavía.
- Cerrados: N-01, N-02, N-03, N-06, N-07, N-08 y N-09, y también H-08 y H-18.
- **V-01 (Media):** H-02 no se puede mitigar en el contenedor. `compose.yml` no pasa `CENTINELA_ALLOWED_HOSTS` y, si se activa, el healthcheck en 127.0.0.1 da 421.
- **Bajos:** V-02 (la contraseña aleatoria se pierde si `listen` falla) y V-03 (el mismo caso que QA-1).
- **Informativos:** V-04 (la contraseña queda en memoria), V-05 y V-06 (documentación desfasada).
- **Parciales aceptables:** N-05 y H-09 (el agente en 0.0.0.0 y el token en claro).

**Ronda 2 (iteración 2 de 3), en curso**
- **Servidor y compose** (implementador):
  - V-01: la variable pasa en `compose.yml`; el loopback siempre se acepta.
  - V-02 y V-04: la contraseña se imprime antes de `listen` y luego se borra de memoria.
  - QA-1: el servidor envía `event: evicted` al expulsar un flujo.
  - QA-3 a QA-7 y QA-9 (QA-7: `/check` responde 409 si ya hay una verificación en curso).
- **Frontend** (implementador):
  - QA-1: la pestaña expulsada queda en pausa, "En vivo en otra pestaña", y reconecta con un clic o al volver a estar visible.
  - QA-3: la casilla no aparece en el usuario propio.
- **Documentación** (documentador): QA-2, V-06, límites de SSE, `ALLOWED_HOSTS` en compose, token del agente con firewall o VLAN, systemd `EnvironmentFile`, `NET_RAW` necesario.
- **Backlog:** QA-8, N-04, el resto de N-05 y de H-09, H-17, V-05.

**Resultados de la ronda 2 ✅**
- **Servidor y compose:**
  - V-01: `CENTINELA_ALLOWED_HOSTS` en compose; el loopback siempre se acepta.
  - V-02 y V-04: la contraseña se imprime antes de `listen` y luego se borra de memoria.
  - `event: evicted` en SSE.
  - QA-3: `update` con `actorSid`.
  - QA-4: hook `onStreamsDropped`.
  - QA-5: etiquetas en español.
  - QA-6: se reescribe `settings.json` saneado.
  - QA-7: `/check` responde 409 (`scheduler.isRunning`).
  - QA-9: `disabled` solo booleano.
- **Frontend:** `pause()` y `resume()` en `source-live`; insignia "En vivo en otra pestaña" con clic o teclado; reconexión al volver a estar visible solo si estaba oculta. La casilla no aparece en el usuario propio.
- **Documentación:** guía y manual alineados. Sin 504; SSE 5/15/200 con pausa; `ALLOWED_HOSTS` en `.env`; token del agente con firewall o VLAN; ejemplo de systemd con `EnvironmentFile`; `NET_RAW` necesario.
- **Pruebas:** **207/207** en 3 ejecuciones, ~19 s, confirmado por el orquestador. QA-8 mejorado con la espera a condición `esperar(cond, plazo)`; queda una `pausa(300)` justificada.
- **Verificación breve de la ronda 2 (revisor-qa y auditor-seguridad):** en curso.

**Verificación breve de la ronda 2 ✅**
- **auditor-seguridad: APTO.**
  - V-01 a V-04 cerrados.
  - El loopback siempre aceptado no abre un bypass: 9 variantes de `Host` probadas.
  - `onStreamsDropped` no permite cortar los flujos de otros usuarios.
  - **V-07 (documental):** el proxy debe conservar la cabecera `Host`. Corregido por el orquestador en la guía y el manual.
- **revisor-qa: APTO.**
  - QA-1 a QA-7 y QA-9 cerrados.
  - Simulación de 6 pestañas sin ciclo.
  - `settings.json` se reescribe una sola vez.
  - H-2 (pantalla de pared) y H-3 (insignia de pausa): el orquestador documentó ambos en el manual y quitó la última mención al 504.
  - **H-1 (Bajo), a backlog:** tras `forceChange` enviado solo por API, la pestaña no muestra el modal de cambio de contraseña.

---

## 2026-11-18 · Cierre de la fase y release 2.0.0

**Checklist de terminado:**
- Requisitos cubiertos.
- 207/207 pruebas.
- Sin hallazgos críticos, altos ni medios abiertos.
- Documentación al día.
- Sin secretos en el código ni en la documentación.
- Riesgos registrados.

**Decisiones del usuario**
- Versión **2.0.0**, porque hay cambios incompatibles: sin `admin01`, `/api/health` sin `version` y nuevas respuestas 400 y 409.
- Iniciar git local con commit y etiqueta `v2.0.0`, sin remoto.
- La identidad de git la configura el usuario.

**Hecho**
- `package.json` pasa a 2.0.0, que es la única fuente de la versión del producto. `.claude/orquestacion/VERSION` es la versión de la configuración de orquestación y no se toca.
- `CHANGELOG.md` creado en la raíz (formato Keep a Changelog, con secciones 2.0.0 y 1.0.0).
- Manual PDF regenerado: `docs/Centinela-Manual-de-usuario.pdf`, versión 2.0.0, 65 páginas. El original de 56 páginas está en el respaldo.
- `.gitignore`: excluye `data/*` (salvo `data/README.md`), `.env`, `node_modules`, logs y temporales.
- Repositorio iniciado (`git init -b main`) con todo preparado.
- **Commit `37f1ffe` (`chore(release): 2.0.0`) y etiqueta anotada `v2.0.0` creados en local.** Autor configurado solo en este repositorio: `blaklion3212`, con el correo noreply de GitHub. Sin remoto.

**Backlog para la siguiente fase**
- **Seguridad y robustez:**
  - N-04: `CENTINELA_TRUST_PROXY`.
  - H-17: límite de frecuencia de `/check`.
  - El resto de N-05 (el cupo se libera con la sonda viva).
  - El resto de H-09: el agente escucha en 0.0.0.0 por defecto y el token viaja en claro (TLS opcional).
  - V-05.
- **Interfaz:**
  - H-1: `verify()` debe atender `mustChange`.
  - Capturas nuevas para las Figuras 12, 14 y 15 del manual.
- **Pruebas:**
  - QA-8: queda una `pausa(300)`.
  - Completar `.claude/proyecto/pruebas.md`.
  - CI.
- **Mantenibilidad:**
  - Enrutador declarativo para `api()`.
  - Compartir la validación y las estadísticas entre cliente y servidor.
- **Entorno:** comprobar `podman restart` en el servidor real.

---

## 2026-11-18 · Fase 3: pendientes de la 2.0.0 (objetivo: 2.1.0)

**Petición del usuario:** completar los puntos que quedaron fuera de la 2.0.0.

**Plan**

| Fase | Responsable | Alcance |
|---|---|---|
| F1a | implementador | N-04 `CENTINELA_TRUST_PROXY` (`clientIp`), H-17 intervalo mínimo de 5 s en `/check` (429 con `Retry-After`), N-05 cupo con verificaciones huérfanas, V-05 reserva del intento antes del hash |
| F1b | implementador | TLS opcional del agente (`--tls-cert`/`--tls-key`) con huella SHA-256 fijada en el objetivo (`checks.agent.tls` y `checks.agent.fingerprint`); el token no se envía si la huella no coincide |
| F1c | implementador | H-1 (`verify()` atiende `mustChange`); campos TLS en el formulario; aviso "TLS sin huella fijada" |
| F1d | devops-ci | GitHub Actions con Node 18, 20 y 22, más build de la imagen |
| F2 | refactorizador | Enrutador declarativo de `api()` y validación compartida entre cliente y servidor, sin cambiar el comportamiento |
| F3 | probador | Pruebas nuevas, QA-8 y `.claude/proyecto/pruebas.md` |
| F4 | revisor-qa y auditor-seguridad | Verificación |
| F5 | varios | Capturas automáticas con Firefox headless por WebDriver BiDi (Figuras 12, 14 y 15), documentación, PDF, laboratorio podman con `restart` fuera del sandbox, CHANGELOG 2.1.0, y commit y etiqueta con aprobación |

**Decisión del orquestador:** el TLS del agente es opcional y compatible. La huella fijada protege el token contra suplantación; sin huella, la conexión va cifrada pero con una advertencia visible.

**Estado:** F1 en curso, con 4 agentes en paralelo.

**F5 (adelantado) · Laboratorio podman `restart`, ejecutado fuera del sandbox**
- `podman restart centinela` falla en este equipo con `rootless netns: kill network process: permission denied` (rc=125) y deja el contenedor **detenido**. Ocurre tanto dentro de un pod como con `--in-pod=false`, así que es un problema de podman rootless en este host y no de Centinela.
- Alternativas que sí funcionan:
  - `podman-compose -p <proyecto> restart`: el contenedor queda en estado healthy y `/api/health` responde OK.
  - `podman stop centinela && podman start centinela`.
- `podman-restart.service` (usuario) está **deshabilitado**. Sin él, `restart: unless-stopped` no levanta el contenedor al reiniciar el equipo. Se habilita con `systemctl --user enable podman-restart.service` y `loginctl enable-linger $USER`.
- Laboratorio limpio: 0 contenedores, pods, imágenes y volúmenes; solo queda la red `podman`; el puerto 9595 está libre.
- Debe documentarse en la guía de despliegue y en el manual (F5).

**F1 ✅** Integración verificada por el orquestador: 207/207 pruebas.
- **F1a:** `clientIp()` y `CENTINELA_TRUST_PROXY`; `lastManual` (429 `Retry-After: 5`); `scheduler.stats()`, `capacity()` y `drain()`; `reserve()` y `cancelReserve()` en auth. El límite por IP sigue en "más de 20", como está documentado.
- **F1b:** TLS del agente. Con huella distinta, el servidor falso recibió 0 peticiones. El campo de advertencia es `agent.warning` (texto).
- **F1c:** H-1, campos TLS y `agentWarn`. El orquestador alineó el widget para que lea `warning` y también `warnings`.
- **F1d:** `.github/workflows/pruebas.yml` con Node 18, 20 y 22 y build de la imagen; permiso `contents: read`.

**F3 ✅** 268/268 pruebas. Archivos nuevos:
- `trust-proxy`, `check-manual`, `scheduler-huerfanas`, `agent-tls` e `infrastructure-widget`, más el helper `certs`.
- QA-8 cerrado con `Expect: 100-continue`.
- `.claude/proyecto/pruebas.md` completado.
- Las mutaciones introducidas a propósito fueron detectadas por la suite.

**F2 ✅**
- `server/lib/routes.js` y la tabla `ROUTES`. Cada ruta declara `access`, `mustChange` y `pre`. Las entradas `'*'` son deliberadas: conservan las respuestas antiguas. Al añadir rutas, conservar su orden.
- `js/shared/thresholds.js` (UMD), usado por `validate.js` y `settings.js`.
- 135 peticiones dieron respuestas idénticas antes y después; 20 000 casos de fuzz dieron el mismo resultado en los umbrales.
- **Backlog:**
  - Unificar `U.stats` y `server/lib/util.stats`, que difieren en `isNum` frente a `typeof` y no tienen pruebas del cliente.
  - Unificar los mensajes de orden aviso/crítico entre cliente y API.
  - 405 coherente fuera de `/users`.

**F4 ⏳** `revisor-qa` y `auditor-seguridad` en paralelo; F3b (pruebas de `routes` y `thresholds`) en paralelo.

**F3b ✅**
- `test/routes.test.js` (25 pruebas) y `test/thresholds.test.js` (22 pruebas); 315 pruebas en total.
- El orquestador corrigió el bug de `BY_ID` heredado del prototipo: ahora usa `Object.create(null)`.

**F4 · Verificación**
- `auditor-seguridad`: **apto con reservas** (S3-1 a S3-9).
- `revisor-qa`: **apto con reservas** (QA3-1 a QA3-9). Un diferencial de 980 casos del enrutador frente a v2.0.0 dio 0 diferencias.

**Decisiones**
- **Usuario:** con TLS activado, la huella es **obligatoria** (S3-1).
- **Orquestador:**
  - Si cambia o se quita la huella, el token se descarta (S3-2 / QA3-5).
  - Se mantiene `engines >=18`; Node 24 se añade a la CI. Subir el mínimo sería incompatible en una MINOR.

**Ronda de corrección 1** (2 implementadores en paralelo)
- **A, servidor:**
  - S3-1, S3-2 y QA3-8.
  - Plazo absoluto de 10 s en `agentFetch` (S3-4 / QA3-1) y comentario sobre `agent:false` (S3-9).
  - Tope de la huérfana en 2 × timeout (QA3-2).
  - `net.isIP` en `clientIp` y aviso de `TRUST_PROXY` inválido (S3-3 / QA3-4).
  - Cupo de `/check` por usuario y poda de `lastManual` (S3-5 / QA3-7).
  - `lockKey` con el nombre limpio (S3-6).
- **B, frontend y CI:**
  - Huella obligatoria en el formulario y aviso al cambiarla.
  - `applyRole` en `verify` (QA3-6) y etiqueta de respaldo en ajustes.
  - CI con `persist-credentials: false`, Node 24 y acciones fijadas por SHA si se puede verificar.
- **`depurador`:** causa de la intermitencia de la prueba de H-17.

**Ronda de corrección 1: resultados**
- **B ✅**
  - Huella obligatoria en el formulario (que tiene `novalidate`) y aviso cuando cambia la huella.
  - `applyRole` en `verify`, que es idempotente.
  - CI con Node 18, 20, 22 y 24, `persist-credentials: false`, y `checkout` y `setup-node` fijados por SHA (v4.4.0, verificado con `gh`).
- **A ✅**
  - Las 8 correcciones aplicadas.
  - Mensajes nuevos: 'Con TLS activado, la huella SHA-256 del certificado del agente es obligatoria', 'Falta la huella TLS del agente', 'El agente tardó demasiado en responder' y 429 'Demasiadas verificaciones manuales; espera un momento' (3 simultáneas o 30 por minuto por usuario).
  - Se eliminó la advertencia 'TLS sin huella fijada'.
  - 4 pruebas con expectativa obsoleta quedan para el probador (F3c).
- **Incidente:** el implementador A usó la variable `CENTINELA_DATA_DIR`, que no existe (la correcta es `CENTINELA_DATA`), y el servidor escribió 4 archivos en `data/` del repo a las 15:29. El usuario aprobó borrarlos y se borraron. `data/README.md` está intacto.
  - Lección: todo brief que arranque el servidor debe indicar `CENTINELA_DATA=<directorio temporal>`.

**F3c ✅**
- 334/334 pruebas, 3 ejecuciones verdes seguidas. Las 4 pruebas con expectativa obsoleta se ajustaron y se añadieron pruebas del cupo manual, del plazo de 10 s, del tope de la huérfana, de `parseForwarded`, de `lockKey` y del import con huella.
- **Intermitencia de H-17, diagnóstico del `depurador`:** carrera de puertos en `freePort()` del helper (`EADDRINUSE`); el orden 409/429 de producción es correcto.
  - Corrección, solo en pruebas: reintento de `startServer` ante `EADDRINUSE` y conteo por User-Agent de la sonda en el servidor mudo.
  - También se corrigió la carrera de `lanzarAgente`, que esperaba solo la primera línea del log del agente.
- La validación de la huella en el formulario no tiene prueba propia: el servidor la impone y está cubierta.

**F5 ✅**
- **Capturas:** las Figuras 12, 14 y 15 se rehicieron con Firefox headless y WebDriver W3C directo (`geckodriver` del snap, sin selenium), con datos ficticios. El nombre del equipo se sustituyó por "servidor-demo".
- **Documentación:**
  - `despliegue-seguro.md`: proxy de confianza, TLS del agente y podman.
  - Manual: capítulos 2–18 y Anexos C (variables) y D (mensajes); se retiraron las notas de las capturas antiguas.
  - `CAMBIOS-MANUAL.md` y README.
- **Orquestador:**
  - `CENTINELA_TRUST_PROXY` añadido a `compose.yml` (validado con `podman-compose config`) y notas ajustadas.
  - CHANGELOG en `[Sin publicar]`.
  - PDF regenerado (71 páginas, versión 2.1.0, sin restos de `admin01` ni de 'TLS sin huella fijada').
- **Limpieza:** no quedan servidores de prueba vivos. Se borraron dos carpetas `/tmp/centinela-tls-*` de las pruebas de carga del depurador. `data/` solo contiene `README.md`.

**Cierre de la fase 3**
- Checklist de terminado:
  - Requisitos del backlog cubiertos.
  - 334/334 pruebas.
  - QA y seguridad sin hallazgos críticos ni altos; los medios están corregidos.
  - Documentación y PDF al día.
  - Sin secretos.
- **Backlog restante:**
  - Unificar `U.stats` del cliente con el del servidor.
  - Unificar los mensajes de orden de umbrales entre cliente y API.
  - 405 coherente fuera de `/users`.
  - Prueba de la huella en el formulario, si se extrae a una función pura.
  - Primera ejecución real de la CI cuando exista el remoto.
- **Versión 2.1.0 aprobada por el usuario.** Commit y etiqueta local `v2.1.0`, sin remoto.

---

## 2026-11-18 · Fase 4: backlog restante y publicación en GitHub

**Petición del usuario:** completar los pendientes del backlog y subir el repositorio a GitHub.

**Decisión del usuario:** repositorio **privado** `blaklion3212/centinela-monitor`, creado con `gh`. Se suben la rama `main` y las etiquetas; `data/` y `.env` quedan fuera.

**Plan**

| Fase | Responsable | Alcance |
|---|---|---|
| B-A | implementador | Respuesta 405 coherente (con `Allow`) en toda la API |
| B-B | implementador | Módulos compartidos: `js/shared/stats.js`, `js/shared/fingerprint.js` y mensajes de umbrales unificados |
| Pruebas | probador | Pruebas nuevas, entre ellas la de la huella en el cliente, ahora que es una función pura |
| Revisión | revisor-qa | Revisión de la fase |
| Cierre | orquestador | Documentación, PDF, versión, commit, etiqueta y push |

**Estado:** B-A y B-B en curso.

**B-A ✅** 405 `{error:'Método no permitido'}` con `Allow` en rutas existentes. Se quitaron las entradas `'*'` de `ROUTES` y se añadió `routes.allowed()`.
- **Orden de comprobaciones:** 415 → 403 Origin → pública → 401 → 403 mustChange → 403 admin en users → 405 → 404.
- **Decisiones del orquestador:**
  - Un no admin recibe 403 en `/api/users*`, para no revelar los métodos que existen.
  - Un anónimo siempre recibe 401.

**B-B ✅** `js/shared/stats.js` (`NOC.Stats`) y `js/shared/fingerprint.js` (`NOC.Fingerprint`), compartidos por el cliente y el servidor. El cliente usa `orderMessage`.
- **Cambios observables:**
  - Con `NaN` o `Infinity`, el servidor cuenta pérdida.
  - El cliente valida la huella con el mismo formato estricto que el servidor.
  - El mensaje de orden de umbrales es el mismo en el cliente y en la API.

**Pruebas ✅** 388/388 (54 nuevas): `api-405`, `shared-stats`, `shared-fingerprint` y `settings-orden`. Esta última cubre por fin la huella y el mensaje del cliente.

**revisor-qa: APTO**, con 5 observaciones bajas (QA4-1 a QA4-5).
- Se corrigen todas.
- **Decisiones del orquestador:**
  - HEAD se trata como GET (RFC 9110).
  - El mensaje de orden usa la etiqueta con unidades del formulario.

**Corrección QA4 ✅**
- QA4-1: pérdida calculada con enteros (23 de 80 da 28,8).
- QA4-2: HEAD equivale a GET, salvo `/api/stream`, que tiene `noHead` y responde 405 con `Allow: GET`.
- QA4-3: `orderMessage` admite una etiqueta, para mostrar las unidades en la vista.
- QA4-4: `checks.js` usa `Fingerprint`.
- QA4-5: `createRouter` rechaza el método `'*'` y un mismo patrón con distinto `access`.

**Pruebas ✅ 399/399**
- Las 16 pruebas con expectativa obsoleta se ajustaron y se añadieron casos nuevos.
- La prueba RT-12c destapó que una ruta HEAD explícita declarada después de su GET no ganaba. El orquestador lo corrigió en `routes.match`, que ahora busca primero el método exacto.

**Documentación ✅**
- Manual 2.2.0: sección 13.3 nueva sobre códigos de rutas y métodos, y 7 filas nuevas en el Anexo D.
- `CAMBIOS-MANUAL.md` y README actualizados (399 pruebas).
- PDF regenerado: 73 páginas.

**Versión 2.2.0 aprobada por el usuario.** Commit, etiqueta `v2.2.0` y push al repositorio privado `blaklion3212/centinela-monitor`.

**Cierre de la fase 4**
- Checklist de terminado:
  - Backlog completado.
  - 399/399 pruebas.
  - QA apto; las observaciones bajas están corregidas.
  - Documentación y PDF al día.
  - Sin secretos.
- **Backlog restante:** ninguno técnico. Solo queda la primera ejecución real de la CI, que llegará con el push a GitHub.
