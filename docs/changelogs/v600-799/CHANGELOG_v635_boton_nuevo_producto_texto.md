# v635 — Botón "+" reemplazado por "Nuevo producto" con texto visible

## Cambio
El botón de agregar producto en la página de productos pasó de mostrar
solo el ícono "+" a mostrar ícono + texto "Nuevo producto", para que
sea más fácil de identificar visualmente.

## Archivos modificados
- `frontend/admin/productos.html` — contenido del botón: se agregó `<span>Nuevo producto</span>`
- `frontend/admin/css/productos.css` — `.prod-add-btn`: width fijo 34px → auto con padding 0 14px, gap 6px, font-size 13px bold

## Sin migraciones de base de datos
