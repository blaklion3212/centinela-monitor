# Manual de usuario de Centinela

El manual se escribe en Markdown (`manual.md`) y se convierte al PDF
`docs/Centinela-Manual-de-usuario.pdf` con `generar_manual.py`.

## Regenerar el PDF

Requisitos (Debian/Ubuntu):

```
sudo apt install python3-reportlab fonts-dejavu-core fonts-dejavu-extra
```

Las fuentes usadas son DejaVu Sans Condensed y DejaVu Sans Mono, en
`/usr/share/fonts/truetype/dejavu/`.

Uso:

```
python3 docs/manual/generar_manual.py [--entrada ruta.md] [--salida ruta.pdf]
```

Sin argumentos lee `docs/manual/manual.md` y escribe
`docs/Centinela-Manual-de-usuario.pdf`. Si falta una imagen, el script
termina con un error que indica la línea y la ruta buscada.

## Guía de uso

`guia-uso.md` es una guía de uso aparte, para quien usa el panel a diario
(sin instalación ni API). Usa el mismo contrato de formato y las mismas
imágenes. Para regenerar su PDF:

```
python3 docs/manual/generar_manual.py --entrada docs/manual/guia-uso.md --salida docs/Centinela-Guia-de-uso.pdf
```

## Cómo editar

1. Edita `docs/manual/manual.md`.
2. Guarda las imágenes (JPG o PNG) en `docs/manual/img/`; las rutas son
   relativas al Markdown (`img/archivo.jpg`).
3. Regenera el PDF y revisa el resultado. El índice y los números de
   página se calculan solos.

La portada usa `img/p01-fig-000.jpg` (opcional; si no existe se omite) y el
logotipo se dibuja a partir de `assets/img/logo.svg`.

## Contrato de formato

- **Metadatos** al inicio, entre líneas `---`: `title`, `subtitle`, `version`, `date`.
- `# ` capítulo: empieza página nueva y entra al índice (nivel 1).
- `## ` sección: entra al índice (nivel 2).
- `### ` subsección: solo título, no entra al índice.
- **Párrafos** separados por línea en blanco. En línea: `**negrita**`,
  `*cursiva*` y `` `código` ``. Los caracteres `&`, `<` y `>` se escapan solos.
- **Listas**: `- ` (viñetas) y `1. ` (numeradas); segundo nivel con dos espacios de sangría.
- **Tablas** con cabecera y separador:

  ```
  | Columna A | Columna B |
  |---|---|
  | dato | dato |
  ```

  Los anchos se reparten según el contenido y el texto se ajusta en la celda.
- **Bloques de código** entre líneas con tres comillas invertidas (fondo gris, tipografía mono).
- **Figuras**: `![pie de figura](img/archivo.jpg)` en una línea propia. Se
  escala al ancho útil y se numera como «Figura N.» (si el pie ya empieza por «Figura N», se respeta).
- **Avisos**: `> **Nota:** texto`, `> **Importante:** texto`, `> **Consejo:** texto`
  (cajas azul, ámbar y verde).
- `<!-- pagina -->` en una línea: salto de página. Otros comentarios `<!-- ... -->` se ignoran.
