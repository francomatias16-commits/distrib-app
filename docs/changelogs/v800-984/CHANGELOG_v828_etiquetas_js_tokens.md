# v828 — etiquetas.js migrado al sistema de tokens (Hoja de Ruta)

## Cambios en frontend/admin/js/etiquetas.js (28 casos por grep)

Mismo patrón que `busqueda-global.js` (v824): inyecta `<style>` en
`document.head` y ya usaba `var(--token, #hex)` en todo, pero con
fallbacks de una paleta anterior desincronizados — parecen haber sido
generados en la misma pasada que `busqueda-global.js` (los valores
viejos coinciden exactamente).

**5 fallbacks corregidos**:

| Token | Fallback viejo | Fallback correcto |
|---|---|---|
| `--color-text-muted` | `#4B4A45` | `#5B6660` |
| `--color-border` | `#C7BFA9` | `#DDE1DC` |
| `--color-text` | `#16181D` | `#111A17` |
| `--color-surface` | `#FCFAF5` | `#FFFFFF` |
| `--color-bg` | `#F5F2EA` | `#F6F7F5` |

**1 shadow crudo**: `box-shadow: 0 8px 24px rgba(0,0,0,.12)` del popover
de gestión de etiquetas → `rgba(22,24,29,.12)`.

`--color-primary` y `--color-danger` ya tenían el fallback correcto.
**`PALETA`** (8 colores para etiquetas por hash) — dejada intencional,
mismo criterio que `PALETA` en `productos.js`.

Verificado con `node --check`. Sin cambios visuales esperados.

## Siguiente en la cola

`reportes-stock.js` (24 casos) — ver `audit_table.md`.
