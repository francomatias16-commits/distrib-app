# v705 — Integración: tamaño de fuente en zonas + fix dropdown clientes

Build consolidado sobre v703 (mejora UI), incorporando dos entregables sueltos:

## v704 — Ajuste de fuente en tira de rutas/zonas
- `frontend/admin/css/rutas-compact.css`: subió tamaño de fuente y padding en los
  chips/badges de zona (12px→13px, line-height 1.3→1.4, padding levemente mayor
  en 3 bloques) — se veían demasiado chicos.
- `frontend/admin/rutas.html`: bump de cache-busting del CSS (`?v=1` → `?v=2`).

## v705 — Fix dropdown "Más acciones" tapado en clientes
- `frontend/admin/css/clientes.css`: el menú desplegable `.dropdown-menu` de
  "Más acciones" quedaba tapado por la tarjeta de la tabla al abrirse (mismo
  síntoma ya resuelto antes en productos-modal-fix.css). Se fuerza
  `.filtros-bar` a ser su propio stacking context (`position: relative;
  z-index: 20`) y se sube `.dropdown-menu` a `z-index: 9999 !important`.
- `frontend/admin/clientes.html`: bump de cache-busting del CSS
  (`?v=196` → `?v=197`).

Sin cambios de backend ni migraciones en este lote.
