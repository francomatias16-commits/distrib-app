# v827 — cc-proveedores.js migrado al sistema de tokens (Hoja de Ruta)

## Cambios en frontend/admin/js/cc-proveedores.js (29 casos por grep)

Archivo liviano: de los 29 hits, solo 1 era deuda real.

- **1 fallback desincronizado**: `var(--color-surface-2,#EAE4D6)` en el
  encabezado de la tabla de historial de pagos — el hex de respaldo
  correspondía en realidad a `--pill-neutral-bg`, no al valor real de
  `--color-surface-2` (`#ECEEEA`). Corregido.
- El resto (badges de estado danger/warning/success en montos y
  vencimientos) ya tenía el fallback sincronizado.
- **`PROV_PALETTE`** (línea 27, idéntica a `CHOFER_PALETTE` de
  `rutas.js`) — dejada intencional, mismo componente de avatar por hash.

Verificado con `node --check`. Sin cambios visuales esperados.

## Siguiente en la cola

`etiquetas.js` (28 casos) — ver `audit_table.md`.
