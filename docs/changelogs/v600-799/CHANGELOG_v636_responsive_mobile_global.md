# v636 — Responsive mobile: auditoría exhaustiva y corrección global

## Resumen
Auditoría y corrección completa de responsividad en todo el proyecto.
Prioridad mobile (≤768px). Se analizaron 72 páginas HTML, todos los
archivos CSS compartidos y los específicos de cada módulo.

## Archivos creados
- `frontend/shared/responsive-mobile.css` — **nuevo parche global mobile-first**
  Incluido en las 72 páginas del sistema (admin, cliente, chofer, proveedor,
  scan-pos, registro). Cubre 18 secciones de correcciones:
  1. Tablas: overflow-x:auto en .tabla-wrap (crítico — arregla TODAS las páginas con tablas)
  2. Topbar: jerarquía de visibilidad progresiva (oculta elementos secundarios en mobile)
  3. Status pills: #pill-ia se oculta ≤768px; #pill-wa y #pill-pos se ocultan ≤480px
  4. Filtros/toolbars: flex-direction:column en ≤640px
  5. Modal footer / form-acciones: flex-wrap en ≤560px
  6. Grids de formulario: 2col → 1col en ≤560px
  7. Cards: padding compacto en ≤480px
  8. Botones: área táctil mínima 40px (WCAG) en ≤768px
  9. Breadcrumb: flex-wrap y font-size reducido en ≤480px
  10. Safe area insets: padding-bottom para notch/barra inferior iOS y Android
  11. Imágenes/media: max-width:100% universal
  12. Inputs: font-size:16px en ≤640px (evita zoom automático en iOS)
  13. Portal cliente: carrito, checkout, cuenta, catálogo
  14. POS: grid 2 columnas en mobile, sidebar 45vh
  15. Rutas: layout columna en mobile, mapa 50vw
  16. Dashboard: KPI grid 2 columnas en ≤640px, 1 columna en ≤360px
  17. Scroll horizontal hint: sombra visual indicadora
  18. Print: oculta nav/topbar/filtros, tabla sin overflow

## Archivos modificados
- `frontend/shared/reskin-patch.css`
  `.tabla-wrap`: agregado overflow-x:auto + -webkit-overflow-scrolling:touch

- `frontend/shared/adminlte-components.css`
  Bloque @media(max-width:768px): agregados .topbar-left min-width:0, gap:6px
  y .topbar-contador display:none (se muestra en el body, no necesario en topbar)

- `frontend/shared/reskin-patch-v2-shadcn.css`
  `.modal-footer`, `.dialog-footer`: agregado flex-wrap:wrap
  + @media(max-width:560px): padding compacto y botones flex:1

- `frontend/admin/css/productos-modal-fix.css` (bump v3)
  `.form-acciones` en ≤760px: flex-wrap, botón eliminar al final (order:10)

- `frontend/admin/css/pedido-modal-fullscreen.css`
  + @media(max-width:480px): cart más compacto, item grid 2col+subtotal fila propia

- `frontend/admin/dashboard.html`
  CSS inline: reglas mobile para grid del dashboard y topbar pills

## Sin migraciones de base de datos
