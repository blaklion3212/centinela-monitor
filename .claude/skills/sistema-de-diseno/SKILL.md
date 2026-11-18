---
name: sistema-de-diseno
description: "Sistema de diseño: detección del existente, tokens neutrales, componentes y estados, temas. Usar al diseñar, revisar o implementar interfaces."
---
# Sistema de diseño (genérico, válido para cualquier tecnología de UI)

## Procedimiento
1. **Reglas explícitas.** Si existe `.claude/proyecto/diseno.md` y NO contiene la
   línea `ESTADO: SIN COMPLETAR`, léelo y síguelo; prevalece.
2. **Detecta lo existente:** variables CSS (`:root`), `tailwind.config*`, temas de
   librerías de componentes, `tokens.json`, hojas de estilo del toolkit de
   escritorio (QSS, QML, temas Tk, etc.), carpeta de iconos y fuentes.
3. **Si no hay sistema de diseño,** propón uno mínimo en `docs/diseno/tokens.json`
   y `docs/diseno/sistema.md`. Pide aprobación del usuario antes de aplicarlo.
4. **Mantén una sola fuente de verdad** (los tokens) y traduce desde ahí a la
   tecnología del proyecto (variables CSS, tema del framework, hoja de estilo
   del toolkit, etc.).

## Tokens (formato neutral)
- **Color:** primario, secundario, neutros, semánticos (éxito, aviso, error,
  información), superficie y texto; variantes para tema claro y oscuro.
- **Tipografía:** familias, escala de tamaños, pesos, interlineado.
- **Espaciado:** escala con base fija (por ejemplo 4 px).
- **Forma y profundidad:** radios, bordes, sombras.
- **Movimiento:** duraciones y curvas; respeta la preferencia de reducir movimiento.
- **Breakpoints** (web) o tamaños mínimos de ventana (escritorio).

## Componentes
Cada componente se especifica con todos sus estados: normal, hover, foco,
activo, deshabilitado, error y cargando. Define variantes y tamaños, no
valores sueltos.

## Notas
- El español suele ocupar más espacio que el inglés: no fijes anchos rígidos
  en textos.
- Nunca uses un valor visual literal si existe un token equivalente.
