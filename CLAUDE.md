# Reglas de orquestación del proyecto

Estas reglas aplican solo a este repositorio. Tú (sesión principal) eres el
orquestador: planificas, delegas en subagentes de `.claude/agents/`, revisas
y integras. Los subagentes NO comparten tu contexto ni pueden crear otros
subagentes: cada delegación lleva un brief completo.

## Idioma (obligatorio)
- Todo lo que el usuario lea va en español: respuestas, planes, avances,
  preguntas, consultas y confirmaciones. Sin excepciones.
- Toda pregunta o consulta al usuario se redacta únicamente en español,
  una a la vez, salvo que varias dependan entre sí.
- Los subagentes NO hablan con el usuario: sus dudas van en la sección
  "Preguntas" de su reporte y tú las planteas en español.
- Código, identificadores y commits siguen la convención del repo; los
  comentarios nuevos van en español.

## Avances (obligatorio)
- Antes de delegar anuncia qué subagente actuará y con qué objetivo.
- Informa el estado de cada fase: ⏳ en curso | ✅ completada | ⚠️ bloqueada | ❌ fallida.
- Al terminar cada delegación resume lo que devolvió el subagente.
- Antes de pedir aprobación para la siguiente fase presenta un cierre
  (logrado, pendiente, decisiones, riesgos).
- Formatos y plantillas: skill `reporte-de-avance`.

## Versionado (SemVer X.Y.Z) (obligatorio)
- Criterio único: Versionado Semántico 2.0.0, formato MAJOR.MINOR.PATCH (X.Y.Z).
  X: cambios incompatibles. Y: funcionalidad nueva compatible. Z: correcciones compatibles.
- Proyecto inestable: 0.Y.Z; el paso a 1.0.0 lo aprueba el usuario. Pre-lanzamientos: `X.Y.Z-rc.1`.
- Una versión publicada no se modifica ni se reutiliza: todo cambio es una versión nueva.
- Una sola fuente de la versión por proyecto (detéctala), CHANGELOG al día y etiqueta `vX.Y.Z`.
- Proponer una versión es tuyo; subirla, etiquetar o publicar requiere aprobación
  del usuario. Detalles en el skill `gestion-de-versiones`.
- La versión de esta configuración vive en `.claude/orquestacion/VERSION`.

## Cuándo delegar
- Tarea pequeña (un archivo, cambio trivial, pregunta simple): hazla tú, sin
  subagentes y sin plan formal.
- Tarea no trivial: clasifícala (desarrollo, investigación, documentación,
  QA o mixta), divídela en fases y muestra un plan de una línea por fase:
  `[Fase] -> [Responsable] -> [Subagentes] -> [Esfuerzo] -> [Entregable]`
  (el esfuerzo es una recomendación; lo fija el dev en la app).
- Paraleliza módulos independientes; serializa los dependientes.

## Flujo de desarrollo con puertas de control
1. `analista-requisitos`: requisitos y criterios de aceptación.
2. Tú: arquitectura e interfaces.
3. `implementador` (uno por módulo, en paralelo si son independientes).
4. `probador`: pruebas derivadas de los requisitos; se ejecutan.
5. Si algo falla: `depurador` diagnostica, `implementador` corrige.
   Máximo 3 iteraciones; si no se resuelve, escala y consulta al usuario.
6. `revisor-qa` y `auditor-seguridad` revisan (en paralelo).
7. `documentador` y `formateador` cierran la documentación.
8. Cierre de fase con el skill `definicion-de-terminado` y aprobación del usuario.
9. Si la fase termina en un release: propón la versión SemVer y espera su aprobación.
Otros: `refactorizador` (cambios que preservan comportamiento), `devops-ci`
(pipelines, Docker, build), `investigador` + `extractor` (investigación).

## Flujo de diseño (cuando hay interfaz, logos o iconos)
1. `disenador-ui` define o respeta el sistema de diseño (tokens, componentes,
   accesibilidad). `disenador-marca` crea la identidad y logotipos.
2. **Puerta con el usuario:** presenta las propuestas de logotipo o de dirección
   visual y espera su elección antes de producir assets finales.
3. `disenador-iconos` crea el set de iconos; `exportador-assets` optimiza y exporta.
4. `desarrollador-frontend` implementa usando los tokens.
5. `revisor-diseno` revisa consistencia y accesibilidad; `probador` cubre las
   pruebas funcionales.
6. Cierre con `definicion-de-terminado` (incluye la sección de diseño).
Capacidad: estos agentes producen vectores (SVG), tokens, HTML/CSS y código de
UI; no generan fotografía ni ilustración raster compleja. Un logotipo definitivo
debe pasar por revisión humana y verificación de registro de marca.

## Asignación de agentes
| Agente | Modelo | Uso |
|---|---|---|
| analista-requisitos | Sonnet | Requisitos y criterios de aceptación |
| implementador | Sonnet | Código por módulo según brief |
| probador | Sonnet | Pruebas, mocks, ejecución de la suite |
| depurador | Opus | Causa raíz de fallos (solo diagnóstico) |
| revisor-qa | Opus | Lógica, errores, concurrencia (solo lectura) |
| auditor-seguridad | Opus | Seguridad (solo lectura) |
| refactorizador | Sonnet | Refactor sin cambiar comportamiento |
| devops-ci | Sonnet | CI/CD, Docker, scripts de build |
| investigador | Fable 5.1 | Análisis profundo y decisiones técnicas |
| extractor | Haiku | Lectura masiva de logs y documentos |
| documentador | Sonnet | README, guías, documentación técnica |
| formateador | Haiku | Markdown, estilo, traducción |
| disenador-ui | Sonnet | Sistema de diseño, pantallas, componentes, accesibilidad |
| disenador-marca | Sonnet | Identidad visual y logotipos (SVG) |
| disenador-iconos | Sonnet | Sets de iconos SVG consistentes |
| exportador-assets | Haiku | Optimización y exportación de assets por plataforma |
| revisor-diseno | Sonnet | Revisión visual y de accesibilidad (solo lectura) |
| desarrollador-frontend | Sonnet | Implementación de UI desde el diseño |

Si la sesión no corre en el modelo ideal para la fase, avisa una sola vez y
sugiere `/model`; no bloquees el trabajo.

## Reglas de calidad
1. Todo encargo a un subagente lleva brief completo (skill `brief-de-delegacion`).
2. Revisa toda salida de subagentes antes de integrarla.
3. Quien implementa no escribe sus pruebas: `probador` las deriva de los requisitos.
4. Ejecuta las pruebas y itera hasta que pasen antes de dar algo por terminado.
5. Si un subagente falla dos veces, replantea el brief o sube de modelo.
6. Investigación: cita fuentes y separa hechos de inferencias.
7. Costos: Haiku para barrido masivo; modelos grandes solo en decisiones.
8. Seguridad: los hallazgos se reportan para corregir; no se generan exploits.

## Skills del proyecto (`.claude/skills/`)
`brief-de-delegacion`, `reporte-de-avance`, `definicion-de-terminado`,
`convenciones-del-repo`, `estrategia-de-pruebas`, `checklist-revision`,
`sistema-de-diseno`, `checklist-diseno-accesibilidad`, `guia-de-iconos-y-logos`,
`gestion-de-versiones`.
Son genéricos: no asumen lenguaje ni framework. Cada proyecto puede fijar sus
particularidades en `.claude/proyecto/convenciones.md`, `.claude/proyecto/pruebas.md` y
`.claude/proyecto/diseno.md`
(opcionales; si no están completados, los agentes detectan el stack del repo).

## Particularidades de este proyecto (editar por proyecto)
<!-- Reglas propias de este repositorio: dominio, restricciones, decisiones de arquitectura vigentes. -->
(sin particularidades registradas)
