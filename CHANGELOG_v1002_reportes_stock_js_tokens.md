# v1002 — reportes-stock.js migrado al sistema de tokens (Hoja de Ruta)

## Cambios en frontend/admin/js/reportes-stock.js

Siguiente en la cola después de v828 (etiquetas.js), según SEGUIMIENTO_HOJA_DE_RUTA.md.

**Revisados los 12 casos detectados por grep** (`#hex`/`rgba(`):

- 6 fallbacks de `tokens.X || '#hex'` (líneas 234-235, 446, 931-932) —
  verificados contra `tokens.css` real: **todos correctos**, sin
  desincronización (a diferencia de etiquetas.js en v828).
- **2 valores crudos corregidos**: `rgba(22,24,29,.35)` (overlay del
  menú de exportación) y `rgba(22,24,29,.18)` (box-shadow del panel) —
  ambos usaban `22,24,29` (`#16181D`), el valor viejo de `--color-text`
  ya reemplazado en v828. Actualizados a `rgba(17,26,23,...)`
  (`#111A17`, el `--color-text` actual).
- `colores` (array de 6 hex para el gráfico de ingresos/egresos por
  categoría, línea 178) — dejado intencional, mismo criterio que
  `PALETA` en `etiquetas.js`/`productos.js`.

Verificado con `node --check`. Sin cambios visuales esperados (los 2
valores corregidos eran casi idénticos al ojo: `#16181D` vs `#111A17`).

## Siguiente en la cola

`pos.js` (19 casos por grep) → luego `notas-internas.js` (17) →
`compras.js` (14).
