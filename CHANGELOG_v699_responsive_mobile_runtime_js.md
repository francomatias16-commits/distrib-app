# v699 — Responsive mobile: script runtime de refuerzo + cierre de auditoría

## Contexto
Continuación directa de v636 (auditoría y CSS global) y v637 (dashboard).
La auditoría había detectado dos clases de problemas que el CSS solo no
puede resolver porque dependen del HTML/JS de cada página:

1. **14 páginas con `<table>` sin ningún wrapper de scroll horizontal**
   (automatizacion, cajas, cc-proveedores, compras, facturacion, migracion,
   observabilidad, proveedores, puntos, reportes-stock, rutas,
   saas-billing, index, terminos) — en mobile esas tablas desbordaban el
   body en lugar de scrollear internamente.
2. **5 páginas con `grid-template-columns` inline de 3+ columnas fijas**
   (cc-proveedores, cobranzas, export-contable, pedidos; dashboard ya
   resuelto en v637) — imposibles de sobreescribir solo con CSS externo.
3. `scan-pos/portal.html` tenía `user-scalable=no` en el viewport,
   bloqueando el zoom accesible.

## Archivos creados
- `frontend/shared/responsive-mobile.js` — **nuevo script runtime**,
  incluido junto al CSS en las mismas 72 páginas. Dos funciones:
  - `wrapOrphanTables()`: envuelve en runtime cualquier `<table>` sin
    contenedor de scroll (`.tabla-wrap`, `.tabla-main`, `.tabla-base`,
    etc.) con un `<div class="rmw-tabla-auto">`. Corre en
    `DOMContentLoaded` y además queda un `MutationObserver` sobre
    `document.body` para cubrir tablas que se renderizan después de un
    fetch (patrón usado en casi todos los módulos admin).
  - `fixInlineGrids()`: detecta elementos con `grid-template-columns`
    inline de 3+ columnas fijas, guarda el valor original en
    `data-rmw-grid-orig` y en ≤640px lo colapsa a `repeat(2,1fr)` (si
    eran 4+ cols) o `1fr` (si eran 3). Restaura el valor original al
    volver a desktop. Se re-evalúa en `resize` (debounce 120ms). No toca
    grids que ya usan `auto-fit`/`auto-fill` (esos ya son responsive).

## Archivos modificados
- `frontend/shared/responsive-mobile.css`
  - `.rmw-tabla-auto` agregada al selector de `.tabla-wrapper` (mismo
    `overflow-x:auto` + `-webkit-overflow-scrolling:touch`).
  - Nueva sección 0 — **safety net global**: `html, body { max-width:
    100vw; overflow-x:hidden }` para que ningún elemento suelto (grid mal
    calculado, texto sin wrap) pueda generar scroll horizontal de toda la
    página. Los contenedores que sí necesitan scroll horizontal propio
    (tablas, `.dash-quick-nav`, tabs) declaran su propio `overflow-x:auto`
    y no se ven afectados.
  - Cache buster subido a `?v=699` en las 72 páginas que lo incluyen.

- **72 páginas HTML** (admin ×54, cliente ×8, chofer ×5, proveedor ×1,
  scan-pos ×1, raíz ×3: `index.html`, `registro.html`,
  `completar-registro.html`): bump `responsive-mobile.css?v=699` +
  agregado `<script src=".../responsive-mobile.js?v=699" defer></script>`
  inmediatamente después del link del CSS.

- `frontend/scan-pos/portal.html`
  Viewport: quitado `user-scalable=no` (bloqueaba el zoom accesible en
  mobile; se mantiene `viewport-fit=cover`).

- `frontend/terminos.html`, `frontend/privacidad.html`,
  `frontend/eliminacion-datos.html`
  Estas 3 páginas legales quedaban **fuera del set de 72** de v636 (nunca
  incluyeron `responsive-mobile.css`). Se agregó el link del CSS + script
  del JS en las 3, cerrando la cobertura a las **75/75 páginas HTML** del
  proyecto. `terminos.html` además tenía un `<table>` sin wrapper — ahora
  cubierta por `wrapOrphanTables()`.

## Verificación
- `node --check` sobre `responsive-mobile.js` → OK.
- Re-escaneo automatizado post-cambio: 0 páginas con `<table>` fuera de
  un wrapper con `overflow-x` (ni cubierta por el script runtime), 0
  páginas con `responsive-mobile.css` en versión vieja (`v636`/`v637`),
  0 páginas sin meta viewport, 0 páginas con `user-scalable=no`,
  **75/75 páginas** con CSS + JS incluidos.

## Alcance no cubierto (fuera de esta pasada)
- `.modal--producto` (productos.css) ya tenía sus propios breakpoints
  (≤900px / ≤760px / ≤560px) — verificado, sin cambios necesarios.
- No se tocó el `fixMobileGrids()` específico de `dashboard.html` (v637);
  es intencionalmente distinto porque ese dashboard tiene selectores muy
  puntuales por card. El nuevo script es el mecanismo genérico para el
  resto del proyecto.

## Sin migraciones de base de datos
