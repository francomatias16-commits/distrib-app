# v238 — Barra de accesos visible en Punto de venta (quickbar)

## Problema
Todas las secciones de administración (Ventas/anular, Stock, Favoritos,
Devoluciones, Promociones, Hardware, Config POS) y las acciones de caja
(Movimiento de caja, Reporte Z) quedaban escondidas detrás de botones
sueltos en el topbar (o del botón "Administrar"), poco visibles.

## Cambio
Se agregó una barra de menú fija debajo del topbar de Punto de venta
(`pos-quickbar`) con **todas las opciones visibles directamente, sin
necesidad de abrir nada primero**:

- **Grupo Caja** (Movimiento de caja, Reporte Z): visible solo cuando hay
  un turno abierto, igual que antes.
- **Grupo Administración** (Ventas, Stock, Favoritos, Devoluciones,
  Promociones, Hardware, Config POS): visible para roles dueño/admin,
  igual que antes lo era el botón "Administrar".
- Cada botón abre directamente el panel de administración (rediseñado en
  v237) ya posicionado en esa pestaña — no hace falta entrar primero a
  "Administrar" y buscar la pestaña.
- El botón único "Administrar" del topbar se eliminó; sus funciones ahora
  viven en esta barra, siempre visibles.
- Responsive: en mobile la barra se comprime y permite scroll horizontal.

## Archivos modificados
- `frontend/admin/pos.html` — nueva barra `pos-quickbar` bajo el topbar;
  se quitaron los botones sueltos "Caja", "Reporte Z" y "Administrar" del
  topbar (movidos a la quickbar); ajustado el script de toggle según turno/rol.
- `frontend/admin/js/pos.js` — `abrirModalAdmin(tab)` ahora acepta la
  pestaña a abrir directamente; el gate de rol admin/dueño ahora
  muestra/oculta el grupo completo de la quickbar en vez de un botón único.
- `frontend/admin/css/pos.css` — estilos de la nueva barra `pos-quickbar`
  (bump de cache `?v=199` en pos.html).

## Cómo aplicar
Reemplazá estos tres archivos en tu repo y deployá. No requiere migraciones
ni cambios de backend. Compatible con el panel de administración v237
(mismos ids de pestañas y paneles, ninguna función de pos.js fue removida).
