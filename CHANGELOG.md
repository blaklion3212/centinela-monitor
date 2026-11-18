# Registro de cambios

Todos los cambios relevantes de Centinela se documentan aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado: [SemVer 2.0.0](https://semver.org/lang/es/).

## [Sin publicar]

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
