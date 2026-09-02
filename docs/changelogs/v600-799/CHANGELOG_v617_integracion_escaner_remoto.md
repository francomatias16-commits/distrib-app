# CHANGELOG v617 — Integración escáner remoto en distribución completa

## Resumen
Se integró el paquete `distrib_v617_escaner_remoto` (parche incremental) sobre la base
`distrib_v616_COMPLETO`, generando una distribución única y actualizada.

## Archivos nuevos
- `frontend/admin/js/productos-scanner-remoto.js`
- `frontend/admin/js/stock-scanner-remoto.js`
- `frontend/shared/vincular-celular.js`
- `lib/handlers/pos-scanner.js` → ya existía, ver "Archivos actualizados"
- `supabase/migrations/439_pos_scanner_remoto_generalizado.sql`

## Archivos actualizados (sobrescritos por la versión de v617)
- `frontend/admin/js/pos-scanner-remoto.js`
- `frontend/admin/js/stock.js`
- `frontend/admin/productos.html`
- `frontend/admin/stock.html`
- `frontend/scan-pos/portal.js`
- `lib/handlers/pos-scanner.js`
- `lib/repos/pos-scanner.js`

## Migraciones
La migración `439_pos_scanner_remoto_generalizado.sql` continúa la secuencia existente
(la última migración presente en la base v616 era `438_pos_scanner_remoto.sql`), sin
conflictos de numeración.

## Notas
Todo el resto del contenido de `distrib_v616_COMPLETO` (backend, migraciones previas,
documentación, tests, etc.) se mantuvo sin cambios.
