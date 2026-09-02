# CHANGELOG v211 — Paginación y refresco visual de Pedidos

## Problema
La tabla de Pedidos cargaba hasta 200 registros y los renderizaba todos de
una sola vez en el `<tbody>`, obligando a scrollear una lista larga para
llegar a los últimos pedidos.

## Cambios

### `frontend/admin/js/pedidos.js`
- Se agrega paginación en el cliente: `PEDIDOS_POR_PAGINA = 20`.
- `renderTabla()` ahora recorta `filtrados` a la página actual antes de
  pasarla a `window.renderTbody()` (la función compartida no se modificó,
  para no afectar clientes.js / facturacion.js / rutas.js que también la usan).
- Nuevas funciones `renderPaginacion()` e `irAPagina(n)`, expuesta esta
  última en `window.irAPagina` para los botones inline del paginador.
- `aplicarFiltros(preservarPagina)` y `cargarPedidos(preservarPagina)`
  aceptan un flag para no devolver al usuario a la página 1 cuando el
  refresco viene de Realtime (INSERT/UPDATE) en vez de un cambio de filtro
  hecho a mano.
- La exportación a Excel (`exportarPedidosExcel`) sigue exportando todo
  `filtrados`, no solo la página visible — no se tocó ese comportamiento.

### `frontend/admin/pedidos.html`
- Nuevo contenedor `#paginacion-pedidos` debajo de la tabla.
- Cache-busting de `pedidos.css` y `pedidos.js` bumpeado a `v211`.

### `frontend/admin/css/pedidos.css`
- Estilos del paginador (`.paginacion-bar`, `.pg-nav`, `.pg-num`, `.pg-dots`).
- Refresco visual liviano sobre las clases existentes (sin romper ningún
  hook de JS): buscador y pills con `radius-full`, tabla como card con
  sombra `shadow-fluffy`, borde de acento a la izquierda de la fila en
  hover, punto de color antes del texto en los chips de estado.

## Pendiente / próximos pasos sugeridos
- Si en el futuro se quiere paginar también del lado del servidor (hoy se
  traen 200 pedidos y se pagina en memoria), habría que sumar `range()` a
  la query de Supabase en `cargarPedidos()` y recalcular el total con un
  `count: 'exact'` aparte.
- La vista "Tablero" (kanban) sigue mostrando todo agrupado por estado sin
  paginar — tiene sentido porque agrupa, pero si alguna columna crece mucho
  (ej. "Entregado" con 150+) se le podría sumar un scroll interno con lazy load.
