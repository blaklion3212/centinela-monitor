---
name: checklist-diseno-accesibilidad
description: "Checklist de accesibilidad y calidad visual de interfaces (WCAG 2.2 AA): contraste, foco, tamaños, teclado, responsive. Usar al diseñar o revisar interfaces."
---
# Checklist de accesibilidad y calidad visual (objetivo: WCAG 2.2 nivel AA)

## Color y contraste
- [ ] Texto normal: contraste mínimo 4.5:1. Texto grande: 3:1.
- [ ] Componentes de interfaz y gráficos informativos: 3:1 contra su fondo.
- [ ] El color nunca es el único medio para comunicar un estado (añade texto,
      icono o forma).
- [ ] Verifica tema claro y oscuro.

## Interacción
- [ ] Todo se opera con teclado, con orden de foco lógico.
- [ ] El foco es visible en todos los elementos interactivos.
- [ ] Objetivos táctiles o de clic de al menos 24x24 px (recomendado más grande).
- [ ] Estados definidos: hover, foco, activo, deshabilitado, error, cargando.

## Texto y layout
- [ ] Legible al ampliar el texto al 200 % y sin scroll horizontal a 320 px de ancho (web).
- [ ] Soporta textos más largos (el español suele ser más largo que el inglés).
- [ ] Jerarquía visual clara; tamaños de la escala tipográfica, no valores sueltos.

## Iconos e imágenes
- [ ] Iconos legibles a 16 px; los decorativos se ocultan a lectores de pantalla.
- [ ] Los iconos que comunican algo tienen etiqueta textual accesible.
- [ ] Imágenes informativas con texto alternativo.

## Movimiento
- [ ] Respeta la preferencia de reducir movimiento; sin parpadeos rápidos.

## Cómo reportar
Hallazgo: severidad (crítico/alto/medio/bajo), ubicación, problema, medición
(por ejemplo, contraste 3.1:1 en lugar de 4.5:1) y corrección sugerida.
