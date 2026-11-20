# Requisitos: «Qué avisar», tipos de alerta seleccionables (versión 2.5.0)

**Estado:** aprobado, implementado y publicado en la versión 2.5.0.
**Fecha:** 2026-11-19
**Fuentes:** [alertas.md](alertas.md) (RA-01 a RA-99, vigentes salvo lo que aquí se sustituye), [arquitectura-alertas.md](arquitectura-alertas.md), `server/lib/notify.js` (`decide`, `formatMessage`, `alerted`, `prune`, `reload`), `server/lib/alerts-config.js` (`DEFAULTS`, `sanitize`, `validateUpdate`, `publicView`), `js/views/alerts.js`, `server/lib/scheduler.js` (emite `'result'` en cada verificación), `js/core/evaluate.js` (motivos `{level, text, down, code}`), `js/config/defaults.js` (`thresholds`).

## 1. Alcance

### 1.1 Dentro del alcance (2.5.0)

- Panel «Qué avisar» en Ajustes → Alertas con una casilla por tipo (9 tipos, sección 3).
- Clasificación de cada motivo del evaluador en un tipo, estado avisado por tipo (y subclave), recuperación propia por tipo y antirruido (N fallos seguidos, agrupación por chat, «chat coherente» tras reinicios) también por tipo.
- Campo nuevo `notify` en `data/alerts.json` y en `GET/PUT /api/alerts`; migración automática de `notifyRecovery`/`notifyDegraded` y del mapa `alerted` de 2.4.0.
- Mensajes por tipo (mínimo y completo), ayuda integrada y documentación.

### 1.2 Fuera de alcance

- Selección por objetivo u organización (la selección es global; decisión 2).
- Nuevos umbrales o nuevos motivos del evaluador (solo se añade el campo `sub`, RT-05).
- Horario silencioso, otros canales, persistencia de la cola, cambios en token/chat/cola/reintentos (RA-20 a RA-48 no cambian).
- Un archivo de datos nuevo: se sigue usando `data/alerts.json`.

## 2. Supuestos

- S1. Todo lo de `alertas.md` que no se contradiga aquí sigue vigente. Se **sustituyen**: RA-12 (campos `notifyRecovery`/`notifyDegraded`), RA-40 a RA-44 (decisión por estado global), RA-42 (DEGRADADO opcional), RA-61 (casillas «Avisar de recuperaciones» y «Avisar también de DEGRADADO») y el campo `alerted` de la sección 8.
- S2. El motor sigue suscrito a `'result'`; `r.reasons` y los datos crudos (`r.ping`, `r.http`, `r.ssl`, `r.agent`) están disponibles en el resultado.
- S3. `js/core/evaluate.js` es compartido con el navegador (UMD). Añadir un campo opcional a los motivos es compatible hacia atrás.
- S4. Los ids de objetivo cumplen `^[A-Za-z0-9_-]{1,64}$` (no contienen `|`).
- S5. «N» es `failsBeforeAlert` (1 a 10, por defecto 2).
- S6. Los estados `unknown` y los motivos de nivel `info` (p. ej. `icmp`) nunca generan avisos ni cuentan.

## 3. Los 9 tipos y su clave interna

| Casilla (UI) | Clave `notify` | Por defecto |
|---|---|---|
| Caída | `down` | sí |
| Recuperación | `recovery` | sí |
| Certificado vencido | `certExpired` | sí |
| Certificado por vencer | `certExpiring` | no |
| Certificado no confiable | `certTrust` | no |
| Alta latencia o pérdida | `latency` | no |
| Recursos del servidor (agente) | `resources` | no |
| Espacio en disco (particiones) | `disk` | no |
| Otras degradaciones | `other` | no |

`recovery` no es un tipo de evento: es el interruptor general de los avisos de recuperación de todos los demás tipos.

## 4. Requisitos

Convención: `RT-nn`; criterios Dado/Cuando/Entonces. Las pruebas usan el simulador de Telegram local y reloj falso (RA-96); no hay red real.

### 4.1 Clasificación de motivos

**RT-01. Mapeo exacto motivo → tipo.** Cada motivo (`code`, `level`, `down`, `sub`) se asigna a un único tipo, de forma estática (no depende de qué casillas estén activas):

| Motivo | Tipo | Subclave | Nivel de aviso |
|---|---|---|---|
| `dns`, `ping`, `port`, `http`, `keyword`, `service`, `timeout` (crit, `down:true`) y cualquier otro con `down:true` salvo `ssl` vencido | `down` | (ninguna) | `on` |
| `ssl` con `sub:'expired'` (crit, `down:true`) | `certExpired` | (ninguna) | `on` |
| `ssl` con `sub:'expiring'` (warn o crit) | `certExpiring` | (ninguna) | `warn` o `crit` |
| `ssl-trust` (warn) | `certTrust` | (ninguna) | `on` |
| `latency`, `loss`, `jitter`, `ttfb` con `level:'crit'` | `latency` | el `code` | `on` |
| `cpu`, `mem`, `io` con `level:'crit'` | `resources` | el `code` | `on` |
| `disk` (warn o crit) | `disk` | el punto de montaje (`d.mount`) | `warn` o `crit` |
| `latency`, `loss`, `jitter`, `ttfb`, `cpu`, `mem`, `io` con `level:'warn'` | `other` | el `code` | `on` |
| `ssl` con `sub:'unreadable'` (warn, «no se pudo leer») | `other` | `ssl` | `on` |
| `agent` (warn, agente sin respuesta) | `other` | `agent` | `on` |
| Cualquier `code` no listado con `level` `warn` o `crit` y `down:false` | `other` | el `code` | `on` |
| `level:'info'` (`icmp`) | ninguno | | |

Aceptación: prueba unitaria de una función pura `classify(reason)` con una fila por celda de la tabla, incluido un `code` inventado (`other`) y un `down:true` inventado (`down`).

**RT-02. Caída y certificado vencido a la vez (regla de no duplicar).** `ssl` vencido marca `down:true` pero se avisa **solo** como `certExpired`, nunca como `down`. Un objetivo está en `down` (tipo) solo si tiene algún motivo `down:true` que no sea `ssl` vencido.
- Dado un objetivo cuyo único motivo `down` es el certificado vencido y con `down` y `certExpired` activados, cuando se cumplen N fallos, entonces se envía un solo aviso («CERTIFICADO VENCIDO») y ninguno de «CAÍDO».
- Dado el mismo caso con `certExpired` desactivado y `down` activado, entonces no se envía nada (la persona eligió no recibirlo).
- Dado un objetivo con puerto cerrado y certificado vencido, con ambos tipos activos, entonces se envían dos avisos independientes (uno por tipo), con la misma ventana de agrupación (RT-31).
- Razón: cada tipo tiene su casilla y su recuperación; mezclarlos haría imposible respetar las casillas.

**RT-03. Motivos de varios tipos en un resultado.** Cada tipo se evalúa por separado en cada resultado; un tipo desactivado no influye en los demás ni en sus contadores.

**RT-04. Un tipo activo «posee» su familia.** La familia es el `code` (más `sub` de partición para `disk`). Mientras exista una clave avisada de un tipo para una familia, los motivos de esa familia de cualquier nivel (p. ej. `latency` warn tras un `latency` crit avisado) no generan avisos del tipo `other` y mantienen viva la clave; ésta solo se recupera cuando la familia desaparece por completo (RT-14). Cuando `latency` o `resources` pasan de `warn` (aviso `other`) a `crit`, la clave `other` de esa familia se elimina en silencio al activarse la del tipo específico. Cuando `certExpired` se activa, se elimina en silencio la clave `certExpiring`; ese relevo solo rige mientras el certificado SIGUE vencido (la familia de `certExpired` es solo «ssl vencido», distinta de la familia `ssl` de `certExpiring`).
- Aceptación: secuencias de resultados que comprueban que no hay recuperación falsa ni doble aviso en estos tres casos.

**RT-05. Campo `sub` en los motivos.** `js/core/evaluate.js` añade a cada motivo un campo opcional `sub`: para `ssl`, `'expired' | 'expiring' | 'unreadable'`; para `disk`, el punto de montaje (`d.mount`). No cambia `level`, `text`, `down` ni `code`, ni el cálculo de `status`.
- Aceptación: las pruebas existentes de `evaluate` pasan sin cambios; nuevas pruebas fijan los `sub` por caso.

### 4.2 Estado avisado (clave, persistencia, límites)

**RT-10. Clave del estado avisado.** En `data/alerts.json`, `alerted` pasa a ser `{ clave: nivel }` donde:
- `clave = <targetId>|<tipo>` o `<targetId>|<tipo>|<sub>`, con `<tipo>` uno de `down`, `certExpired`, `certExpiring`, `certTrust`, `latency`, `resources`, `disk`, `other`, y `<sub>` el `code` o el punto de montaje codificado con `encodeURIComponent` (ejemplos: `abc123|down`, `abc123|latency|ttfb`, `abc123|disk|%2Fvar`, `abc123|certExpiring`).
- `nivel` es `'on'`, `'warn'` o `'crit'` (`warn`/`crit` solo en `certExpiring` y `disk`); además `'m'` (migrado de 2.4.0) solo en `down` (RT-23).
- Aceptación: pruebas de ida y vuelta de `sanitize`: claves válidas se conservan; claves con tipo desconocido, id inválido, `__proto__`, valor distinto de `on|warn|crit` o `sub` de más de 200 caracteres codificados se descartan.

**RT-11. Límites.** Máximo 5000 entradas en total (`MAX_ALERTED`, ya existente) y 64 por objetivo (`MAX_ALERTED_PER_TARGET`). Al alcanzar un límite, el aviso se envía igualmente pero la clave no se persiste, se escribe una sola línea de log por episodio («Límite de avisos recordados alcanzado») y se cuenta en el estado. El punto de montaje se limpia de caracteres de control y se recorta a 100 caracteres antes de codificarlo.
- Aceptación: prueba con 70 particiones en un objetivo y con 5001 claves cargadas.

**RT-12. Escritura.** Igual que 2.4.0 (RA-44): escritura atómica y diferida (`SAVE_DELAY_MS`), solo cuando cambia `alerted`; se vacía de inmediato al desactivar la función o cambiar de chat general.

**RT-13. Limpieza.**
- Al borrar un objetivo (`prune`) se eliminan todas las claves con prefijo `<id>|` y sus contadores, sin avisar recuperación.
- Partición que desaparece: si el agente responde (medible, RT-15) y el punto de montaje no figura en `agent.disks` durante N resultados consecutivos, la clave `disk` se elimina **en silencio** (no se afirma que el espacio esté normal).
- Fuente deshabilitada: la fuente de una clave (ping, http, ssl o agente) se considera ausente cuando el objetivo ya no la tiene habilitada en su configuración (`checks`: `ping`, `http` solo en objetivos url, `ssl`, `agent.enabled`); entonces sus claves se eliminan en silencio. Que el resultado no traiga la fuente (fallo de DNS, plazo global agotado) NO la hace ausente: ver RT-15. Si el servidor no conoce la configuración del objetivo, se decide por presencia en el resultado (`r.agent`, `r.ssl`, `r.http` o `r.ping` indefinidos, o `ping.unavailable`).
- Tipo desactivado: al guardar `notify` con un tipo en `false`, sus claves se eliminan en silencio y sus contadores se reinician (RT-17).
- Un objetivo deshabilitado conserva sus claves (como en 2.4.0) y pierde sus contadores.
- Aceptación: una prueba por cada viñeta; en todas, el simulador no recibe mensajes de recuperación.

### 4.3 Reglas por tipo

**RT-14. Ciclo común (activación, escalado, recuperación).**
- Contador por clave y nivel: resultados consecutivos en que la condición del tipo está presente con nivel igual o superior. Se avisa al llegar a N (RA-40: exactamente un aviso por episodio). Un resultado medible sin la condición reinicia el contador; un resultado no medible (RT-15) lo deja como está.
- Recuperación: un resultado **medible** en el que la familia de la clave no tiene ningún motivo (ni warn ni crit) → se elimina la clave y, si `notify.recovery` y el tipo siguen activos, se avisa «normal» del tipo. Con `recovery` desactivado la clave se elimina en silencio (como `alerted` en 2.4.0).
- Escalado (`certExpiring`, `disk`): sin aviso previo, al llegar a N resultados con la condición se avisa con el **nivel actual** (`warn` o `crit`), sin aviso `warn` intermedio si el resultado que completa N ya es `crit`; desde un `warn` ya avisado, al cruzar el crítico se avisa de nuevo con nivel `crit` (tras N resultados seguidos en `crit`) y la clave pasa a `crit`. Si el nivel baja (p. ej. cambió un umbral en Ajustes) la clave baja en silencio y un nuevo cruce al alza vuelve a avisar. Mientras el nivel no sube, no hay repetición en cada comprobación.
- `down` (compatibilidad con 2.4.0): se recupera cuando el objetivo **deja de estar CAÍDO** (ningún motivo que lo clasifique como `down`, RT-02) en un resultado cuyo estado no es `unknown`. No espera a que todas las degradaciones terminen. Mientras `status` siga siendo `down` (p. ej. solo queda el certificado vencido con `certExpired` desactivado) la clave `down` NO se recupera; con `certExpired` desactivado no se envía ningún aviso por el certificado (RT-02). Al dejar de estar `down` el estado, recuperación normal.
- Aceptación: tabla de secuencias por tipo (cada una con N=1 y N=2).

**RT-15. Resultado «medible» por fuente.** Una recuperación o un «cuenta como limpio» exige que la fuente se haya medido:

| Familia | Medible cuando |
|---|---|
| `down` | `status` no es `unknown` |
| `latency`, `loss`, `jitter` | `r.ping` existe, no `unavailable` y `received > 0` |
| `ttfb` | `r.http` existe, sin `error`, con `ttfbMs` numérico y sin motivo `http` |
| `ssl` (vencido, por vencer), `ssl-trust` | `r.ssl` existe y sin `error` |
| `cpu`, `mem`, `io`, `disk` y `agent` | `r.agent` existe y sin `error` (para `disk`, además el montaje figura en `agent.disks`) |
| `other` con `code` no listado | el resultado no es `unknown` |

Si la fuente existe pero no es medible, la clave y el contador se mantienen (ni recupera ni cuenta). Si la fuente falta del todo, aplica RT-13.

Además, un resultado con `r.dns.error`, con un motivo `timeout` o sin ninguna fuente presente (ni `ping`, ni `http`, ni `ssl`, ni `agent`) es «no medible» para todas las familias salvo `down`: las claves y los contadores se conservan. Las familias de certificado se separan: `ssl-expired` (certExpired), `ssl` (certExpiring) y `ssl-unreadable` («no se pudo leer», tipo `other`).
- Aceptación: pérdida del 100 % de paquetes con un `latency` avisado no genera «Latencia normal»; un agente caído con `resources`/`disk` avisados no genera recuperaciones.

**RT-16. Agente deja de responder.** Se mantienen las claves de `resources` y `disk` y sus contadores (RT-15); solo el tipo `other` avisa «Agente sin respuesta» (si está activo). Cuando el agente vuelve, las claves se evalúan con normalidad: si la condición sigue, no se repite el aviso; si ya no existe, se avisa la recuperación.

**RT-17. Cambios de `notify` en caliente.** Aplican a los resultados siguientes. Activar un tipo: parte de contadores a cero; un problema ya existente se avisará tras N resultados (aunque se avisara antes de desactivarlo). Desactivar un tipo con avisos activos: ver RT-13, sin recuperaciones falsas. Los avisos ya en ventana de agrupación o en cola se envían igualmente (comportamiento de RA-34 y RA-45).

**RT-18. Cambio de umbrales en Ajustes.** No genera mensajes por sí mismo. Se aplica el RT-14 sobre el resultado siguiente: si un umbral más alto hace que el motivo desaparezca, se avisa la recuperación; si el nivel baja, la clave baja en silencio.

**RT-19. Histéresis en disco.** Una clave `disk` solo se recupera cuando el uso de esa partición es inferior a `diskWarnPct − DISK_HYST_PCT` (constante `DISK_HYST_PCT = 2` puntos); entre ese valor y el umbral de advertencia se mantiene sin avisar. No hay histéresis en los demás tipos (la banda warn–crit de `latency`/`resources` ya la proporciona RT-04).

**RT-20. Reglas específicas.**
- `certExpired`: activo con `ssl` vencido; se recupera con «CERTIFICADO RENOVADO» en cuanto `r.ssl` es medible y ya no hay motivo `ssl` vencido, aunque el certificado renovado quede dentro de `sslWarnDays`. A partir de ahí `certExpiring` sigue su ciclo normal (aviso tras N, una sola vez por episodio, escalado warn→crit).
- `certExpiring`: sin repetición por comprobación; recuperación «CERTIFICADO RENOVADO» cuando el certificado deja de estar dentro de `sslWarnDays`.
- `certTrust`: activo con `ssl-trust`; recuperación «CERTIFICADO CONFIABLE».
- `disk`: una clave por partición; dos particiones simultáneas generan dos avisos independientes.
- `other`: una clave por `code` (p. ej. `agent`, `ssl`, o un `warn` de `cpu`).
- Los contadores viven en memoria y parten de 0 al arrancar (RA-44).

### 4.4 «Chat coherente» tras reiniciar

**RT-21.** Dado un reinicio, para cada clave persistida: si la condición sigue activa, no se repite el aviso (el contador no se reinicia); si desapareció, se avisa la recuperación (si `recovery` y el tipo están activos). Dada una condición activa sin clave (nunca avisada, o aviso perdido en la cola), se avisa tras N resultados. Las claves de tipos desactivados se eliminan en silencio al cargar.
- Aceptación: escenario 9 de RA-98 repetido por tipo (`down`, `certExpiring` warn y crit, `disk` en dos particiones, `latency`).

### 4.5 Migración desde 2.4.0 (compatibilidad)

**RT-22. Migración de `notify`.** Al cargar `alerts.json` sin campo `notify`:
- `notify.recovery = notifyRecovery` (por defecto `true`).
- `notify.down = true`, `notify.certExpired = true`.
- Si `notifyDegraded === true`: `certExpiring`, `certTrust`, `latency`, `resources`, `disk` y `other` pasan a `true`; si no, a `false`.
- Se escribe el archivo con `version: 2`, `notify` completo y sin `notifyRecovery`/`notifyDegraded`. No hace falta ningún paso manual ni archivo nuevo.
- Aceptación: tabla de las 4 combinaciones de `notifyRecovery`/`notifyDegraded`, más archivo sin ninguno de los dos (valores por defecto de la sección 3) y archivo de `version: 1` con `notify` ya presente (se respeta).

**RT-23. Migración de `alerted` antiguo.** Valores de 2.4.0 (`{ idObjetivo: 'down' | 'degraded' }`):
- `'down'` → clave `<id>|down` con nivel `'m'` (migrado; válido solo en el tipo `down`, nunca se crea fuera de la migración). En el primer resultado no `unknown`: si el único motivo `down` es el certificado vencido y `certExpired` está activo, pasa en silencio a `certExpired` (`on`); si sigue caído por otros motivos, pasa a `on` sin avisar; si ya no está caído, recuperación normal.
- `'degraded'` → clave especial `<id>|legacy` con nivel `on` («degradación avisada por 2.4.0, causa desconocida»).
- Regla de adopción de `legacy`: en el primer resultado tras cargar, (a) si el objetivo está `up` y `recovery` activo, se avisa «RECUPERADO» (como en 2.4.0) y se borra la clave; (b) si sigue degradado, las condiciones actuales de tipos activos se **registran como avisadas sin enviar nada** (adopción silenciosa) y `legacy` se elimina; (c) si pasa a `down`, `legacy` se elimina en silencio y se aplica el ciclo normal de `down`.
- Transferencia silenciosa de caída a certificado (solo para la clave `down` migrada, nivel `'m'`): si existe `<id>|down` y el resultado ya no tiene motivos `down` salvo `ssl` vencido y `certExpired` está activo, la clave pasa a `<id>|certExpired` sin enviar nada (evita «RECUPERADO» + «VENCIDO» espurios tras actualizar).
- Aceptación: tras migrar y sin cambios en el entorno, el simulador recibe 0 mensajes en un ciclo (equivalente a «recibe lo mismo»); la recuperación pendiente de 2.4.0 sí se avisa.

**RT-24. Equivalencia con 2.4.0.** Con la configuración migrada y los mismos resultados, se envían los mismos avisos que 2.4.0 salvo estas diferencias documentadas: (a) el certificado vencido se avisa como «CERTIFICADO VENCIDO», no «CAÍDO» (RT-02); (b) con `notifyDegraded` falso, los motivos de nivel warn de `latency`/`resources` y similares siguen sin avisar; (c) el aviso `other`/`disk`/etc. lleva solo los motivos de su tipo, no todos los motivos warn/crit unidos; (d) `down` se recupera al dejar de estar caído (RT-14).
- Aceptación: pruebas de comparación con secuencias grabadas de `decide` de 2.4.0 (sin las diferencias a–d).

### 4.6 Mensajes

**RT-30. Formato.** Se mantiene la línea principal `<icono> [<org>] <nombre>: <ETIQUETA>` (RA-32/RA-33, mismas reglas de limpieza y recorte). Iconos y etiquetas:

| Evento | Icono | Etiqueta (mínimo) |
|---|---|---|
| `down` | 🔴 | `CAÍDO` |
| `certExpired` | 🔴 | `CERTIFICADO VENCIDO` |
| `certExpiring` warn | 🟠 | `CERTIFICADO POR VENCER` |
| `certExpiring` crit | 🔴 | `CERTIFICADO POR VENCER (URGENTE)` |
| `certTrust` | 🟠 | `CERTIFICADO NO CONFIABLE` |
| `latency` | 🟠 | por `code`: `LATENCIA ALTA`, `PÉRDIDA DE PAQUETES`, `JITTER ALTO`, `RESPUESTA LENTA` |
| `resources` | 🟠 | `CPU ALTA`, `MEMORIA ALTA`, `I/O LENTO` |
| `disk` warn | 🟠 | `ESPACIO EN DISCO BAJO` |
| `disk` crit | 🔴 | `ESPACIO EN DISCO CRÍTICO` |
| `other` | 🟠 | `DEGRADADO` (igual que en 2.4.0) |
| Recuperación `down`, `other`, `legacy` | 🟢 | `RECUPERADO` |
| Recuperación `certExpired`, `certExpiring` | 🟢 | `CERTIFICADO RENOVADO` |
| Recuperación `certTrust` | 🟢 | `CERTIFICADO CONFIABLE` |
| Recuperación `latency`/`resources` | 🟢 | `LATENCIA NORMAL`, `PÉRDIDA DE PAQUETES NORMAL`, `JITTER NORMAL`, `RESPUESTA NORMAL`, `CPU NORMAL`, `MEMORIA NORMAL`, `I/O NORMAL` |
| Recuperación `disk` | 🟢 | `ESPACIO EN DISCO NORMAL` |

- **Modo mínimo:** sin dirección, motivo, hora ni punto de montaje (privacidad, RT-60). Dos avisos del mismo tipo de un mismo objetivo con distinta partición pueden verse idénticos; se acepta.
- **Modo completo:** añade `Dirección:`, `Motivo:` y `Hora:` (RA-33). El motivo es el texto del evaluador de **ese** tipo (p. ej. `Disco /var al 91 %`, `Certificado vence en 5 días`); en recuperaciones, un texto fijo por tipo (`Servicio recuperado`, `Certificado renovado`, `Disco /var: espacio normal`, `Latencia normal`…). Para `down` se unen los motivos `down` (sin el de certificado vencido); para `other` solo el motivo de su `code`.
- Aceptación: una prueba de formato por fila de la tabla, en ambos modos, con nombre y montaje con caracteres especiales y de control.

**RT-31. Agrupación.** Los avisos de varios tipos y objetivos se agrupan por chat en la misma ventana (`groupWindowSec`) y forman un solo mensaje con encabezado `N avisos` (N = número de avisos, no de objetivos); un solo aviso se envía sin encabezado; orden por `ts` y, a igualdad, por prioridad de tipo (`down`, `certExpired`, `certExpiring`, `disk`, `resources`, `latency`, `certTrust`, `other`, recuperaciones). Se respetan `MAX_GROUP_LINES` y `TG_MAX_TEXT` (RA-34).
- Aceptación: un objetivo con puerto cerrado y disco crítico produce un mensaje de 2 líneas bajo `2 avisos`.

### 4.7 API y modelo de datos

**RT-40. Modelo.** `alerts.json` (0600) añade `notify` (objeto de 9 booleanos, sección 3, sin valores ausentes tras el saneado), `version: 2` y el nuevo formato de `alerted` (RT-10); se eliminan `notifyRecovery` y `notifyDegraded` del archivo. Carga tolerante: claves ausentes o no booleanas → valor por defecto de la sección 3 y reescritura saneada (RA-12).

**RT-41. `GET /api/alerts`.** Devuelve `notify` completo (9 claves booleanas) y, por compatibilidad de clientes, `notifyRecovery` (= `notify.recovery`) y `notifyDegraded` (verdadero solo si `certExpiring`, `certTrust`, `latency`, `resources`, `disk` y `other` son verdaderos). `version` vale 2.
- `GET /api/alerts/status` añade `activeByType`: objeto `{tipo: número}` con recuento de claves persistidas, sin ids, nombres ni particiones.

**RT-42. `PUT /api/alerts`.**
- Acepta `notify` parcial: `{ "notify": { "disk": true } }` modifica solo esa clave.
- 400 con `errors` (mismo formato que RA-12, todo o nada) si `notify` no es objeto, si trae una clave desconocida (mensaje con la clave y la lista válida) o si algún valor no es booleano. Mensajes en español.
- Compatibilidad: `notifyRecovery` (booleano) se traduce a `notify.recovery`; `notifyDegraded` (booleano) a los seis tipos de degradación (sección 3, RT-22). Si el cuerpo trae `notify` y alguno de los dos campos antiguos, mandan los de `notify` y los antiguos se ignoran. Validaciones de tipo de los campos antiguos, como hoy.
- Activar con todos los tipos en `false` es válido, no es error; la interfaz lo advierte (RT-50).
- Aceptación: pruebas de API para cada caso, incluidos 400 por valor `"true"` (cadena), clave `dwon` y cuerpo con ambos formatos.

**RT-43. Permisos.** Sin cambios: administrador, resto de reglas de RA-50. Los operadores/lectores no reciben `notify` por ninguna ruta (RA-05).

### 4.8 Interfaz

**RT-50. Panel «Qué avisar».** En Ajustes → Alertas, un `fieldset` con `legend` «Qué avisar» y 9 casillas en el orden de la sección 3, con el estado de `notify`. Sustituye a las casillas «Avisar de recuperaciones» y «Avisar también de DEGRADADO». Guardar envía `notify` completo. Si ninguna casilla está marcada se muestra un aviso no bloqueante («Ningún tipo seleccionado: no se enviará ningún aviso»). Con CENTINELA_ALERTS_DISABLED las casillas aparecen deshabilitadas como el interruptor.

**RT-51. Accesibilidad (como RA-64/RA-72).** Cada casilla tiene `label` asociado; cada una tiene un botón «?» alcanzable por teclado con `aria-label` («Ayuda: …»), `aria-expanded` y `aria-controls` que apunta al texto de ayuda de hasta dos frases; foco visible y contraste según `checklist-diseno-accesibilidad`; el `fieldset` es operable solo con teclado; el aviso de «ninguno seleccionado» está en una región `role="status"`. Todo texto se inserta con `U.esc`.
- Aceptación: prueba de interfaz que cuenta 9 casillas, 9 botones de ayuda con `aria-controls` válido y la ausencia de las casillas antiguas.

**RT-52. Textos de ayuda (máximo dos frases cada uno, en español).** Deben mencionar: Caída (ping, puerto, HTTP, DNS, palabra clave, servicio detenido, timeout); Recuperación (cada tipo avisa su propia recuperación); Certificado vencido; Certificado por vencer (un aviso al llegar a los días de advertencia y otro a los críticos, de Ajustes); Certificado no confiable; Alta latencia o pérdida (solo nivel crítico, tras N fallos); Recursos (CPU, memoria, I/O wait en crítico, tras N fallos); Disco (un aviso por partición al pasar el umbral de advertencia y otro al pasar el crítico); Otras degradaciones (resto de advertencias, incluidos los avisos de nivel advertencia de latencia/recursos). La ayuda «Avisar tras N fallos» indica a qué tipos aplica.
- Aceptación: prueba que verifica la presencia de cada ayuda y su longitud.

**RT-53. Modo demo.** Sin cambios (RA-66).

### 4.9 Seguridad

**RT-60. Sin filtraciones nuevas.** El punto de montaje, el nombre de servicio y el texto de motivos solo salen en el modo completo; el modo mínimo no los incluye (verificable buscando esas cadenas en el texto enviado). `alerted` y `activeByType` no salen por API con ids ni particiones; `GET /api/alerts` no devuelve `alerted`. El log no contiene nombres de partición ni de objetivo en las líneas nuevas (solo contadores y tipos).

**RT-61. Entradas hostiles.** Montajes o nombres con `|`, `<`, `\n`, `%00` o 10 000 caracteres no rompen claves ni mensajes (codificación y recorte de RT-11, limpieza de RA-33).

### 4.10 Documentación y versionado

**RT-70.** Se actualizan: ayuda integrada (`js/views/alerts.js`), `docs/manual/manual.md` y `guia-uso.md` (capítulo «Qué avisar», con captura, tabla de tipos, qué pasa con certificado vencido vs. caída, recuperaciones, migración) y los PDF (regla del proyecto); README (sin variables nuevas: indicar que no hay cambios de entorno); `docs/requisitos/alertas.md` queda con una nota «sustituido parcialmente por alertas-tipos.md» (RA-12, RA-40 a RA-44, RA-61); `arquitectura-alertas.md` (sección de decisión y estado por tipo); `docs/BITACORA.md`; CHANGELOG 2.5.0 y la versión única existente. Subir versión, etiquetar y publicar requieren aprobación (CLAUDE.md).

## 5. Casos límite

- Objetivo con N=1 y 9 tipos en conflicto: cada tipo avisa una vez por episodio.
- `down` y `latency` simultáneos: imposible por construcción (si el ping falla del todo no hay latencia, RT-15); si el fallo es de HTTP, `ttfb` no se evalúa.
- Resultado `unknown`: no cuenta, no recupera.
- Certificado que pasa de `warn` a `crit` en una sola comprobación (saltó de 31 a 6 días): un solo aviso `crit` (el nivel `warn` no se avisa si nunca se vio).
- Certificado renovado y vuelve a caducar: nuevo episodio, nuevos avisos.
- Partición que cambia de `warn` a `crit` y vuelve a `warn` (≥ 83 %): un aviso `crit`, la clave baja a `warn` en silencio y no hay recuperación hasta bajar de `diskWarnPct − 2`.
- Dos agentes distintos con la misma ruta `/`: claves separadas por objetivo.
- Reinicio con 2.4.0 → 2.5.0 con objetivos en `down`, en `degraded` y recuperados (RT-23).
- Vuelta a 2.4.0: su `sanitize` descarta las claves nuevas (formato `id|tipo`) y pierde el estado avisado; se documenta en las notas de la versión.
- Cambio de chat general: se olvidan todas las claves (RA-44 / `reload`).
- Cola llena o aviso descartado: la clave se registra igualmente (aceptado en RA-44).
- Disco lleno de `data/`: ver caso de RA sección 6 (la configuración sigue en memoria).

## 6. Criterios para las pruebas (derivados)

1. Funciones puras con reloj falso, sin red: `classify`, decisión por clave/nivel, migración, formato.
2. Matriz `tipo × (activación, no repetición, escalado, recuperación, desactivado en caliente, reinicio)` para los 9 tipos.
3. Escenarios de integración con simulador: antiguo `alerts.json` 2.4.0 (con `notifyDegraded` verdadero y falso) → 0 mensajes extra tras arrancar; cambio de `notify` por API; seguridad de RT-60.
4. Las pruebas existentes de RA-12/RA-42/RA-43/RA-44 se reescriben con el contrato nuevo; el resto de la suite pasa sin cambios.

## 7. Trazabilidad con las decisiones del usuario

| Decisión | Requisitos |
|---|---|
| 1. Panel y 9 tipos con valores por defecto | Sección 3, RT-01 a RT-05, RT-14 a RT-20, RT-30, RT-50 a RT-52 |
| 2. Selección global | RT-40 a RT-42 (un solo `notify`), sección 1.2 |
| 3. Compatibilidad con 2.4.0 | RT-22 a RT-24, RT-41, RT-42 |
| 4. Antirruido (N, agrupación, chat coherente por tipo) | RT-14, RT-21, RT-31 |

## 8. Riesgos y dependencias

- El campo `sub` en `evaluate.js` toca un módulo compartido con el navegador (RT-05); la alternativa de deducirlo del texto del motivo es frágil.
- Reescribir las pruebas existentes de `decide` y `alerted` es inevitable (RT-70 y sección 6).
- Volver a 2.4.0 pierde el estado avisado (sección 5).
- La suma de claves por partición puede crecer: límites en RT-11.

## 9. Decisiones del usuario sobre las preguntas (2026-11-19)

El usuario aceptó las cinco recomendaciones:
- P1: el certificado vencido se avisa como «CERTIFICADO VENCIDO», no «CAÍDO».
- P2: `down` se recupera al dejar de estar caído, no al llegar a `up`.
- P3: histéresis de 2 puntos en disco (`DISK_HYST_PCT = 2`).
- P4: los avisos de nivel advertencia de latencia y recursos van al tipo «Otras degradaciones».
- P5: N fallos seguidos para todos los tipos, incluidos certificado por vencer y disco.
