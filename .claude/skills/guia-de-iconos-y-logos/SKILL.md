---
name: guia-de-iconos-y-logos
description: "Especificaciones para iconos, logotipos y exportación de assets por plataforma. Usar al crear, optimizar o exportar iconos, logos y favicons."
---
# Guía de iconos, logotipos y exportación

## Iconos SVG
- Cuadrícula 24x24 con margen interno de 2 px (área útil 20x20); `viewBox` sin
  `width`/`height` fijos.
- Grosor de trazo uniforme en todo el set (por ejemplo 1.5 o 2 px), esquinas y
  terminaciones consistentes.
- Color con `currentColor` para heredar el color del texto; sin imágenes raster incrustadas.
- Legible a 16 px; un solo concepto por icono.
- Un archivo por icono, nombre en kebab-case (`usuario-agregar.svg`).
- Entrega una hoja de contacto (HTML o SVG) para revisión visual.

## Logotipos
- Entrega variantes: principal, horizontal, vertical, isotipo, monocromo y negativo
  (para fondo oscuro).
- Define espacio de respeto y tamaño mínimo; comprueba que funciona a 16 px
  (favicon) y en blanco y negro.
- Convierte el texto a trazos solo si la licencia de la tipografía lo permite.
- Originalidad: no imites marcas existentes; recomienda verificar registro de
  marca antes de uso comercial.

## Exportación (tamaños habituales)
| Destino | Formato y tamaños |
|---|---|
| Favicon web | `.ico` con 16, 32 y 48 px; SVG si el navegador lo soporta |
| iOS web | PNG 180x180 (`apple-touch-icon`) |
| PWA | PNG 192x192 y 512x512 |
| Windows (app) | `.ico` multi-resolución (16, 32, 48, 256) |
| macOS (app) | `.icns` |
| Linux (app) | PNG 16, 32, 48, 64, 128, 256, 512 |

Confirma las exigencias vigentes de la plataforma o del empaquetador que use el
proyecto. Respeta la carpeta de assets que ya exista (`assets/`, `public/`,
`resources/`); si no existe, propón una.

## Optimización
Usa svgo u otra herramienta disponible; elimina metadatos y conserva `viewBox`.
Si falta la herramienta, repórtalo sin instalar nada sin aprobación.
