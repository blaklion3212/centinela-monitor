# Plan de trabajo: alertas opcionales (Telegram)

**Estado:** propuesto y pendiente de aprobación. No hay código.
**Fecha:** 2026-11-19
**Versión objetivo:** 2.3.0 (MINOR: funcionalidad nueva y compatible).
**Base técnica:** [propuesta-alertas-telegram.md](propuesta-alertas-telegram.md) (factibilidad, riesgos y límites).

## 1. Objetivo

Que Centinela avise por Telegram cuando un servicio cae, se degrada o se recupera. Dos condiciones del usuario:

1. **Es opcional.** Viene **desactivada** y un administrador decide si la activa. Desactivada, Centinela funciona exactamente igual que hoy: no hace ninguna conexión a Internet ni muestra avisos de configuración pendiente.
2. **Incluye ayuda** para configurarla y ponerla en marcha, dentro del panel y en los manuales.

## 2. Comportamiento esperado

### 2.1 Activación

- **Ajustes → Alertas**, sección nueva visible solo para administradores.
- Interruptor general **«Enviar alertas por Telegram»**, apagado por defecto.
- Al apagarlo se vacía la cola de envíos pendientes y no se envía nada más.
- Los lectores y operadores no ven la sección, ni el token ni los chats.
- Opcionalmente, una variable `CENTINELA_ALERTS_DISABLED=1` bloquea la función aunque esté activada en el panel. Sirve para redes sin salida a Internet o por política.

### 2.2 Configuración en el panel

| Campo | Detalle |
|---|---|
| Token del bot | Solo escritura: se guarda pero nunca se devuelve. Se muestra «configurado (…últimos 4 caracteres)» y un botón para reemplazarlo o borrarlo. Si existe `CENTINELA_TELEGRAM_TOKEN`, manda la variable y el campo aparece bloqueado con esa explicación. |
| Chat de destino | Chat general (`chat_id`). Opcional: un chat por organización; sin él, la organización usa el general. |
| Qué avisar | Caídas (DOWN) y recuperaciones (siempre que esté activo); DEGRADADO opcional. |
| Antirruido | Avisar tras N verificaciones fallidas seguidas (por defecto 2) y agrupar avisos simultáneos en un solo mensaje (ventana de 30 s). |
| Detalle del mensaje | «Completo» (nombre, dirección y motivo) o «Mínimo» (nombre y estado). Por defecto, mínimo, porque los datos salen de la red local. |
| Horario silencioso | Opcional. Variante completa, ver 2.4. |

**Botones**
- **«Buscar mis chats».** Después de escribirle al bot, lista los chats que lo han contactado (`getUpdates`) para elegir uno sin tener que averiguar el `chat_id` a mano.
- **«Enviar mensaje de prueba».** Muestra un resultado claro: enviado, token inválido, chat no encontrado, sin salida a Internet, etc.
- **Indicador de estado.** Último envío correcto, último error y mensajes en cola.

### 2.3 Ayuda integrada (requisito del usuario)

1. **Panel «Cómo configurarlo»** en la sección Alertas, plegable y abierto la primera vez. Son los pasos numerados:
   1. Abrir @BotFather en Telegram, enviar `/newbot` y copiar el token.
   2. Pegar el token en Centinela.
   3. Escribirle cualquier mensaje al bot o añadirlo al grupo.
   4. Pulsar «Buscar mis chats» y elegir el destino.
   5. Pulsar «Enviar mensaje de prueba».
   6. Activar el interruptor y guardar.

   Además, un aviso de privacidad (qué datos salen de la red) y el requisito de salida HTTPS a `api.telegram.org`.
2. **Mensajes de error con solución.** Cada fallo se explica con la acción a tomar. Por ejemplo, «Telegram rechazó el token (401): revisa que lo copiaste completo» o «No hay conexión con api.telegram.org: el servidor necesita salida a Internet por el puerto 443».
3. **Iconos «?»** junto a cada campo, con una explicación corta.
4. **Documentación:**
   - Nuevo capítulo «Alertas por Telegram» en el manual (`docs/manual/manual.md`) y en la guía de uso (`docs/manual/guia-uso.md`), con capturas. Se regeneran ambos PDF.
   - Sección en `docs/despliegue-seguro.md`: token en `.env`, salida a Internet, contenedor y proxy.
   - Variables nuevas documentadas en el README y en `compose.yml` (vacías por defecto).
   - Tabla de «Problemas frecuentes» con síntoma, causa y solución.

### 2.4 Variantes

- **Básica (recomendada para empezar):** todo lo anterior con un único chat general y sin horario silencioso.
- **Completa:** añade un chat por organización, el horario silencioso y la opción de avisar de DEGRADADO. Es aproximadamente un 50 % más de trabajo.

## 3. Arquitectura propuesta

- **`server/lib/notify.js`:** núcleo genérico de notificaciones.
  - Se suscribe a `scheduler.on('event')`.
  - Aplica el antirruido (fallos seguidos, agrupación, nada al reiniciar).
  - Mantiene la cola con reintentos y respeta `retry_after` en las respuestas 429.
  - Los envíos son asíncronos, con un plazo de 10 s, y nunca bloquean el planificador.
- **`server/lib/channels/telegram.js`:** canal Telegram con `https` nativo, sin dependencias. Tiene `send`, `test` y `findChats`. Diseñarlo como canal permite añadir después correo o un webhook sin rehacer el núcleo.
- **Configuración:** en el almacén de ajustes, con escritura atómica y permisos 0600 como el resto de `data/`. El token nunca aparece en respuestas de la API, logs, eventos ni exportaciones.
- **API, solo administradores:**
  - `GET` y `PUT /api/alerts` para la configuración, sin el token.
  - `POST /api/alerts/test`.
  - `POST /api/alerts/chats`.
  - `GET /api/alerts/status`.

  Todas pasan por el router declarativo (405, 401, 403, Origin) y llevan límites de frecuencia, como `/check`.
- **Desactivada:** el módulo no se suscribe al evento y no abre conexiones.

## 4. Fases

`[Fase] -> [Responsable] -> [Subagentes] -> [Esfuerzo] -> [Entregable]`

0. Decisiones -> Usuario -> — -> bajo -> respuestas a la sección 5
1. Requisitos -> Orquestador -> analista-requisitos -> medio -> `docs/requisitos/alertas.md` con criterios de aceptación
2. Arquitectura e interfaces -> Orquestador -> — -> medio -> contratos de `notify.js`, del canal y de la API
3. Backend -> Orquestador -> implementador ×2 en paralelo (núcleo con antirruido y cola / canal Telegram con API) -> alto -> código del servidor
4. Interfaz y ayuda -> Orquestador -> desarrollador-frontend, revisor-diseno -> medio -> sección Ajustes → Alertas con ayuda integrada
5. Pruebas -> Orquestador -> probador -> alto -> pruebas con un Telegram simulado local (sin Internet): desactivada = cero conexiones, antirruido, 429, caídas, token oculto, permisos
6. Revisión -> Orquestador -> revisor-qa + auditor-seguridad en paralelo -> medio -> hallazgos corregidos
7. Documentación -> Orquestador -> documentador, formateador -> medio -> capítulos del manual y de la guía, capturas, PDF regenerados, README y despliegue seguro
8. Prueba real -> Usuario -> — -> bajo -> el usuario crea su bot y lo prueba en un contenedor temporal
9. Release -> Orquestador -> — -> bajo -> 2.3.0 con CHANGELOG, etiqueta y push, con aprobación

## 5. Decisiones del usuario (fase 0)

Respondidas el 2026-11-19:

1. **Salida a Internet:** directa, sin proxy. No hace falta `CENTINELA_HTTPS_PROXY`.
2. **Variante:** pendiente de confirmar. Recomendación: empezar con **un solo chat** y dejar el diseño preparado para tener uno por organización (ver 5.1).
3. **Token:** se puede escribir en el panel o poner en la variable de entorno; si están los dos, manda la variable.
4. **Detalle por defecto:** «mínimo», con nombre del servicio, estado y **la organización (cliente) si la tiene**. Ejemplo: `🔴 [Cliente ACME] Portal intranet: CAÍDO`. Si el objetivo no pertenece a ninguna organización, la etiqueta se omite.

### 5.1 Empezar con un chat y dividir después

- **Costo hoy:** casi nulo. La configuración guarda un chat general y un mapa de chats por organización, que empieza vacío. El envío pasa por una única función `chatFor(orgId)`, que hoy siempre devuelve el chat general.
- **Costo de dividir después:** bajo. Basta un campo «Chat de Telegram» en cada organización y que `chatFor` lo use cuando exista. No hay migración de datos: las organizaciones sin chat propio siguen usando el general. Se publicaría como una versión MINOR (2.4.0).
- **Lo que no conviene:** diseñarlo «solo para un chat» sin ese punto único, porque dividir después obligaría a tocar el antirruido, la agrupación y el formato.
- **Mientras haya un solo chat:** la etiqueta del cliente en cada mensaje permite distinguir los avisos de cada organización.

## 6. Criterios de aceptación (resumen)

- Con la función desactivada (estado por defecto), el servidor no hace ninguna conexión a `api.telegram.org`, comprobado con pruebas. Además, la interfaz de no administradores no cambia.
- Un administrador puede activarla siguiendo solo la ayuda del panel, sin consultar documentación externa.
- El mensaje de prueba informa con claridad del éxito y de cada tipo de error.
- Un servicio que alterna entre caído y activo no genera más de un aviso por ciclo según el antirruido configurado.
- Una caída de Telegram no retrasa ni detiene las verificaciones.
- El token no aparece en respuestas de la API, logs ni pruebas.
- Las pruebas existentes siguen pasando y la CI está en verde en Node 18–24.
- El manual y la guía tienen el capítulo nuevo y los PDF están regenerados.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| La red no tiene salida a Internet | Función opcional y apagada; error claro en la prueba; alternativa futura por correo o webhook interno |
| Los datos salen de la LAN | Detalle «mínimo» por defecto y aviso de privacidad en la ayuda |
| Fuga del token | Solo escritura, `.env` o `data/` con 0600, nunca en logs ni en la API; auditoría de seguridad |
| Spam por inestabilidad | Antirruido y agrupación; límites de Telegram respetados |
| Los límites de Telegram cambian | Confirmarlos en la documentación oficial durante la fase 1 |
