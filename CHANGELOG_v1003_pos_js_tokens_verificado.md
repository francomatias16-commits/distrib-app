# v1003 — pos.js verificado contra sistema de tokens (Hoja de Ruta)

## Revisión de frontend/admin/js/pos.js

Siguiente en la cola después de v1002 (reportes-stock.js), según
SEGUIMIENTO_HOJA_DE_RUTA.md.

**Revisados los 19 casos detectados por grep** (`#hex`/`rgba(`):

- 17 fallbacks de `var(--token, #hex)` (líneas 665, 1015, 1702, 1973,
  2240, 2437, 2835, 3133, 3137, 3282, 3426, 3433, 3438, 3455, 3497,
  3504, 3508) — verificados contra `tokens.css` real: **todos
  correctos**, sin desincronización.
  - `--color-danger` → `#7A2820` ✓
  - `--nav-ventas` / `--color-success` → `#487050` ✓
  - `--color-warning` → `#8A5F13` ✓
  - `--color-warning-bg` → `#FBE8C9` ✓
  - `--color-warning-mid` → `#E0A53E` ✓
  - `--color-border-soft` → `#E7E9E4` ✓
- 2 valores crudos (líneas 1065 y 1075, `#487050`) — son el valor por
  defecto de un `<input type="color">` (selector de color de un
  botón favorito del POS). No pueden usar `var()` porque el input
  nativo requiere un literal hex. Coinciden exactamente con
  `--nav-ventas`/`--color-success` actual: **correctos, sin cambios**.

**Resultado: sin cambios de código.** A diferencia de v828
(etiquetas.js) y v1002 (reportes-stock.js), pos.js ya estaba
totalmente sincronizado con `tokens.css`.

Verificado con `node --check`.

## Siguiente en la cola

`notas-internas.js` (17 casos por grep) → luego `compras.js` (14).
