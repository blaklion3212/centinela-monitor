# Propuesta: alertas por Telegram

**Estado:** en espera. Solo análisis, sin implementar. Plan de trabajo en [plan-alertas.md](plan-alertas.md).
**Fecha:** 2026-11-18
**Versión estimada:** 2.3.0 (MINOR: funcionalidad nueva y compatible).

## Resumen

Es factible. El servidor ya detecta cada cambio de estado de un objetivo (UP, DEGRADADO, DOWN) y genera un evento. Un módulo nuevo escucharía ese evento y enviaría un mensaje a Telegram. No hay que tocar las sondas ni el planificador. Tampoco se necesitan dependencias: basta el `https` de Node.

## Cómo funciona Telegram

- El bot se crea con **@BotFather**, que entrega un **token**.
- El destino es un **chat_id**: un chat personal, un grupo o un canal donde esté el bot.
- Cada aviso es una petición HTTPS `POST https://api.telegram.org/bot<TOKEN>/sendMessage` con `chat_id` y `text`.
- Para solo enviar no hace falta recibir conexiones desde Internet: no se abre ningún puerto.

## Punto de integración en el código

- `server/lib/scheduler.js` es un `EventEmitter`. Cuando cambia el estado de un objetivo, crea el evento y lo emite con `self.emit('event', ev)`.
- El evento contiene `targetId`, `name`, `org`, `orgName`, `from`, `to`, `text` y `ts`.
- `server/server.js` ya se suscribe a ese evento para enviarlo al panel (`scheduler.on('event', …)`).
- El módulo propuesto (`server/lib/notify.js`) se suscribiría de la misma forma.

## Implicaciones

### 1. Salida a Internet

Es el punto clave, porque el despliegue es solo en la red local.

- El servidor, o el contenedor, necesita salida HTTPS hacia `api.telegram.org:443`.
- Si la red no tiene salida a Internet, no funciona.
- Si la salida pasa por un proxy, habría que añadir soporte de proxy.

### 2. Privacidad

- Los avisos salen de la red local y pasan por los servidores de Telegram: nombre del servicio, dirección o IP y motivo de la falla.
- Los chats con bots no tienen cifrado de extremo a extremo.
- Opción posible: un modo con poco detalle, por ejemplo «Portal intranet: DOWN», sin IP ni motivo.

### 3. El token es un secreto

- Quien tenga el token puede enviar mensajes como el bot.
- Iría en una variable de entorno (p. ej. `CENTINELA_TELEGRAM_TOKEN`) dentro de `.env`, como la contraseña inicial del administrador.
- Nunca se guarda en el repositorio, no aparece en las respuestas de la API y no se escribe en los logs.

### 4. Evitar el ruido (antirruido)

Sin control, un servicio inestable llenaría el chat. Se necesita:

- Avisar solo después de N verificaciones fallidas seguidas o de X minutos caído.
- Avisar también de la recuperación.
- Agrupar en un solo mensaje los avisos de muchos objetivos que caen a la vez (por ejemplo, una caída de red).
- No reenviar alertas al reiniciar el servidor.
- Opcional: decidir si se avisa del estado DEGRADADO y definir un horario silencioso.

### 5. Límites de Telegram

Según la documentación de Telegram, los límites son de unos 30 mensajes por segundo en total, 1 por segundo por chat y unos 20 por minuto en grupos. **Hay que confirmarlos antes de implementar**, porque se citan de memoria.

- Hace falta una cola con reintentos que respete el `retry_after` de las respuestas 429.
- Si Telegram falla o tarda, la monitorización no se puede frenar: los envíos deben tener plazo máximo y ser asíncronos.

### 6. Organizaciones

Cada organización podría tener su propio chat o grupo. Esto encaja con el uso multicliente.

### 7. Interfaz

Una sección en **Ajustes**, visible solo para administradores, con:

- activar o desactivar;
- los chats de destino;
- los eventos que se notifican;
- un botón «Enviar mensaje de prueba».

### 8. Comandos desde Telegram

Comandos como `/estado` son posibles, pero se dejan para una fase posterior. Requieren recibir mensajes del bot (sondeo con `getUpdates`) y decidir quién puede consultar.

## Alcance propuesto

| Variante | Incluye | Esfuerzo relativo |
|---|---|---|
| **Básica** | Token y chat por variables de entorno; avisos de caída y recuperación con antirruido; cola con reintentos; botón de prueba; pruebas con un servidor de Telegram simulado; documentación y manuales | 1× |
| **Completa** | Lo anterior, más configuración desde el panel, un chat por organización, agrupación de avisos y horario silencioso | ~2× |

## Recomendación

Diseñarlo como un **canal de notificaciones genérico**, con Telegram como primer canal. Así, añadir después correo (SMTP) o un webhook (Teams, Slack…) reutilizaría la cola, el antirruido y la configuración. El correo o el webhook también sirven de alternativa si la red no tiene salida a Internet.

## Decisiones pendientes del usuario antes de implementar

1. ¿El servidor tiene salida directa a Internet o sale por proxy?
2. ¿Variante básica o completa?
3. ¿Qué nivel de detalle pueden llevar los mensajes (con o sin IP y motivo)?
