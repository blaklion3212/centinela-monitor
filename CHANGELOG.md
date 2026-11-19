# Registro de cambios

Todos los cambios relevantes de Centinela se documentan aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado: [SemVer 2.0.0](https://semver.org/lang/es/).

## [Sin publicar]

## [2.3.0] - 2026-11-19

### Agregado
- **Alertas por Telegram** (opcionales, desactivadas por defecto). Los administradores pueden recibir un mensaje de Telegram cuando un servicio cae, se recupera y, si lo activan, queda DEGRADADO.
  - Se configuran en Ajustes → Alertas, con un panel de ayuda «Cómo configurarlo» (crear el bot con @BotFather, guardar el token, «Buscar mis chats», «Enviar mensaje de prueba» y activar), ayuda por campo y mensajes de error que explican la causa y la solución.
  - Nivel de detalle Mínimo o Completo (con dirección, motivo y hora; la dirección se envía sin usuario, contraseña ni parámetros), aviso tras N fallos seguidos (1 a 10, por defecto 2), aviso de recuperaciones y de DEGRADADO.
  - Antirruido: los avisos del mismo chat en una ventana de 30 s se agrupan en un mensaje, no se repiten las caídas ya avisadas tras reiniciar el servidor (la recuperación pendiente sí se avisa) y la recuperación solo se avisa si antes se avisó la caída.
  - Indicador de estado (Sin configurar, Desactivadas, Funcionando, Con errores, Bloqueadas por el entorno) con último envío, último error y contadores.
  - Variable `CENTINELA_TELEGRAM_TOKEN` para definir el token fuera del panel (tiene prioridad) y `CENTINELA_ALERTS_DISABLED` para bloquear la función. Ambas vacías por defecto; con ellas vacías y sin activar las alertas, el comportamiento es el de la 2.2.x. `compose.yml` las pasa desde `.env`.
  - Rutas nuevas `/api/alerts*`, solo para administradores.
  - Mensajes de error específicos cuando el chat de destino es un bot (por ejemplo, el propio bot) o la persona aún no inició el chat con él. Al guardar otro chat de destino, las caídas que siguen activas se vuelven a avisar en el chat nuevo; si se prueba un chat sin guardarlo, el panel recuerda pulsar «Guardar».
  - Requiere salida HTTPS del servidor a `api.telegram.org`, puerto 443; no hay soporte de proxy en esta versión.
  - Documentación: nuevo capítulo «Alertas por Telegram» en el manual y en la guía de uso, y sección en la guía de despliegue seguro. Los PDF se regeneran con las capturas.
- Documentación: paso a paso para crear y arrancar el contenedor de Centinela en Linux (Podman o Docker, sección 14.7) y en Windows (Docker Desktop o Podman Desktop, sección 14.8), con instalación del motor, archivo `.env`, firewall, arranque automático, actualización y desinstalación, y nuevas filas en los problemas frecuentes. Los pasos de Windows y de Docker en Linux se basan en la documentación de cada producto y no se probaron con Centinela.
- Guía de uso en PDF (`docs/Centinela-Guia-de-uso.pdf`, 45 páginas) para quien usa el panel. Explica cada función paso a paso: ventanas, objetivos, organizaciones, ajustes, usuarios y roles, tareas frecuentes y mensajes comunes. Su fuente es `docs/manual/guia-uso.md`.

### Corregido
- El encabezado de las páginas de los PDF muestra el título de cada documento.
- **Traceroute:** después de cambiar el servicio de la ventana «Análisis de ruta (traceroute)», «Ejecutar» no mostraba nada hasta recargar la página, porque trazaba el servicio anterior. Ahora traza el servicio elegido. La causa estaba en cómo cada ventana guardaba su contexto, así que la corrección vale para todas.
- El aviso del panel y la ventana de cambio obligatorio ya no hablan de una «contraseña por defecto», que no existe desde la 2.0.0. Ahora indican que la contraseña es temporal: la inicial o una asignada por un administrador.
- Manuales: nuevas capturas de la sección Objetivos y de su formulario, con la barra de organizaciones, la casilla «Identificarse como un navegador» y los campos de conexión cifrada (TLS) y huella.

### Seguridad
- Alertas por Telegram: el token del bot nunca se devuelve por la API ni se escribe en el registro, y todo mensaje de error lo oculta. Se recomienda definirlo con `CENTINELA_TELEGRAM_TOKEN` en el archivo `.env` (permiso 600, fuera del repositorio); si se guarda desde el panel queda en `data/alerts.json` (permiso 600).
- La conexión con Telegram valida el certificado TLS y no sigue redirecciones.
- Las rutas `/api/alerts*` solo admiten administradores; la prueba y la búsqueda de chats se limitan a una acción a la vez y una cada 5 s por administrador.
- `CENTINELA_ALERTS_DISABLED=1` bloquea la función por completo. Con `CENTINELA_AUTH=off` y el servidor abierto a la red, el arranque avisa de que cualquier equipo puede configurar las alertas.
- Los avisos salen de la red local hacia los servidores de Telegram (los chats con bots no tienen cifrado de extremo a extremo); la guía de despliegue seguro explica qué datos salen.

## [2.2.0] - 2026-11-18

### Agregado
- La API responde `HEAD` en todas sus rutas de lectura (como `GET`, sin cuerpo), excepto el flujo en vivo `/api/stream`.
- Pruebas automáticas del panel para el formulario de ajustes y la validación de la huella TLS: 399 en total.

### Cambiado
- **Códigos de respuesta de la API:** cuando la ruta existe pero el método no está permitido, responde **405** «Método no permitido» con la cabecera `Allow`.
  - Antes muchas de esas peticiones devolvían 404 «Ruta no encontrada», «Organización no encontrada» u «Objetivo no encontrado», o 403 «solo lectura» para los lectores.
  - Las rutas inexistentes siguen respondiendo 404.
  - Los usuarios sin sesión siguen recibiendo 401.
- **Mensajes de umbrales:** el mensaje de error de orden aviso/crítico en Ajustes tiene el mismo formato que el de la API e incluye las unidades, por ejemplo `En "Latencia (ms)" el aviso (…) debe ser menor que el crítico (…).`
- **Huella TLS:** el formulario de objetivos la valida con el mismo formato que el servidor. Antes aceptaba huellas con `:` mal colocados que el servidor rechazaba al guardar.

### Corregido
- **Estadísticas:**
  - Una muestra que no es un número válido (NaN o infinito) cuenta como pérdida. Antes el servidor la contaba como recibida y la latencia media quedaba vacía.
  - El panel y el servidor calculan pérdida, latencia y jitter con el mismo código.
  - El porcentaje de pérdida se redondea de forma exacta: por ejemplo, 23 de 80 da 28,8 % y no 28,7 %.

## [2.1.0] - 2026-11-18

### Agregado
- Conexión cifrada (TLS) entre el panel y el agente remoto:
  - El agente se arranca con `--tls-cert` y `--tls-key` (o `CENTINELA_AGENT_TLS_CERT` y `CENTINELA_AGENT_TLS_KEY`) y muestra al arrancar la huella SHA-256 de su certificado.
  - En el objetivo se marca "Conexión cifrada (TLS)" y se pega esa huella, que es obligatoria.
  - Si la huella no coincide, el token no se envía.
- `CENTINELA_TRUST_PROXY`: lista de IPs de proxies de confianza. Con ella, los límites de intentos se aplican a la IP real del cliente (`X-Forwarded-For`) y no a la del proxy.
- Integración continua con GitHub Actions: pruebas en Node 18, 20, 22 y 24, más construcción de la imagen.
- 127 pruebas automáticas nuevas: 334 en total.

### Cambiado
- La verificación manual de un objetivo (`POST /api/targets/:id/check`) tiene límites:
  - una cada 5 s por objetivo;
  - como máximo 3 simultáneas y 30 por minuto por usuario.
  
  Al superarlos responde 429 con `Retry-After`.
- El token guardado de un agente también se descarta si cambia la huella TLS o se desactiva TLS. Hay que volver a escribirlo.
- Una verificación colgada que supera dos veces el plazo máximo se da por terminada. Mientras sigue colgada, reduce temporalmente la capacidad de verificación, para no superar el límite de concurrencia.
- El intento de inicio de sesión se cuenta antes de comprobar la contraseña. Las variantes del nombre de usuario con mayúsculas o espacios comparten el mismo contador.

### Corregido
- Si un administrador obliga a cambiar la contraseña de un usuario con sesión abierta, su pestaña muestra el cambio obligatorio en lugar de reintentar la conexión en bucle.
- La interfaz refleja un cambio de rol al reconectar, sin necesidad de recargar.
- Un agente que responde muy lento ya no bloquea indefinidamente la verificación: el plazo máximo es de 10 s.

### Seguridad
- El token del agente ya no puede viajar en claro por la red local si se usa TLS. Con la huella fijada, un equipo que suplante al agente no lo recibe.
- Las entradas de `X-Forwarded-For` y de `CENTINELA_TRUST_PROXY` que no son IPs válidas se ignoran.
- La CI se ejecuta con permisos de solo lectura y con las acciones fijadas por commit.

## [2.0.0] - 2026-11-18

Versión de seguridad y calidad. Incluye cambios incompatibles: revisa **Cambiado** y **Eliminado** antes de actualizar.

### Agregado
- Contraseña inicial del administrador aleatoria. Si no defines `CENTINELA_ADMIN_PASSWORD`, se genera al primer arranque y se muestra una sola vez en el log (`docker logs` / `podman logs`).
- Cambio de contraseña obligatorio, impuesto por el servidor, mientras se use la contraseña inicial generada.
- Casilla "Obligar a cambiar la contraseña al entrar" al crear un usuario o restablecer su contraseña.
- Nuevas variables de entorno:
  - `CENTINELA_ALLOWED_HOSTS`: protección contra DNS rebinding; también se pasa desde `compose.yml`.
  - `CENTINELA_COOKIE_SECURE`: cookie `Secure` detrás de un proxy HTTPS.
  - `CENTINELA_CHECK_TIMEOUT_MS`: plazo máximo de cada verificación.
- Agente remoto:
  - El token se puede pasar con `CENTINELA_AGENT_TOKEN`, sin que quede visible en `ps`.
  - Nueva opción `--host` y variable `CENTINELA_AGENT_HOST`.
  - Bloqueo temporal tras 10 tokens incorrectos por minuto.
- Pestañas con datos en vivo:
  - Las pestañas que superan el límite de flujos quedan en pausa ("En vivo en otra pestaña") y se recuperan con un clic.
  - Reconexión automática con espera creciente.
- Botón "Reintentar" cuando el servidor real falla, en lugar de pasar a datos simulados.
- Aviso en el formulario de objetivos cuando un cambio de dirección o de puerto descarta el token guardado del agente.
- Suite de pruebas automáticas (`npm test`, 207 pruebas con `node:test`, sin dependencias).
- Documentación en `docs/`:
  - Guía de despliegue seguro.
  - Bitácora del proyecto.
  - Auditoría inicial.
  - Manual con fuente editable (`docs/manual/manual.md`) y generador del PDF.

### Cambiado
- **Incompatible:** ya no existe la contraseña por defecto `admin01`.
- **Incompatible:** `GET /api/health` ya no devuelve `version`. Consúltala en `/api/auth/me` como administrador.
- **Incompatible:** la API responde con códigos nuevos:
  - `PUT /api/settings` responde 400 con `errors` ante umbrales inválidos, que antes se ignoraban.
  - `POST /api/targets/:id/check` responde 409 si ya hay una verificación en curso.
  - Las peticiones con cuerpo que no es un objeto JSON responden 400.
- Una verificación que excede el plazo máximo marca el objetivo DOWN con su motivo.
- Los umbrales se validan: el aviso debe ser menor que el crítico (en SSL, mayor); un campo vacío ya no se guarda como 0. Los ajustes guardados con ceros se reparan solos al arrancar.
- Sesiones: como máximo 10 por usuario y caducidad absoluta de 7 días, además de las 12 h de inactividad.
- Flujos en vivo: 5 por sesión y 15 por usuario. Al superarlos se pausa el más antiguo, en lugar de rechazar el nuevo.
- Contenedor:
  - Node 22 LTS.
  - Sin capacidades salvo `NET_RAW`, `no-new-privileges`, sistema de archivos de solo lectura y límites de memoria y de procesos.
  - `ping_group_range` "0 65535", compatible con podman rootless.
- El User-Agent de las sondas HTTP ya no incluye la versión.

### Eliminado
- Contraseña por defecto `admin01` en `compose.yml`, el código y el README.
- Campo `version` en `/api/health`.

### Corregido
- No se podía guardar ningún objetivo de tipo URL desde el formulario.
- Un sitio que bloquea ICMP aparecía DOWN aunque respondiera HTTP correctamente.
- El planificador podía congelarse si un agente cortaba la conexión a mitad de la respuesta.
- La pantalla quedaba bloqueada al cambiar de organización con una ventana ampliada.
- Al cambiar rápido de organización se mezclaban los datos de dos organizaciones.
- Editar un objetivo borrado al mismo tiempo devolvía "Error interno"; ahora responde 404.
- La gráfica no sombreaba las caídas al inicio de la serie ni cuando toda la serie estaba caída.
- `tracert` registraba los tiempos `<1 ms` como 1 ms.
- Las URL lentas o de streaming sin palabra clave ya no se marcan DOWN por tardar en enviar el cuerpo.
- Una respuesta HTTP cortada a mitad del cuerpo ya no cuenta como éxito cuando se busca una palabra clave.
- Dos administradores editando el mismo usuario a la vez ya no se pisan los cambios.
- Un administrador que cambia su propia contraseña desde Usuarios ya no se expulsa a sí mismo.
- El agente se caía con una petición malformada.
- Los datos y los usuarios se escriben en disco antes de aplicarse en memoria, de forma atómica y con `fsync`.

### Seguridad
- Login con scrypt asíncrono: un ataque de intentos de login ya no puede bloquear el servidor.
- Bloqueo de intentos más robusto: por usuario e IP, por IP, y también al cambiar la contraseña.
- Validación estricta de la cabecera `Host`: 400 si está mal formada y 421 si no está permitida.
- Un lector solo puede lanzar traceroute hacia objetivos existentes. Hay cupo por usuario.
- El token del agente se descarta si cambian la dirección o el puerto del objetivo.
- Respuesta del agente normalizada antes de mostrarse, y escape de HTML en los widgets.
- Nombres de servicio del agente validados para evitar inyección de opciones en `systemctl` y `pgrep`.
- Archivos de datos con permisos 0600 y carpeta con 0700.

## [1.0.0] - 2026-10-15

- Primera versión: panel de monitoreo con ping, DNS, HTTP/TTFB, SSL, puertos, traceroute y métricas por agente; organizaciones; usuarios con roles; despliegue en contenedor.
