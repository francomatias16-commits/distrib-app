# v1005 — compras.js migrado al sistema de tokens

## Cambios en frontend/admin/js/compras.js

**Revisados los 14 casos detectados por grep** (`#hex`/`rgba(`):

- 12 fallbacks de `var(--token, #hex)` (líneas 350, 1202, 1291, 1292,
  1339, 1340, 1341, 1346, 1361, 1375, 1410, 1445) — verificados
  contra `tokens.css` real: **todos correctos**.
- 1 valor crudo corregido: `rgba(22,24,29,.15)` (box-shadow de la
  miniatura de remito, línea 1233) usaba `22,24,29` (`#16181D`), el
  valor viejo de `--color-text` ya reemplazado en v828. Actualizado a
  `rgba(17,26,23,.15)` (`#111A17`, el `--color-text` actual).
- `rgba(106,152,115,0.08)` (línea 1259, resaltado de fila con alerta
  de matching) — verificado: coincide exactamente con
  `--color-primary` (`#6A9873`) actual. Correcto, dejado como está.

Verificado con `node --check`. Sin cambios visuales esperados salvo
la corrección puntual (valores casi idénticos al ojo).

## Siguiente en la cola

Sin más archivos pendientes explícitos en SEGUIMIENTO_HOJA_DE_RUTA.md
más allá de los mencionados en v1002. Si hay más módulos a auditar,
decime cuáles y sigo con el mismo criterio.
