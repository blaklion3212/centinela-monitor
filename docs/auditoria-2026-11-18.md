# Auditoría inicial de Centinela · 2026-11-18

**Revisión:** de solo lectura, a cargo de `auditor-seguridad` (seguridad) y `revisor-qa` (lógica y calidad). El orquestador verificó en el código los hallazgos principales.

**Contexto de despliegue:** solo red local (LAN).

**Estado de corrección:** se registra en `docs/BITACORA.md`.

## 1. Seguridad

| ID | Sev. | Ubicación | Hallazgo | Corrección acordada |
|---|---|---|---|---|
| H-01 | Crítica | compose.yml, auth.js, server.js | `administrador/admin01` publicada en la red y en el README. El servidor no obliga a cambiarla. | 403 `mustChange` en el servidor hasta cambiarla; contraseña fuera de compose |
| H-02 | Alta | server.js | DNS rebinding: no se valida la cabecera `Host`. Crítico con `CENTINELA_AUTH=off`. | Lista `CENTINELA_ALLOWED_HOSTS` y 421 |
| H-03 | Alta | auth.js | `scryptSync` en el login sin autenticar bloquea el event loop (~23 ms por intento). Es un DoS. | `crypto.scrypt` asíncrono, semáforo y límite por IP |
| H-04 | Alta | auth.js | Bloqueo por usuario+IP evadible; `attempts.clear()` al pasar de 2000 entradas lo borra todo. | Contador por IP, expulsión de entradas antiguas |
| H-05 | Alta | validate.js | Un operador cambia la dirección o el puerto de un objetivo con agente y recibe el token. | Descartar el token si cambia el destino |
| H-06 | Alta (Baja en LAN) | probes/http.js, tcp.js, checks.js | SSRF: sondas hacia redes internas o metadatos de la nube. | Prioridad baja, el despliegue es en LAN |
| H-07 | Media | sysmetrics.js, validate.js | Inyección de argumentos en `systemctl`/`pgrep` con un servicio `-H…`. | Regex con primer carácter alfanumérico y `--` |
| H-08 | Media | server.js, compose.yml | HTTP plano y cookie sin `Secure`. | Opción `CENTINELA_COOKIE_SECURE`; proxy TLS documentado |
| H-09 | Media | checks.js, agent.js | Token del agente en claro, agente en 0.0.0.0 y sin límite de intentos. | Variable de entorno para el token, `--host`, límite por IP |
| H-10 | Media | Dockerfile | Node 20 sin soporte. | Node 22 LTS |
| H-11 | Media | js/widgets/infrastructure.js | `a.cpu.cores` sin escapar en `innerHTML`. | `U.esc` y normalización de la respuesta del agente |
| H-12 | Media | server.js | Un lector puede hacer traceroute a cualquier dirección y acapara los cupos. | Lector solo con `targetId`; cupo por usuario |
| H-13 | Media | auth.js | 500 logins expulsan las sesiones de otros, incluida la del admin. | Tope de sesiones por usuario |
| H-14 | Media | server.js | SSE sin límite de conexiones. | Tope por sesión y global |
| H-15 | Baja | auth.js | El mensaje "deshabilitado" revela que la contraseña es válida. | Mensaje genérico |
| H-16 | Baja | auth.js | La sesión no tiene caducidad absoluta. | 7 días |
| H-17 | Baja | server.js | `/check` sin límite de frecuencia. | Pendiente |
| H-18 | Baja | agent.js | Token visible en `ps`. | `CENTINELA_AGENT_TOKEN` |
| H-19 | Baja | store.js | Sin `fsync`; permisos del `.tmp` y del directorio. | `fsync`, 0600/0700 |
| H-20 | Baja | compose.yml | Falta endurecimiento del contenedor. | `cap_drop`, `no-new-privileges`, `read_only` |
| H-21 | Info | server.js | `/api/health` público expone la versión. | Quitarla |
| H-22 | Info | — | Las organizaciones no tienen aislamiento de permisos (está documentado). | — |
| H-23 | Info | probes/http.js | `rejectUnauthorized:false` es intencional. | — |

**Bien hecho:** `execFile` sin shell; CSRF (JSON obligatorio, comprobación de `Origin` y `SameSite=Strict`); CSP estricta; scrypt con `timingSafeEqual` y hash señuelo; lista blanca de estáticos sin path traversal; tokens nunca enviados al navegador; `users.json` con permisos 0600; ninguna dependencia npm.

## 2. Bugs funcionales

| Sev. | Ubicación | Bug |
|---|---|---|
| Crítica | js/views/targets.js:104 | No se guarda ningún objetivo URL: `root` en lugar de `rootEl`, porque el modal vive en `body`. |
| Alta | js/core/evaluate.js:65 | `r.http.ok` no existe: un sitio que bloquea ICMP sale DOWN aunque responda HTTP 200. |
| Alta (probable) | server/lib/checks.js:19 | `agentFetch` puede no resolver nunca y congelar el planificador. |
| Media | js/services/data.js | Carrera al cambiar de organización: mezcla los datos de dos organizaciones. |
| Media | js/ui/grid.js | `.max-back` queda huérfano y bloquea la pantalla. |
| Media | settings.js / validate.js | Un umbral vacío se guarda como 0; no se valida aviso < crítico. |
| Media | server.js:318 | PUT sobre un objetivo borrado de forma concurrente devuelve 500. |
| Media | store.js | La memoria se actualiza antes de escribir en disco. |
| Media | data.js | Un error del servidor real hace caer a datos simulados. |
| Media | scheduler.js | `reschedule()` reinicia todos los temporizadores en cada edición. |
| Media | server.js SSE | Sin contrapresión ni limpieza explícita. |
| Baja | js/ui/charts.js:69 | `if (!run)` omite el primer punto de la serie. |
| Baja | server.js readBody | Un cuerpo JSON `null` devuelve 500. |
| Baja | http.js, dns.js, login.js | Cuerpo parcial dado por bueno, `ptrCache` sin tope, login colgado. |

## 3. Mantenibilidad
- `api()` ocupa unas 225 líneas: conviene un enrutador declarativo.
- La validación y las estadísticas están duplicadas entre el cliente y el servidor.
- No había git, CHANGELOG ni pruebas automáticas. `package.json` dice 1.0.0 sin historial.
- El README estaba desactualizado: mencionaba `_legacy/` y se contradecía sobre los permisos.
