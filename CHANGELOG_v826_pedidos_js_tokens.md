# v826 — pedidos.js migrado al sistema de tokens (Hoja de Ruta)

## Cambios en frontend/admin/js/pedidos.js (29 casos)

- **5 fallbacks desincronizados**: `--color-border-soft,#DAD3C0` →
  `#E7E9E4` (spinner de carga); `--color-text,#16181D` → `#111A17`
  (3 lugares: spinner, bloque de error, banner predictivo);
  `--color-text-light,#6B695F` → `#7A857E` (spinner); `--color-text-muted,
  #4B4A45` → `#5B6660` (bloque de error).
- **1 texto blanco crudo**: `color:#fff` del botón "Reintentar" →
  `var(--color-surface, #fff)`.
- **1 hex crudo real**: el chip "Devolución rechazada" usaba `#7a7a7a`/
  `#c7c7c7` sueltos, sin token asignado (estado neutro/no-semántico) →
  migrado a `var(--color-text-muted, #5B6660)` / `var(--color-border,
  #DDE1DC)`, el mismo par que usa `.btn--secondary` en `tokens.css` para
  su estilo neutro/outline — es el precedente más cercano para "gris
  neutro sin fondo" que ya existe en el sistema.
- **`_PALETA_AVATAR`** (7 colores para avatar de cliente por hash) —
  dejada intencional, mismo criterio que `CHOFER_PALETTE` en `rutas.js`.
- El resto (chip de factura con error, mensaje de error de facturación
  del modal, banner predictivo de datos autocompletados) ya tenía el
  fallback correcto.

Verificado con `node --check` — sin errores. Sin cambios visuales
esperados salvo el chip "Devolución rechazada" (gris fijo → tokens
muteados, visualmente casi idéntico).

## Siguiente en la cola

`cc-proveedores.js` (29 casos) — ver `audit_table.md`.
