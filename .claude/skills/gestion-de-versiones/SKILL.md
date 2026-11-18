---
name: gestion-de-versiones
description: "Manejo de versiones con Versionado Semántico (SemVer X.Y.Z): cómo decidir el incremento, CHANGELOG, etiquetas y pre-lanzamientos. Usar al preparar un release, actualizar el CHANGELOG o decidir un número de versión."
---
# Gestión de versiones (SemVer X.Y.Z)

Criterio único del equipo: Versionado Semántico 2.0.0, formato MAJOR.MINOR.PATCH.

## Reglas de incremento
| Parte | Cuándo sube | Efecto |
|---|---|---|
| X (MAJOR) | Cambios incompatibles con lo anterior (se elimina o cambia algo de la interfaz pública) | Y y Z vuelven a 0 |
| Y (MINOR) | Funcionalidad nueva compatible, o funcionalidad marcada como obsoleta | Z vuelve a 0 |
| Z (PATCH) | Correcciones de errores compatibles, sin cambiar la interfaz pública | - |

- Los números son enteros no negativos, sin ceros a la izquierda.
- Una versión publicada no se modifica ni se reutiliza: todo cambio es una versión nueva.
- Proyecto aún inestable: usa 0.Y.Z. El paso a 1.0.0 (interfaz pública estable) lo aprueba el usuario.
- Pre-lanzamientos: `X.Y.Z-alpha.1`, `-beta.1`, `-rc.1`. Son anteriores a `X.Y.Z`.
- Metadatos de build (`+build.5`) no cuentan para la precedencia.

## Qué es la "interfaz pública"
Detéctala en el proyecto: API HTTP, funciones y clases exportadas, comandos de CLI,
formatos de archivo o de configuración, esquema de base de datos. Si no está
definida, repórtalo y propón una definición.

## Procedimiento para proponer una versión
1. **Detecta dónde vive la versión** (`package.json`, `pyproject.toml`, `pom.xml`,
   `Cargo.toml`, `*.csproj`, archivo `VERSION`, `__version__`, etc.) y úsala como
   única fuente de verdad. Si hay varias, repórtalo.
2. **Detecta la versión actual y la última etiqueta** (`git describe --tags`).
3. **Revisa los cambios desde esa etiqueta** (`git log`, diff). El cambio de mayor
   impacto decide el incremento.
4. **Si el repo usa Conventional Commits,** puedes apoyarte en ellos:
   `fix` sugiere PATCH, `feat` sugiere MINOR, y `!` o `BREAKING CHANGE` sugiere MAJOR.
   No los impongas si el repo no los usa.
5. **Propón al usuario** la versión, el motivo y los cambios que la justifican.
6. **Con su aprobación:** actualiza la versión en su fuente, el CHANGELOG y deja
   listos los comandos para la etiqueta `vX.Y.Z`.

## CHANGELOG
- Archivo `CHANGELOG.md` en la raíz, en español, formato "Keep a Changelog":
  secciones Agregado, Cambiado, Obsoleto, Eliminado, Corregido y Seguridad.
- Una sección por versión: `## [X.Y.Z] - AAAA-MM-DD`, y una sección `[Sin publicar]` arriba.
- Cada entrada describe el efecto para quien usa el software, no el detalle interno.

## Ramas de corrección (hotfix)
Una corrección urgente sobre una versión ya publicada sube PATCH a partir de la
etiqueta de esa versión; después se integra al desarrollo principal.

## Límites
Nunca crees ni subas etiquetas, ni publiques paquetes o releases, sin aprobación
explícita del usuario.
