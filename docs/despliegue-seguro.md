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
| `CENTINELA_CHECK_TIMEOUT_MS` | Plazo global de cada verificación (mínimo 5000). Si se excede, el objetivo queda DOWN con el motivo «La verificación excedió el tiempo máximo»; «verificar ahora» responde 200 con ese resultado, nunca 504. Una sonda que no termina se considera huérfana y se libera como máximo a los 2 × este plazo (ver «Verificaciones colgadas»). | `120000` (ms) |
| `CENTINELA_TRUST_PROXY` | Lista, separada por comas, de IP de proxies inversos de confianza (sin CIDR). Solo para peticiones que llegan desde una de esas IP se lee `X-Forwarded-For` para saber la IP real del cliente. Ver «Proxy de confianza». | vacía: `X-Forwarded-For` se ignora |
| `CENTINELA_TELEGRAM_TOKEN` | Token del bot de las alertas por Telegram (opcional). Tiene prioridad sobre el guardado en el panel. Es un secreto: ver «Alertas por Telegram». `compose.yml` la pasa desde `.env`. | vacía: el token se gestiona desde Ajustes → Alertas |
| `CENTINELA_ALERTS_DISABLED` | `1` o `true` bloquea la función de alertas por completo: no se envía nada, ni pruebas ni búsqueda de chats. Hay que reiniciar. | vacía: permitida |
| `TZ` | Zona horaria del proceso (no la lee el código: la aplica el sistema; en el contenedor se fija en `compose.yml`). | la del sistema (`America/Mexico_City` en `compose.yml`) |

Agente (`agent/`):

| Variable u opción | Para qué sirve | Valor por defecto |
|---|---|---|
| `CENTINELA_AGENT_TOKEN` | Secreto compartido con el panel. Preferible a `--token`, que queda visible en `ps`. | vacío (obligatorio al escuchar fuera de 127.0.0.1) |
| `CENTINELA_AGENT_HOST` | Interfaz de escucha del agente. | `0.0.0.0` (con aviso si no se fija) |
| `CENTINELA_AGENT_PORT` / `--port` | Puerto del agente. | `9100` |
| `--host` | Igual que `CENTINELA_AGENT_HOST`; usa la IP por la que te alcanza el panel. | `0.0.0.0` |
| `--token` | Igual que `CENTINELA_AGENT_TOKEN`, pero visible en la lista de procesos. | vacío |
| `--tls-cert` / `CENTINELA_AGENT_TLS_CERT` | Ruta del certificado PEM para que el agente escuche por HTTPS. Debe indicarse junto con la clave. | vacío (HTTP) |
| `--tls-key` / `CENTINELA_AGENT_TLS_KEY` | Ruta de la clave privada PEM del certificado. | vacío (HTTP) |

## Recomendaciones para LAN

1. **Contraseña inicial.** Define `CENTINELA_ADMIN_PASSWORD` (mín. 8 caracteres) o toma la aleatoria del log de arranque (`docker logs centinela` / `podman logs centinela`). Con la aleatoria (o una de menos de 8 caracteres) el primer acceso obliga a cambiarla; con una propia válida no. La aleatoria se muestra una sola vez en el log, incluso si el arranque falla (por ejemplo, por puerto ocupado), y queda en `docker logs` / `podman logs` hasta que se roten los logs: cámbiala de inmediato al entrar y, si quieres, rota o limpia el log después.
2. **`CENTINELA_ALLOWED_HOSTS`.** Recomendada en LAN para frenar ataques de DNS rebinding: ponle la IP o el nombre con el que se abre el panel. Con contenedor, defínela en `.env` (por ejemplo `CENTINELA_ALLOWED_HOSTS=192.168.1.20,centinela.lan`) y `compose.yml` la pasa al servidor. `localhost`, `127.0.0.1` y `::1` siempre se aceptan, así que el healthcheck no se rompe.
3. **Agente.** Escúchalo solo en la IP necesaria (`--host`), usa `CENTINELA_AGENT_TOKEN` y limita el puerto con el firewall a la IP del panel (o colócalo en una VLAN de gestión). Sin TLS el token viaja en claro por HTTP, por eso conviene que solo el panel alcance ese puerto; si el agente está en una red que no controlas por completo, activa TLS con huella fijada (sección «TLS del agente»). Para no dejar el token en el historial del shell (como pasa con `CENTINELA_AGENT_TOKEN=… node agent.js`), ejecútalo con systemd y `EnvironmentFile=` (archivo con permiso `0600`):

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
5. **TLS opcional.** Si publicas el panel detrás de un proxy inverso con HTTPS, activa `CENTINELA_COOKIE_SECURE=1`. Sin HTTPS no actives esta variable: el navegador no enviaría la cookie y no podrías iniciar sesión. El proxy debe conservar la cabecera `Host` original (en nginx: `proxy_set_header Host $host;`) y `CENTINELA_ALLOWED_HOSTS` debe incluir el nombre público; si el proxy reescribe el Host a `127.0.0.1`, el filtro deja de proteger contra DNS rebinding porque el loopback siempre se acepta. Para que el bloqueo de intentos distinga a cada cliente y no a todos como «el proxy», configura `CENTINELA_TRUST_PROXY` (sección siguiente).
6. Expón el panel solo a redes de confianza; no lo publiques en Internet.

## Proxy de confianza (`CENTINELA_TRUST_PROXY`)

Detrás de un proxy inverso, Centinela ve todas las conexiones como si vinieran del proxy, y por eso el bloqueo de intentos de login (por IP), el límite de flujos en vivo y el cupo de «verificar ahora» sin autenticación se comparten entre todas las personas. Con `CENTINELA_TRUST_PROXY` el servidor usa la IP real del cliente.

**Cómo se decide la IP del cliente**

- Por defecto (variable vacía) `X-Forwarded-For` se ignora: la IP es la de la conexión. Así nadie puede falsificar su IP con esa cabecera.
- Si la conexión llega desde una IP de la lista, el servidor lee `X-Forwarded-For`, de derecha a izquierda, y toma la **primera entrada válida que no sea un proxy de confianza**. Las entradas que no son IP se descartan; si no queda ninguna, se usa la IP de la conexión.
- Si la conexión no viene de una IP de la lista, `X-Forwarded-For` se ignora aunque exista.
- Se aceptan entradas con puerto (`10.0.0.7:5555`) y IPv6 entre corchetes (`[2001:db8::1]:443`); `::ffff:a.b.c.d` se trata como IPv4.

**Formato de la variable**

- Lista de IP separadas por comas: `CENTINELA_TRUST_PROXY=127.0.0.1,10.0.0.5`.
- Solo IP literales (IPv4 o IPv6); **no se admite CIDR** (`10.0.0.0/24`) ni nombres. Una entrada que no sea una IP se ignora y el servidor lo avisa al arrancar: `CENTINELA_TRUST_PROXY: entrada ignorada (no es una IP): …`. Si todas se ignoran, la variable queda sin efecto.

**Requisitos del proxy (si no se cumplen, la protección se rompe)**

1. El proxy debe **añadir** la IP del cliente al **final** de `X-Forwarded-For`, sin reemplazar lo que ya traiga la petición. En nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. Centinela toma la entrada más a la derecha que no sea de confianza, que es la que escribió el proxy; las de la izquierda las pudo inventar el cliente.
2. El puerto de Centinela **no debe ser accesible saltándose el proxy**: limítalo con el firewall (o publícalo solo en `127.0.0.1`) para que únicamente el proxy pueda conectarse. Una conexión que se salte el proxy no lleva la IP que este verificó y, si llega con una IP de la lista de confianza (por ejemplo, otra aplicación del mismo equipo o la NAT del motor de contenedores), podría presentarse con la IP que quiera en `X-Forwarded-For` y esquivar el bloqueo de intentos.
3. El proxy debe **conservar la cabecera `Host`** original (nginx: `proxy_set_header Host $host;`), para que `CENTINELA_ALLOWED_HOSTS` siga protegiendo.

Ejemplo (nginx en la misma máquina, Centinela en `127.0.0.1:8080`):

```
# Arranque de Centinela
CENTINELA_TRUST_PROXY=127.0.0.1 CENTINELA_COOKIE_SECURE=1 CENTINELA_ALLOWED_HOSTS=centinela.lan node server/server.js

# Fragmento de nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location /api/stream {            # flujo en vivo: sin búfer
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
}
```

En la lista pon la IP con la que **Centinela ve al proxy** (la dirección de origen de la conexión), que puede no ser `127.0.0.1` si Centinela corre en un contenedor.

> **Contenedor:** `compose.yml` ya pasa `CENTINELA_TRUST_PROXY` al contenedor; defínela en `.env`. Pon la IP con la que Centinela ve al proxy (el origen de la conexión), que dentro de un contenedor no suele ser 127.0.0.1.

## Alertas por Telegram

Las alertas por Telegram son **opcionales y vienen desactivadas**: con `CENTINELA_TELEGRAM_TOKEN` y `CENTINELA_ALERTS_DISABLED` vacías y sin activarlas en Ajustes → Alertas, Centinela no abre ninguna conexión hacia Telegram. Si las usas:

1. **El token es un secreto.** Quien lo tenga controla el bot. Defínelo con `CENTINELA_TELEGRAM_TOKEN` en el archivo `.env` junto a `compose.yml`, con permisos `600` (`chmod 600 .env`) y **fuera del repositorio** (no lo subas ni lo copies a documentos, tickets o capturas). Tiene prioridad sobre el que se pegue en el panel y deja ese campo bloqueado. Si lo guardas desde el panel, queda en texto plano en `data/alerts.json` (permiso `0600`), que entonces forma parte de lo que debes proteger en los respaldos. El panel y la API nunca lo devuelven, y el servidor no lo escribe en el log.

   ```
   # .env  (chmod 600 .env)
   CENTINELA_TELEGRAM_TOKEN=123456789:AAAA…pega-aquí-tu-token-completo
   ```

   Si se filtra, rótalo con `/token` en @BotFather y actualiza `.env` (y recrea el contenedor con `docker compose up -d`).
2. **Salida a Internet mínima.** El servidor solo necesita HTTPS de salida hacia `api.telegram.org`, puerto 443; no hace falta abrir ningún puerto de entrada. Si tu firewall filtra la salida, permite solo ese destino para el equipo o el contenedor de Centinela. La conexión valida el certificado TLS y no sigue redirecciones.
3. **Sin proxy en la 2.3.0.** La salida es directa: no se usa ningún proxy HTTP/HTTPS. Si el equipo solo sale a Internet por un proxy, las alertas no funcionarán (el panel mostrará «No hay conexión con api.telegram.org…»).
4. **No actives las alertas con `CENTINELA_AUTH=off` en una red compartida.** Sin inicio de sesión, cualquier equipo que llegue al panel puede ver y cambiar la configuración de alertas (chat, activación, pruebas). Si el servidor escucha fuera de loopback, el arranque lo avisa: «AVISO: sin autenticación, cualquier equipo de la red puede configurar las alertas de Telegram».
5. **Bloquear la función.** Para impedir que se use aunque alguien tenga el token, define `CENTINELA_ALERTS_DISABLED=1` (o `true`) y reinicia. No se envían avisos, mensajes de prueba ni búsquedas de chats; la sección Alertas muestra el bloqueo y la configuración guardada se conserva. Quita la variable y reinicia para volver a permitirla.
6. **Privacidad de los avisos.** Cada aviso sale de la red con el nombre del servicio y de su organización y el estado; en el nivel «Completo», también la dirección (sin usuario, contraseña ni parámetros), el motivo y la hora. Pasa por los servidores de Telegram y los chats con bots no tienen cifrado de extremo a extremo: usa un grupo privado con las personas necesarias.
7. **Quién puede configurarlas.** Solo los administradores (rutas `/api/alerts*`); las pruebas y la búsqueda de chats se limitan a una acción a la vez y una cada 5 s por administrador. Cada cambio queda en el log como línea `[alertas] …` con el usuario, sin valores secretos.

Más detalle y problemas frecuentes: capítulo 19 del manual.

## TLS del agente

El agente puede escuchar por HTTPS. Con TLS el token y las métricas viajan cifrados, y la **huella SHA-256 del certificado**, fijada en el objetivo, garantiza que el panel habla con el agente correcto: si la huella no coincide, el panel **no envía el token**.

1. **Genera el certificado** en el servidor del agente (autofirmado, válido 825 días; la línea es la que trae el encabezado de `agent/agent.js`):

   ```
   openssl req -x509 -newkey rsa:2048 -nodes -keyout agent.key -out agent.crt -days 825 -subj "/CN=centinela-agent"
   chmod 600 agent.key
   ```

2. **Arranca el agente** con el certificado y la clave, por opción o por variable:

   ```
   CENTINELA_AGENT_TOKEN=UN_SECRETO_LARGO node agent.js --port 9100 --host IP_DE_ESCUCHA --tls-cert agent.crt --tls-key agent.key
   # o bien: CENTINELA_AGENT_TLS_CERT=agent.crt CENTINELA_AGENT_TLS_KEY=agent.key
   ```

   Hay que indicar certificado y clave a la vez; si falta uno, o no se pueden leer, el agente no arranca. Al iniciar imprime `Agente Centinela escuchando en https://…` y la línea `Huella SHA-256 del certificado (cópiala al dashboard): AA:BB:…`. Sin TLS, con token, avisa: `sin TLS el token viaja en claro`.

3. **Configura el objetivo** en el panel: activa «Medir CPU, RAM, disco…», marca **«Conexión cifrada (TLS)»** y pega la huella en «Huella SHA-256 del certificado». Es **obligatoria** con TLS: se acepta con o sin `:` (64 caracteres hexadecimales). Vuelve a escribir el token.

**Comportamiento**

- El panel no valida la cadena del certificado (es autofirmado): la autenticidad la da la huella. El token se añade a la petición solo después de comprobar que el certificado presentado tiene esa huella.
- Plazo máximo de la consulta al agente: 10 s en total. Errores que verás en el objetivo (motivo de «Agente sin respuesta»):
  - `Falta la huella TLS del agente`: el objetivo tiene TLS pero no huella (por ejemplo, guardado por una versión anterior); no se envía el token.
  - `La huella TLS del agente no coincide (posible suplantación)`: el certificado es otro. Si cambiaste el certificado del agente, copia la huella nueva; si no lo hiciste, investiga.
  - `El agente tardó demasiado en responder`: se agotaron los 10 s.
- **El token guardado se descarta** si cambian la dirección, el puerto o la huella, o si se desactiva TLS (para que el secreto no viaje a otro destino o sin cifrar). Hay que volver a escribirlo en el formulario; si guardas sin hacerlo, el agente responderá «token rechazado». El formulario avisa antes de guardar.
- Al renovar el certificado del agente, la huella cambia: actualízala en cada objetivo que lo use y reescribe el token.
- La huella de un objetivo sin TLS se descarta al guardar.
- Un objetivo hacia `127.0.0.1`/`localhost` se mide directamente, sin agente ni TLS.

## Contenedor (Docker / Podman)

- **Endurecimiento aplicado** en `compose.yml`: `cap_drop: ALL` con solo `NET_RAW` (necesario: comprobado en laboratorio, sin él el ping falla por el `setcap` del binario; sirve también para traceroute), `no-new-privileges`, sistema de archivos de solo lectura con `tmpfs` en `/tmp`, usuario sin privilegios (`node`), límites de memoria (512 MB) y de procesos (256), y comprobación de salud.
- **Reiniciar y arrancar con el equipo (Podman):** ver «Podman: reinicio y arranque con el equipo» más abajo.
- **ICMP sin privilegios:** `- net.ipv4.ping_group_range=0 65535`. Se usa 65535 (y no 2147483647) para que también funcione con podman rootless. Va en forma de lista porque podman-compose 1.0.x no entiende la forma de clave y valor.
- **`.env`:** crea un archivo `.env` junto a `compose.yml` con `CENTINELA_ADMIN_PASSWORD=...` (mín. 8 caracteres). Añade también `CENTINELA_ALLOWED_HOSTS=...` (ver arriba). Protégelo (`chmod 600 .env`) y no lo subas a ningún repositorio. Si usas las alertas por Telegram, define ahí también `CENTINELA_TELEGRAM_TOKEN` (sección «Alertas por Telegram»).

## Podman: reinicio y arranque con el equipo

Comprobado en laboratorio con Podman sin root en el equipo de pruebas (no es un fallo de Centinela, sino de Podman rootless en este tipo de host):

- **No uses `podman restart centinela`.** Falla con `rootless netns: kill network process: permission denied` (código 125) y deja el contenedor **detenido**. Ocurre también dentro de un pod.
- **Formas que sí funcionan:**
  - `podman-compose -p <proyecto> restart` (el contenedor queda `healthy` y `/api/health` responde).
  - `podman stop centinela && podman start centinela`.
- **Arranque con el equipo:** `restart: unless-stopped` solo levanta el contenedor tras reiniciar el equipo si el servicio de usuario `podman-restart` está activo, y en Podman sin root suele venir **deshabilitado**. Actívalo y permite que tu usuario tenga servicios sin sesión abierta:

  ```
  systemctl --user enable podman-restart.service
  loginctl enable-linger $USER
  ```

- Si tras un reinicio el contenedor sigue detenido, revisa `systemctl --user status podman-restart.service` y `podman ps -a`.

## Respaldo de `data/`

Respalda periódicamente la carpeta de datos (o el volumen `centinela-data`) con el servidor detenido o desde una copia consistente. Contiene los hashes de contraseña de los usuarios y, si guardaste el token de Telegram desde el panel, ese token en `alerts.json`, así que trata el respaldo como secreto. El servidor crea las carpetas con permisos `0700` y los archivos con `0600`; conserva esos permisos al restaurar. Para recuperar el acceso sin respaldo, borra `data/users.json` y reinicia (se crea de nuevo el administrador).

## Límites de seguridad

- **Intentos de login:** bloqueo de 60 s tras 5 intentos fallidos por usuario, y límite de fallos por dirección IP (más de 20 en 10 minutos devuelve 429). El intento se cuenta **antes** de verificar la contraseña (y se descuenta si resulta correcta), así que una ráfaga de peticiones en paralelo no supera el límite. El nombre de usuario se normaliza (sin espacios en los extremos y sin distinguir mayúsculas): `Admin`, `admin` y ` admin ` comparten el mismo contador. Detrás de un proxy, la IP depende de `CENTINELA_TRUST_PROXY`.
- **Sesiones:** duran 12 h; hasta 10 por usuario y 500 en total (al cambiar o restablecer una contraseña se cierran las del usuario).
- **Flujos SSE (`/api/stream`):** hasta 5 por sesión y 15 por usuario (con `CENTINELA_AUTH=off`, por IP); al superarlos se expulsa el más antiguo, que recibe un aviso y queda en pausa como «En vivo en otra pestaña» (no se reabre solo: se reconecta al hacer clic o cuando la pestaña pasa a visible, si estaba oculta). El límite global es de 200 flujos; al superarlo el servidor responde 429.
- **Verificar ahora:** `POST /api/targets/:id/check` no responde 504. Si la verificación excede el plazo responde 200 con el objetivo DOWN. Límites, en este orden:
  - Ya hay una en curso de ese objetivo: 409 («Ya hay una verificación en curso para este objetivo»).
  - Han pasado menos de 5 s desde la última verificación manual de ese objetivo: 429 («Espera unos segundos antes de volver a verificar este objetivo») con `Retry-After` en segundos.
  - Cupo por usuario (por IP si `CENTINELA_AUTH=off`): 3 simultáneas y 30 por minuto; al superarlo, 429 «Demasiadas verificaciones manuales; espera un momento» con `Retry-After`.
- **Verificaciones colgadas:** si una verificación pasa del plazo global, el objetivo queda DOWN pero su sonda puede seguir viva (huérfana). Una huérfana se libera como máximo a los 2 × `CENTINELA_CHECK_TIMEOUT_MS` y, mientras vive, reduce la capacidad de mediciones simultáneas (hasta la mitad de `CENTINELA_CONCURRENCY`) para que no se acumule carga. La consola avisa con `[scheduler] verificación huérfana: "<nombre>" excedió el plazo; huérfanas vivas: N` y, al liberarla, con otra línea que indica el motivo.
- **Agente con TLS:** plazo absoluto de 10 s por consulta y, con huella distinta, el token no se envía (sección «TLS del agente»).
- **Usuarios:** al editar tu propio usuario no aparece «Obligar a cambiar la contraseña al entrar» y cambiar tu contraseña ahí no cierra tu sesión actual. Con «Obligar a cambiar» y sin contraseña nueva, el usuario afectado deja de recibir datos en vivo hasta que la cambie, y su pestaña abierta le muestra la ventana «Debes cambiar tu contraseña» (no hace falta que recargue ni cierre sesión). En la API, `disabled` solo acepta `true` o `false`.
- **Protección CSRF:** las peticiones `POST`, `PUT` y `DELETE` deben llevar `Content-Type: application/json`, incluso sin cuerpo; si no, el servidor las rechaza. Tenlo presente si automatizas la API con `curl` u otros clientes.
