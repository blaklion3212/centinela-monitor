# Centinela · Dashboard de monitoreo (estilo PingPlotter / Zabbix)

Panel modular en HTML/CSS/JS puro (sin dependencias) + un servidor Node opcional que hace las **mediciones reales**.

## Cómo usarlo

| Modo | Cómo | Qué obtienes |
|---|---|---|
| **Real** | `node server/server.js` → abre http://127.0.0.1:8080 | Ping, DNS, HTTP/TTFB, SSL, puertos, traceroute y métricas del servidor, medidos de verdad |
| **Demostración** | Abre `index.html` con doble clic | Datos simulados para ver y probar la interfaz (un navegador no puede hacer ping ni traceroute por sí solo) |

Requisitos del modo real: **Node 18+**. Windows y Linux (en Linux instala `traceroute` si falta). `PORT=9000 node server/server.js` cambia el puerto; `HOST=0.0.0.0` lo abre a la red.

## Acceso: usuarios y roles
El modo real pide **usuario y contraseña**. La primera vez crea el administrador **`administrador`** (variable `CENTINELA_ADMIN_USER`). Su contraseña inicial **no es fija**: si defines `CENTINELA_ADMIN_PASSWORD` (mínimo 8 caracteres) se usa esa; si no, el servidor genera una aleatoria y la muestra **una sola vez** en el log de arranque (`docker logs centinela` o `podman logs centinela`; si lo ejecutas con `node`, en la consola). Ambas variables solo se leen cuando aún no existe `data/users.json`. **Si la contraseña es la aleatoria (o una de menos de 8 caracteres), el primer acceso obliga a cambiarla.** La sección **Usuarios** (solo administradores) da de alta, edita, deshabilita y elimina usuarios con tres roles: *Administrador* (todo), *Operador* (edita objetivos, organizaciones, ajustes y ventanas) y *Lector* (solo consulta); al crear un usuario o restablecer su contraseña puedes obligarlo a cambiarla al entrar. Contraseñas cifradas con scrypt, sesión de 12 h, bloqueo de 60 s tras 5 intentos fallidos (el intento se cuenta antes de verificar la contraseña; mayúsculas y espacios del usuario comparten contador), siempre queda al menos un administrador. `CENTINELA_AUTH=off` desactiva el login (solo entornos aislados). Si pierdes todas las contraseñas de administrador: detén el servidor, borra `data/users.json` y arranca de nuevo (se genera una contraseña nueva).

## Contenedor (Docker / Podman)
```
docker compose up -d --build      # o: podman-compose up -d --build
```
Define `CENTINELA_ADMIN_PASSWORD` (mín. 8 caracteres) en un archivo `.env` junto a `compose.yml`; si no, la contraseña inicial aleatoria aparece en `docker logs centinela` / `podman logs centinela`. Abre `http://IP-DEL-SERVIDOR:9595` (puerto 9595 publicado en todas las interfaces; los datos van en el volumen `centinela-data`). Archivos: `Dockerfile`, `compose.yml`, `.dockerignore`. Dentro del contenedor `127.0.0.1` es el propio contenedor; para métricas de un servidor instala el agente en él. Detalles en el manual (capítulo 14). Paso a paso completo, desde instalar el motor hasta abrir el panel: sección 14.7 (Linux) y sección 14.8 (Windows; basada en la documentación de Docker y Podman, Centinela se probó en Linux).

## Alertas por Telegram (opcionales)
Centinela puede avisar por Telegram cuando un servicio **cae**, se **recupera** y, según lo que elijas en el panel **Qué avisar** (nueve tipos: caída, recuperación, certificado vencido, certificado por vencer, certificado no confiable, alta latencia o pérdida, recursos del servidor, espacio en disco y otras degradaciones), por otros problemas. Por defecto solo avisa de caídas, recuperaciones y certificado vencido; la 2.5.0 convierte sola tu configuración anterior y no añade variables de entorno. Es **opcional y viene desactivada**: solo los administradores la configuran, en *Ajustes → Alertas*, con un panel de ayuda «Cómo configurarlo» (crear el bot con @BotFather, guardar el token, buscar el chat, enviar un mensaje de prueba y activar). Antirruido: avisa tras N fallos seguidos (2 por defecto), agrupa los avisos en ventanas de 30 s, no repite caídas ya avisadas tras reiniciar y avisa la recuperación. El servidor necesita salida HTTPS a `api.telegram.org:443` (sin proxy en la 2.3.0). Los avisos salen de tu red y pasan por los servidores de Telegram, sin cifrado de extremo a extremo.

| Variable | Qué hace | Por defecto |
|---|---|---|
| `CENTINELA_TELEGRAM_TOKEN` | Token del bot. Tiene prioridad sobre el guardado en el panel (que queda bloqueado). Es un secreto: en contenedor ponlo en `.env` con `chmod 600 .env`, fuera del repositorio. | vacía |
| `CENTINELA_ALERTS_DISABLED` | `1` o `true` bloquea la función por completo (no se envía nada, ni pruebas ni búsqueda de chats). | vacía (permitida) |

Con ambas vacías el comportamiento es el de la 2.2.x. Guía completa, grupos y canales, privacidad y problemas frecuentes: [capítulo 19 del manual](docs/manual/manual.md#19-alertas-por-telegram) y [Despliegue seguro](docs/despliegue-seguro.md#alertas-por-telegram).

## Estados
- **UP**: todo dentro de lo esperado.
- **DEGRADADO**: responde pero fuera de umbral (latencia, pérdida, jitter, TTFB, SSL por vencer, disco/CPU/RAM altos).
- **DOWN**: sin respuesta, HTTP fuera de lo esperado, puerto cerrado, certificado vencido, servicio detenido.

Los umbrales se editan en **Ajustes**.

## Estructura
```
index.html            Página principal
assets/css/           Estilos (tokens de color, base, componentes, ventanas, widgets, vistas)
assets/img/           Logo e ícono
js/config/            Valores por defecto y objetivos de ejemplo
js/core/              Lógica compartida: estado UP/DEGRADADO/DOWN, validación, almacén de datos
js/services/          Fuentes de datos: servidor real (source-live), demostración (source-demo) y sesión (auth)
js/ui/                Íconos, modales, gráficas SVG y gestor de ventanas (grid.js)
js/widgets/           Una ventana por tipo (se registran en registry.js)
js/views/             Panel, Objetivos, Ajustes y barra de organizaciones (orgs.js)
server/               API, planificador y sondas (ping, dns, http, tls, tcp, traceroute)
agent/                Agente para medir CPU/RAM/disco/servicios de servidores remotos
data/                 targets.json, settings.json, layout.json, orgs.json, users.json y orgs/<id>/ (se crean al primer arranque); alerts.json al configurar las alertas por Telegram
```

## Organizaciones (varios clientes o sedes)
La barra bajo el encabezado tiene una pestaña por organización. **Host** es la principal (tu panel de siempre, no se puede eliminar); con **+ Organización** creas otras. Cada una tiene sus propios objetivos y su propia disposición de ventanas, con el mismo Panel. Todas se miden siempre y sus alertas llegan a la bitácora global con la etiqueta de su organización (al pulsar una, el panel salta a ella). El aislamiento es solo visual: los permisos son por rol, no por organización. Los chequeos de todas las organizaciones comparten un tope de simultaneidad (`CENTINELA_CONCURRENCY`, 16 por defecto).

## Agregar IPs / URLs
Vista **Objetivos** → *Agregar objetivo*: nombre del servicio, tipo (IP/host o URL), etiquetas, intervalo y qué medir. También importa/exporta JSON o CSV.

## Servidores remotos (CPU, RAM, disco, servicios)
Copia `agent/` al servidor y define el secreto en la variable `CENTINELA_AGENT_TOKEN` (así no queda visible en `ps`) y ejecuta `CENTINELA_AGENT_TOKEN=SECRETO node agent.js --port 9100 --host IP_DE_ESCUCHA`, donde `--host` es la IP por la que te alcanza el panel. En el objetivo activa *Salud del servidor* con el mismo puerto y token. Abre ese puerto solo a la IP del panel.

**TLS opcional (recomendado fuera de una red de gestión aislada).** Genera un certificado autofirmado y arranca el agente con `--tls-cert` y `--tls-key` (o `CENTINELA_AGENT_TLS_CERT` y `CENTINELA_AGENT_TLS_KEY`):
```
openssl req -x509 -newkey rsa:2048 -nodes -keyout agent.key -out agent.crt -days 825 -subj "/CN=centinela-agent"
CENTINELA_AGENT_TOKEN=SECRETO node agent.js --port 9100 --host IP_DE_ESCUCHA --tls-cert agent.crt --tls-key agent.key
```
Al arrancar el agente imprime la **huella SHA-256** del certificado. En el objetivo marca *Conexión cifrada (TLS)* y pega esa huella: es **obligatoria** y el token solo se envía si el certificado presentado la tiene. Si cambian la dirección, el puerto o la huella, o se desactiva TLS, el token guardado se descarta y hay que volver a escribirlo. Plazo máximo de la consulta al agente: 10 s. Detalles en [Despliegue seguro](docs/despliegue-seguro.md) y en el manual (sección 11.4).

## Variables de entorno nuevas en la 2.1.0
| Variable | Qué hace |
|---|---|
| `CENTINELA_TRUST_PROXY` | Lista de IP (sin CIDR) de proxies inversos de confianza; solo de ellos se lee `X-Forwarded-For` (se usa la entrada válida más a la derecha que no sea de confianza). El proxy debe **añadir** la IP al final (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`), conservar `Host` y ser la única vía de acceso al puerto. Vacía: la cabecera se ignora. |
| `CENTINELA_AGENT_TLS_CERT` / `CENTINELA_AGENT_TLS_KEY` | Certificado y clave PEM del agente (equivalen a `--tls-cert` / `--tls-key`). |

Además: `POST /api/targets/:id/check` responde 409 si ya hay una verificación en curso, 429 si pasaron menos de 5 s en ese objetivo y 429 con 3 simultáneas o 30 por minuto por usuario (con `Retry-After`); las verificaciones colgadas se liberan como máximo a 2 × `CENTINELA_CHECK_TIMEOUT_MS` y reducen la capacidad mientras tanto. En Podman sin root no uses `podman restart` (deja el contenedor detenido): usa `podman-compose -p <proyecto> restart` o `podman stop` + `podman start` (ver la guía de despliegue).

## Ventanas
Arrastra el título para mover, el borde/esquina para redimensionar, ↗ para ampliar, ✕ para quitar. *Agregar ventana* abre la galería (puedes repetir un tipo con distinto objetivo). *Disposición bloqueada* evita cambios accidentales. Se guarda sola.

## Nuevo widget
Crea `js/widgets/mi-widget.js` con `NOC.widgets.register({ type, title, icon, desc, render(ctx) {...} })` y añade el `<script>` en `index.html`.

## Pruebas
`npm test` (399 pruebas, sin dependencias). La integración continua (GitHub Actions, `.github/workflows/pruebas.yml`) ejecuta la suite con Node 18, 20, 22 y 24 y construye la imagen del contenedor en cada push y pull request a `main`.

## Documentación
- [Bitácora del proyecto](docs/BITACORA.md)
- [Auditoría 2026-11-18](docs/auditoria-2026-11-18.md)
- [Despliegue seguro](docs/despliegue-seguro.md)
