# Arquitectura: tipos de alerta seleccionables (2.5.0)

**Requisitos:** [alertas-tipos.md](alertas-tipos.md) (RT-01 a RT-70, con las decisiones P1 a P5 aceptadas).
**Base:** [arquitectura-alertas.md](arquitectura-alertas.md). Cola, ritmo, reintentos, token, chat, migración de supergrupo y agrupación por chat no cambian.

## 1. Módulos

| Módulo | Cambio | Responsable |
|---|---|---|
| `server/lib/alert-types.js` (nuevo, puro, sin E/S) | Clasificación, condiciones por objetivo, medibilidad, decisión por clave, claves, etiquetas | implementador (servidor) |
| `js/core/evaluate.js` | Campo opcional `sub` en los motivos `ssl` y `disk` (RT-05) | implementador (servidor) |
| `server/lib/alerts-config.js` | `notify`, `version: 2`, migración, nuevo formato de `alerted`, validación, vista pública | implementador (servidor) |
| `server/lib/notify.js` | `onResult` usa `alert-types.decideTarget`, formato por evento, `prune`/`reload` por prefijo, `activeByType` | implementador (servidor) |
| `server/server.js` | `notifier` recibe `thresholds: function () { return store.getSettings().thresholds; }`; log de `notify` en `hAlertsPut` | implementador (servidor) |
| `js/views/alerts.js` | Panel «Qué avisar» (RT-50 a RT-52), sin las dos casillas antiguas | implementador (interfaz) |

## 2. Contrato de `alert-types.js` (UMD no hace falta: solo servidor, CommonJS)

```js
TYPES          // ['down','certExpired','certExpiring','certTrust','latency','resources','disk','other']
NOTIFY_KEYS    // TYPES más 'recovery', en el orden de la sección 3 de los requisitos:
               // ['down','recovery','certExpired','certExpiring','certTrust','latency','resources','disk','other']
DEFAULT_NOTIFY // { down:true, recovery:true, certExpired:true, resto:false }
DEGRADE_TYPES  // ['certExpiring','certTrust','latency','resources','disk','other']
DISK_HYST_PCT  // 2

classify(reason)          // -> { type, sub, level:'on'|'warn'|'crit', family } | null   (RT-01, RT-02)
                          //    family: 'down' | code | 'disk|<mount>'  (la familia de RT-04)
encodeKey(id, type, sub)  // -> 'id|type' o 'id|type|<encodeURIComponent(sub recortado a 100, sin controles)>'
parseKey(key)             // -> { id, type, sub } | null
measurable(family, r)     // RT-15
sourceOf(family)          // 'status' | 'ping' | 'http' | 'ssl' | 'agent'
sourcePresent(src, r)     // RT-13 «fuente ausente»

// Decisión pura para UN resultado de UN objetivo (RT-03, RT-04, RT-14 a RT-21, RT-23).
decideTarget({
  id, r,                         // resultado del planificador (status, reasons, ping, http, ssl, agent)
  alerted,                       // { 'type|sub'(sin id): 'on'|'warn'|'crit' } solo de este objetivo (incluye 'legacy')
  counters,                      // { 'type|sub': { level, count, missing } } en memoria
  notify,                        // 9 booleanos
  n,                             // failsBeforeAlert
  thresholds                     // { diskWarnPct, ... } para la histéresis de RT-19
}) -> {
  alerted,                       // nuevo mapa de este objetivo
  counters,                      // nuevos contadores
  events: [{ kind:'alert'|'recovery', type, sub, level, code, reasons:[texto], ts }]
}
```

Reglas de implementación:
- `decideTarget` no muta sus entradas. Devuelve copias.
- `status === 'unknown'`: devuelve todo igual y sin eventos.
- Las condiciones del resultado se calculan con `classify` sobre `r.reasons`, ignorando `level:'info'`. Se agrupan por clave `type|sub` y se queda el nivel máximo (`crit` > `warn` > `on`).
- Un tipo con `notify[type] === false` no cuenta, no avisa y no recupera. Si hay claves suyas en `alerted`, se eliminan en silencio (RT-13, RT-17).
- Hay un evento `recovery` solo si `notify.recovery` y `notify[type]` están activos. Si no, la clave se elimina en silencio.
- La clave `legacy` se adopta en el primer resultado no `unknown`, según RT-23 (a), (b) y (c). La transferencia silenciosa de `down` a `certExpired` también es de RT-23, pero solo para claves `down` migradas de 2.4.0.
- Familias de certificado: `certExpired` tiene familia propia (solo «ssl vencido»); `certExpiring` y «no se pudo leer» usan la familia `ssl`. Si un certificado vencido se renueva con validez dentro de `sslWarnDays`, `certExpired` se recupera en cuanto `r.ssl` es medible y ya no hay motivo `ssl` vencido, y `certExpiring` sigue su ciclo normal (aviso tras N, una vez por episodio). El relevo silencioso de `certExpiring` por `certExpired` solo rige mientras el certificado sigue vencido.
- `decideTarget` recibe `checksOn` opcional (`{ping, http, ssl, agent}`, derivado de `target.checks`; `http` solo en objetivos url): la «fuente ausente» (RT-13) se decide por esa configuración, no por la presencia en el resultado. Sin `checksOn` se decide por presencia. Fallo de DNS, motivo `timeout` o ausencia de todas las fuentes vuelve «no medible» toda familia salvo `down`.
- Familias: `ssl-expired` (certExpired), `ssl` (certExpiring), `ssl-unreadable` (other|ssl). Las claves del disco se comparan con la clave local canónica (`localKey`).
- Escalado sin aviso previo: se avisa con el nivel actual; la clave `down` no se recupera mientras `status === 'down'`.
- Límites (RT-11): si las claves solo en memoria llenan su tope, el aviso nuevo se descarta (contado en `alertedLimitHits` y `droppedTotal`); al liberarse espacio las volátiles se promueven a persistidas.
- Arranque: `start()` elimina en silencio las claves de tipos desactivados (igual que `reload()`) y guarda de inmediato si cambió.
- Nivel `'m'` (migrado): `sanitize` convierte el `'down'` antiguo en `id|down` con nivel `'m'`, válido únicamente en el tipo `down` y nunca creado fuera de la migración. En el primer resultado no `unknown` de esa clave: si el único motivo `down` es el certificado vencido y `certExpired` está activo, la clave pasa en silencio a `certExpired` (nivel `on`); si sigue caído por otros motivos, pasa a `on` sin avisar; si ya no está caído, sigue la recuperación normal. Un `down` real que se recupera con el certificado aún vencido avisa «RECUPERADO» y, tras N, «CERTIFICADO VENCIDO». `activeByType` cuenta `'m'` como `down`.
- Salvaguarda: si `r.status === 'down'` y ningún motivo tiene `down:true` (ni siquiera el de certificado vencido), se considera una condición `down` con motivo «Sin respuesta» (familia `down`, medible). Si hay algún motivo `down:true`, no se aplica (RT-02 se mantiene).

## 3. `alerts-config.js`

- `VERSION = 2`. `DEFAULTS.notify = DEFAULT_NOTIFY`. Se quitan `notifyRecovery` y `notifyDegraded` de `DEFAULTS` y del archivo saneado.
- `sanitize(input)`:
  - Si falta `notify` o no es un objeto, se migra según RT-22.
  - Cada clave de `notify` que no sea booleana toma su valor por defecto.
  - `alerted`:
    - Admite claves nuevas válidas (RT-10). Son de la forma `id|tipo` o `id|tipo|sub`, con `tipo` en `TYPES` más `legacy`, y valor `on`, `warn` o `crit`.
    - Las claves antiguas `{id: 'down' | 'degraded'}` se migran: `'down'` pasa a `id|down: 'on'` y `'degraded'` pasa a `id|legacy: 'on'`.
    - Límites: `MAX_ALERTED` y `MAX_ALERTED_PER_TARGET = 64` (RT-11).
- `validateUpdate`: acepta `notify` parcial y los campos antiguos, con las reglas de RT-42.
- `publicView`: devuelve `notify` y, derivados, `notifyRecovery` y `notifyDegraded` (RT-41).
- Exporta `NOTIFY_KEYS` (reexportado de `alert-types`).

## 4. `notify.js`

- `cfg.alerted` sigue siendo un solo mapa plano con claves `id|tipo|sub`. Para cada resultado se extrae la vista del objetivo por prefijo `id|` y luego se vuelve a fusionar. Si la vista cambió, se llama a `saveAlerted()`.
- `fails` pasa a guardar `counters` por objetivo.
- **Eventos.** Cada evento se convierte en un `item` para `formatMessage`:
  - Campos: `{ event: 'down'|'certExpired'|...|'recovery', type, level, code, sub, name, label, address, reason, ts }`.
  - `formatMessage` sigue aceptando los `item` antiguos con `status` (`down`, `degraded` o `up`), para compatibilidad de las pruebas de formato.
  - Etiquetas e iconos según RT-30.
  - En modo mínimo nunca salen `sub` ni motivos (RT-60).
- **Orden dentro de un grupo:** por `ts` y, si empatan, por la prioridad de RT-31.
- **Limpieza de estado:**
  - `prune`: borra las claves con prefijo de los objetivos que ya no existen, y sus contadores.
  - `reload`: si cambia el chat general, se vacía `alerted` (como en 2.4.0). Al cambiar `notify`, se eliminan las claves de los tipos desactivados y se reinician sus contadores.
- **Estado:**
  - `status().activeByType`: recuento de claves por tipo, sin ids ni particiones.
  - Si se alcanza el límite de RT-11, se registra una sola línea de log por episodio y se suma a `stats.alertedLimitHits`.
- **Umbrales:** se reciben como `opts.thresholds`, una función que devuelve el objeto de umbrales. Si falta, se usan los de `js/config/defaults.js`.
- La función pura `decide` antigua se elimina; sus pruebas se reescriben con `decideTarget`.

## 5. Interfaz (`js/views/alerts.js`)

- Hay un `fieldset` con la leyenda «Qué avisar» y 9 casillas en el orden de `NOTIFY_KEYS`, con ids `<id>n-<clave>`.
- Cada casilla tiene su botón de ayuda «?» con `data-help-for="n-<clave>"` y los textos de RT-52.
- Si no hay ninguna casilla marcada, aparece un aviso no bloqueante en `[data-none-warning]` (`role="status"`).
- «Guardar» envía `notify` completo y deja de enviar `notifyRecovery` y `notifyDegraded`.
- Desaparecen las casillas antiguas `#<id>recovery` y `#<id>degraded`, y sus ayudas `recovery` y `degraded`.
- La ayuda de «Avisar tras N fallos seguidos» indica que aplica a todos los tipos.

## 6. Orden de trabajo

1. Implementador del servidor (alert-types, evaluate, config, notify, server) e implementador de la interfaz (alerts.js), en paralelo. La interfaz solo depende del contrato de la API: RT-41 y RT-42.
2. `probador` escribe las pruebas a partir de RT-xx y reescribe las de RA-12/RA-40 a RA-44/RA-61 afectadas.
3. `revisor-qa` y `auditor-seguridad`, luego `documentador`, prueba del usuario y versión 2.5.0.
