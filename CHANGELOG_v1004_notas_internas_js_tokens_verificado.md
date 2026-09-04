# v1004 — notas-internas.js verificado contra sistema de tokens

## Revisión de frontend/admin/js/notas-internas.js

**Revisados los 17 casos detectados por grep** (`#hex`/`rgba(`):

- 16 fallbacks de `var(--token, #hex)` (líneas 316, 349, 350, 365,
  370, 378, 392, 397, 409, 421, 426, 427, 435, 436, 448, 467) —
  verificados contra `tokens.css` real: **todos correctos**.
  - `--color-bg` → `#F6F7F5` ✓ · `--color-surface` → `#FFFFFF` ✓
  - `--color-border` → `#DDE1DC` ✓
  - `--color-text` → `#111A17` ✓ · `--color-text-muted` → `#5B6660` ✓
  - `--color-danger` → `#7A2820` ✓ · `--color-primary` → `#6A9873` ✓
- `AVATAR_COLORS` (array de 7 hex para colores de avatar, línea 53)
  — dejado intencional, mismo criterio que `PALETA` en
  `etiquetas.js`/`productos.js` y `colores` en `reportes-stock.js`.

**Resultado: sin cambios de código.** notas-internas.js ya estaba
totalmente sincronizado con `tokens.css`.

Verificado con `node --check`.

## Siguiente en la cola

`compras.js` (14 casos por grep).
