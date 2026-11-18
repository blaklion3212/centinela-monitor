# Registro de cambios de la configuración de orquestación

Sigue Versionado Semántico (X.Y.Z) y el formato "Keep a Changelog".
Esta es la versión de la configuración de orquestación, distinta de la versión
del producto de cada proyecto. Las versiones anteriores a la 1.5.0 se numeraron
de forma retroactiva.

## [1.5.0] - 2026-11-13
### Agregado
- Criterio de versionado SemVer (X.Y.Z) en `CLAUDE.md` y skill `gestion-de-versiones`.
- Archivos `VERSION` y `CHANGELOG.md` de la propia configuración.
- Checklist de release en `definicion-de-terminado`.

## [1.4.0]
### Agregado
- Módulo de diseño: agentes `disenador-ui`, `disenador-marca`, `disenador-iconos`,
  `exportador-assets`, `revisor-diseno` y `desarrollador-frontend`.
- Skills `sistema-de-diseno`, `checklist-diseno-accesibilidad` y `guia-de-iconos-y-logos`.
- Archivo opcional `.claude/proyecto/diseno.md` y flujo de diseño con puerta de aprobación.

## [1.3.0]
### Cambiado
- Skills `convenciones-del-repo` y `estrategia-de-pruebas` genéricos: detectan el stack del repo.
### Agregado
- Archivos opcionales `.claude/proyecto/convenciones.md` y `pruebas.md`.
- Sección "Particularidades de este proyecto" en `CLAUDE.md`.

## [1.2.0]
### Agregado
- Agentes `analista-requisitos`, `depurador`, `auditor-seguridad`, `refactorizador` y `devops-ci`.
- Seis skills iniciales y flujo de desarrollo con puertas de control.
### Cambiado
- `CLAUDE.md` reducido; los procedimientos largos pasaron a skills.
### Corregido
- Descripciones de agentes entre comillas para evitar errores de YAML.

## [1.1.0]
### Agregado
- Regla de idioma (todo en español) y reglas de avances y progreso.
- Formato de reporte común para los subagentes.

## [1.0.0]
### Agregado
- `CLAUDE.md` inicial y 7 subagentes: implementador, probador, revisor-qa,
  investigador, extractor, documentador y formateador.
