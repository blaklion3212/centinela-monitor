# Pruebas de ESTE proyecto

Reglas propias de Centinela. Prevalecen sobre las pautas genéricas del skill `estrategia-de-pruebas`.

## Herramientas
- Framework: `node:test` con `node:assert` (integrados en Node; el proyecto no tiene dependencias ni `package-lock.json`).
- Node 18+ (campo `engines`). Local se usa la versión que haya instalada; el CI cubre 18, 20 y 22. Evita APIs de prueba
  que no existan en Node 18 (p. ej. `mock.timers` o `t.assert`); las pruebas usan `require`, `var` y funciones clásicas,
  como el resto del código.
- No hay librería de mocks: los límites del sistema se simulan a mano (servidores HTTP/HTTPS locales, `checks.checkTarget`
  sustituido en el planificador, un reloj acortado, un `traceroute` falso en el PATH).
- `openssl` (solo para las pruebas de TLS): genera certificados autofirmados en un directorio temporal. Si no está, esas
  pruebas se omiten de forma explícita (`skip` con el motivo), nunca fallan ni se ocultan.

## Comandos
- Toda la suite: `npm test` (equivale a `node --test test/*.test.js`).
- Un archivo: `node --test test/auth.test.js`.
- Una prueba por nombre: `node --test --test-name-pattern="N-04" test/trust-proxy.test.js`.
- Cobertura: no hay umbral configurado. Se puede mirar con `node --test --experimental-test-coverage test/*.test.js`
  (Node 20+), solo como referencia.

## Tipos y ubicación
- Todo vive en `test/*.test.js`; cada archivo se ejecuta en su propio proceso y los archivos corren en paralelo. Por eso no
  deben compartir puertos, directorios ni estado.
- Unitarias (módulos puros o con dependencias simuladas): `validate`, `evaluate`, `parsers`, `store`, `auth`, `scheduler`,
  `scheduler-huerfanas`, `charts`, `infrastructure-widget` (scripts de navegador cargados con `vm` y un `NOC` simulado).
- Integración con procesos hijos reales: `api`, `api-extra`, `trust-proxy`, `check-manual` (servidor de `server/server.js`),
  `agent-server` y `agent-tls` (agente de `agent/agent.js`), y `agent-checks`/`http-probe` (sondas contra servidores locales).
- No hay pruebas e2e de navegador (las capturas con Firefox quedan fuera de la suite).
- Nombres de las pruebas: en español, con el identificador del requisito al principio (`R9`, `N-04`, `H-17`, `V-05`, `N-05`,
  `Fase 3 TLS`, `TLS agente`, `TLS checks`) para poder filtrar con `--test-name-pattern`.
- Ayudantes compartidos en `test/helpers/`:
  - `server.js`: `startServer`, `request`, `rawHttp`, `openStream`, `cookieOf`, `freePort`.
  - `tmp.js`: `mkTmp` y `rmTmp` para directorios temporales.
  - `certs.js`: `hayOpenssl` y `generar` (certificado autofirmado y huella `AA:BB:...`).

## Cómo arrancar el servidor y el agente en las pruebas
- Servidor: `await startServer({ env: { ... } })` lanza `server/server.js` como hijo en `127.0.0.1`, con puerto efímero
  (`freePort`) y un directorio de datos temporal con `targets.json` vacío (no se sondea Internet con la semilla). Devuelve
  `{ port, dir, log(), request(), stop() }`. Las variables `CENTINELA_ADMIN_*`, `CENTINELA_AUTH`, `CENTINELA_ALLOWED_HOSTS`,
  `CENTINELA_COOKIE_SECURE` y `CENTINELA_CHECK_TIMEOUT_MS` del entorno no se heredan: se pasan en `opts.env`.
  Con `CENTINELA_ADMIN_PASSWORD` válida no hace falta cambiar la contraseña; sin ella se imprime una aleatoria
  (`adminPassword()`).
- Agente: se lanza `agent/agent.js` con `spawn(process.execPath, [AGENT_JS, '--port', p, '--host', h])` y
  `CENTINELA_AGENT_TOKEN` en el entorno; se espera a la línea "escuchando en" (ver `test/agent-tls.test.js`).
  Para TLS se añaden `--tls-cert` y `--tls-key` (o las variables `CENTINELA_AGENT_TLS_*`).
- Módulos sin proceso (auth, store): fijar `process.env.CENTINELA_DATA` a un directorio temporal ANTES de hacer `require`.
- Esperas: nada de pausas fijas para "dar tiempo". Se espera una señal observable (línea de log, marca en un archivo,
  respuesta `100 Continue` con `Expect: 100-continue`, contador de conexiones) con sondeo y plazo máximo (`esperar`).
  Las únicas esperas fijas aceptadas son las de control negativo ("no llegó nada"), siempre acompañadas de una comprobación
  positiva posterior, y la ventana real de 5 s de H-17.

## Convenciones
- Datos temporales: todo en `os.tmpdir()` vía `tmp.mkTmp`, borrado en `test.after`. Nunca se toca `data/` ni se versionan
  claves o certificados.
- Sin Internet: solo loopback. Las direcciones de documentación (`192.0.2.x`, `203.0.113.x`, `198.51.100.x`) se usan como
  datos, nunca se conectan.
- Loopback adicional: en Linux todo `127.0.0.0/8` es local. Las pruebas que necesitan otra IP de origen o de escucha
  (127.0.0.2–127.0.0.4: agente remoto, cupo por IP, TLS del agente) comprueban primero si el sistema lo permite y, si no
  (macOS, Windows), se omiten con `t.skip(motivo)`. El agente se consulta en 127.0.0.2 porque `127.0.0.1`, `localhost` y `::1`
  se miden en local con `sysmetrics`.
- Procesos: se lanzan con `detached` y se matan por grupo (`process.kill(-pid, 'SIGKILL')`) para que no queden nietos
  (p. ej. el `traceroute` simulado con `sleep 30`). Además hay un `process.on('exit')` de red de seguridad. Quien arranca un
  proceso lo para en `test.after`, aunque la prueba falle.
- Fallos: no se debilita ni se borra una prueba para que pase; se reporta con `archivo:línea` del código de producción.
- Comentarios nuevos en español. Estilo del repo: `'use strict'`, `var`, funciones clásicas, sin dependencias.
- Pruebas de ráfagas y del planificador: el reloj se acorta sustituyendo `global.setTimeout` solo para el plazo global
  (ver `scheduler.test.js` y `scheduler-huerfanas.test.js`); se restaura siempre al terminar.

## CI y tiempos
- `.github/workflows/pruebas.yml`: `npm test` en Node 18, 20 y 22 sobre `ubuntu-latest` (timeout 15 min) y, aparte, la
  construcción de la imagen Docker sin publicar. Ubuntu trae `openssl` y permite 127.0.0.x, así que en CI no se omite nada.
- Tiempos de referencia: la suite completa tarda unos 20 s en un equipo de 24 núcleos. Objetivo: menos de 60 s. Las pruebas más
  lentas son H-17 (espera real de la ventana de 5 s) y `/check` con plazo global vencido (5 s). Si se añaden pruebas, no
  superar ese presupuesto.

## Cobertura mínima
- Sin umbral numérico configurado. Criterio: todo requisito con identificador (R, N, H, V, QA) tiene al menos una prueba
  que lo nombre, con camino feliz, casos límite y error.
- Las pruebas son la red de seguridad de los refactores: deben comprobar comportamiento observable (HTTP, valores
  devueltos, procesos), no detalles internos.
