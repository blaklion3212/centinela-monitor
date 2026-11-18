# Despliegue seguro de Centinela

Guía para instalar el panel en una red local (LAN) con un nivel de seguridad razonable.

## Variables de entorno

Servidor (`server/`):

| Variable | Para qué sirve | Valor por defecto |
|---|---|---|
| `PORT` | Puerto HTTP del panel. | `8080` (`9595` en el contenedor) |
| `HOST` | Interfaz donde escucha. `0.0.0.0` abre el panel a la red. | `127.0.0.1` (`0.0.0.0` en el contenedor) |
| `CENTINELA_DATA` | Carpeta de datos (objetivos, usuarios, ajustes, historial). | `data/` junto al proyecto (`/data` en el contenedor) |
| `CENTINELA_AUTH` | `off` desactiva el inicio de sesión. Solo para pruebas aisladas. | `on` |
| `CENTINELA_ADMIN_USER` | Nombre del administrador inicial (solo si no existe `data/users.json`). | `administrador` |
| `CENTINELA_ADMIN_PASSWORD` | Contraseña del administrador inicial, mínimo 8 caracteres (solo si no existe `data/users.json`). | vacía: se genera una aleatoria y se muestra una vez en el log |
| `CENTINELA_ALLOWED_HOSTS` | Lista (separada por comas) de nombres o IP que el servidor acepta en la cabecera `Host`; frena el DNS rebinding. | vacía: con login activo no se filtra el `Host`; con `CENTINELA_AUTH=off` se aceptan solo localhost, el nombre del equipo y sus IP. Cuando está activa, `localhost`, `127.0.0.1` y `::1` se aceptan siempre (el healthcheck sigue funcionando). En el contenedor `compose.yml` la pasa desde `.env` |
| `CENTINELA_COOKIE_SECURE` | `1` marca la cookie de sesión como `Secure` (requiere HTTPS, p. ej. tras un proxy TLS). | desactivado |
| `CENTINELA_CONCURRENCY` | Mediciones simultáneas de todas las organizaciones (2 a 64). | `16` |
| `CENTINELA_CHECK_TIMEOUT_MS` | Plazo global de cada verificación (mínimo 5000). Si se excede, el objetivo queda DOWN con el motivo «La verificación excedió el tiempo máximo»; «verificar ahora» responde 200 con ese resultado, nunca 504. | `120000` (ms) |
| `TZ` | Zona horaria del proceso (no la lee el código: la aplica el sistema; en el contenedor se fija en `compose.yml`). | la del sistema (`America/Mexico_City` en `compose.yml`) |

Agente (`agent/`):

| Variable u opción | Para qué sirve | Valor por defecto |
|---|---|---|
| `CENTINELA_AGENT_TOKEN` | Secreto compartido con el panel. Preferible a `--token`, que queda visible en `ps`. | vacío (obligatorio al escuchar fuera de 127.0.0.1) |
| `CENTINELA_AGENT_HOST` | Interfaz de escucha del agente. | `0.0.0.0` (con aviso si no se fija) |
| `CENTINELA_AGENT_PORT` / `--port` | Puerto del agente. | `9100` |
| `--host` | Igual que `CENTINELA_AGENT_HOST`; usa la IP por la que te alcanza el panel. | `0.0.0.0` |
| `--token` | Igual que `CENTINELA_AGENT_TOKEN`, pero visible en la lista de procesos. | vacío |

## Recomendaciones para LAN

1. **Contraseña inicial.** Define `CENTINELA_ADMIN_PASSWORD` (mín. 8 caracteres) o toma la aleatoria del log de arranque (`docker logs centinela` / `podman logs centinela`). Con la aleatoria (o una de menos de 8 caracteres) el primer acceso obliga a cambiarla; con una propia válida no. La aleatoria se muestra una sola vez en el log, incluso si el arranque falla (por ejemplo, por puerto ocupado), y queda en `docker logs` / `podman logs` hasta que se roten los logs: cámbiala de inmediato al entrar y, si quieres, rota o limpia el log después.
2. **`CENTINELA_ALLOWED_HOSTS`.** Recomendada en LAN para frenar ataques de DNS rebinding: ponle la IP o el nombre con el que se abre el panel. Con contenedor, defínela en `.env` (por ejemplo `CENTINELA_ALLOWED_HOSTS=192.168.1.20,centinela.lan`) y `compose.yml` la pasa al servidor. `localhost`, `127.0.0.1` y `::1` siempre se aceptan, así que el healthcheck no se rompe.
3. **Agente.** Escúchalo solo en la IP necesaria (`--host`), usa `CENTINELA_AGENT_TOKEN` y limita el puerto con el firewall a la IP del panel (o colócalo en una VLAN de gestión). El token viaja en claro por HTTP, por eso conviene que solo el panel alcance ese puerto. Para no dejar el token en el historial del shell (como pasa con `CENTINELA_AGENT_TOKEN=… node agent.js`), ejecútalo con systemd y `EnvironmentFile=` (archivo con permiso `0600`):

   ```
   # /etc/centinela-agent.env  (chmod 600, propietario root)
   CENTINELA_AGENT_TOKEN=un-secreto-largo
   CENTINELA_AGENT_HOST=192.168.1.30

   # /etc/systemd/system/centinela-agent.service
   [Unit]
   Description=Agente de Centinela
   After=network-online.target

   [Service]
   EnvironmentFile=/etc/centinela-agent.env
   ExecStart=/usr/bin/node /opt/centinela/agent/agent.js --port 9100
   Restart=on-failure
   User=nobody

   [Install]
   WantedBy=multi-user.target
   ```

   Actívalo con `sudo systemctl enable --now centinela-agent`.
4. **Nunca `CENTINELA_AUTH=off`** fuera de pruebas aisladas.
5. **TLS opcional.** Si publicas el panel detrás de un proxy inverso con HTTPS, activa `CENTINELA_COOKIE_SECURE=1`. Sin HTTPS no actives esta variable: el navegador no enviaría la cookie y no podrías iniciar sesión. El proxy debe conservar la cabecera `Host` original (en nginx: `proxy_set_header Host $host;`) y `CENTINELA_ALLOWED_HOSTS` debe incluir el nombre público; si el proxy reescribe el Host a `127.0.0.1`, el filtro deja de proteger contra DNS rebinding porque el loopback siempre se acepta.
6. Expón el panel solo a redes de confianza; no lo publiques en Internet.

## Contenedor (Docker / Podman)

- **Endurecimiento aplicado** en `compose.yml`: `cap_drop: ALL` con solo `NET_RAW` (necesario: comprobado en laboratorio, sin él el ping falla por el `setcap` del binario; sirve también para traceroute), `no-new-privileges`, sistema de archivos de solo lectura con `tmpfs` en `/tmp`, usuario sin privilegios (`node`), límites de memoria (512 MB) y de procesos (256), y comprobación de salud.
- **ICMP sin privilegios:** `net.ipv4.ping_group_range: "0 65535"`. Se usa 65535 (y no 2147483647) para que también funcione con podman rootless.
- **`.env`:** crea un archivo `.env` junto a `compose.yml` con `CENTINELA_ADMIN_PASSWORD=...` (mín. 8 caracteres). Añade también `CENTINELA_ALLOWED_HOSTS=...` (ver arriba). Protégelo (`chmod 600 .env`) y no lo subas a ningún repositorio.

## Respaldo de `data/`

Respalda periódicamente la carpeta de datos (o el volumen `centinela-data`) con el servidor detenido o desde una copia consistente. Contiene los hashes de contraseña de los usuarios, así que trata el respaldo como secreto. El servidor crea las carpetas con permisos `0700` y los archivos con `0600`; conserva esos permisos al restaurar. Para recuperar el acceso sin respaldo, borra `data/users.json` y reinicia (se crea de nuevo el administrador).

## Límites de seguridad

- **Intentos de login:** bloqueo de 60 s tras 5 intentos fallidos por usuario, y límite de fallos por dirección IP (más de 20 en 10 minutos devuelve 429).
- **Sesiones:** duran 12 h; hasta 10 por usuario y 500 en total (al cambiar o restablecer una contraseña se cierran las del usuario).
- **Flujos SSE (`/api/stream`):** hasta 5 por sesión y 15 por usuario (con `CENTINELA_AUTH=off`, por IP); al superarlos se expulsa el más antiguo, que recibe un aviso y queda en pausa como «En vivo en otra pestaña» (no se reabre solo: se reconecta al hacer clic o cuando la pestaña pasa a visible, si estaba oculta). El límite global es de 200 flujos; al superarlo el servidor responde 429.
- **Verificar ahora:** `POST /api/targets/:id/check` no responde 504. Si la verificación excede el plazo responde 200 con el objetivo DOWN; si ya hay una en curso de ese objetivo, responde 409 («Ya hay una verificación en curso para este objetivo»).
- **Usuarios:** al editar tu propio usuario no aparece «Obligar a cambiar la contraseña al entrar» y cambiar tu contraseña ahí no cierra tu sesión actual. Con «Obligar a cambiar» y sin contraseña nueva, el usuario afectado deja de recibir datos en vivo hasta que la cambie. En la API, `disabled` solo acepta `true` o `false`.
- **Protección CSRF:** las peticiones `POST`, `PUT` y `DELETE` deben llevar `Content-Type: application/json`, incluso sin cuerpo; si no, el servidor las rechaza. Tenlo presente si automatizas la API con `curl` u otros clientes.
