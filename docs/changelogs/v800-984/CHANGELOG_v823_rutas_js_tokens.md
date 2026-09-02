# v823 — rutas.js migrado al sistema de tokens (Hoja de Ruta)

Continuación de la migración de color hardcodeado en JS (v728→v731→v823),
siguiente archivo de la cola según `SEGUIMIENTO_HOJA_DE_RUTA.md`.

## Cambios en frontend/admin/js/rutas.js (26 casos)

- **`colores` map de estado de entrega** (2 instancias — mapa principal
  y mapa de reporte): `entregado/no_entregado/pendiente/en_camino` →
  `var(--color-box-success/danger/warning/info, #hex)`. Los 4 hex ya
  coincidían exactamente con los tokens `--color-box-*` de `tokens.css`
  (pensados para este uso: fondo sólido de un ícono, no texto/badge).
- **Bordes y texto blanco de los markers de Leaflet** (mapa principal,
  mapa de reporte y marcador de chofer — 3 lugares, 6 ocurrencias) →
  `var(--color-surface, #fff)`.
- **Sombras `rgba(0,0,0,X)`** (3 instancias, valores `.3`/`.35`/`.4`) →
  tinta `rgba(22,24,29,X)`, mismo mapeo de "ink en vez de negro puro" ya
  usado en `productos.js`/`tienda-nav.css`.
- **1 fallback desincronizado**: `var(--color-text-light,#6B695F)` — el
  hex de respaldo no coincidía con el valor real del token
  (`--color-text-light: #7A857E`). Corregido al valor real, mismo
  criterio que la auditoría de fallbacks de v729.
- **`CHOFER_PALETTE`** (5 colores para hashear nombre→color de avatar) —
  dejada intencional a propósito, mismo criterio que `PALETA` en
  `productos.js`: son colores que necesitan ser mutuamente distinguibles
  entre sí, no representan un estado semántico de la paleta de marca.
- 2 usos de `var(--color-success,#487050)` y 1 de
  `var(--color-info-mid,#33507A)` ya tenían el fallback correcto — no
  requirieron cambio.

Verificado con `node --check` — sin errores de sintaxis. Sin cambios
visuales esperados.

## audit_table.md desactualizado

El `audit_table.md` de la raíz listaba el frente de **CSS de pantalla**
(77 archivos, ~1195 hex) como 100% "Pendiente" — ese frente está cerrado
desde v488. Se reescribió el archivo para reflejar el frente real que
sigue abierto (JS con color hardcodeado) y se dejó anotado el motivo del
desvío para que no se repita.

## Siguiente en la cola

`busqueda-global.js` (45 casos por grep) — ver `audit_table.md`
actualizado para el resto del orden.
