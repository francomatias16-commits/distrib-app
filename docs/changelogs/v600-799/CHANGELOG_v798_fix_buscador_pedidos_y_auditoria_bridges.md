# v798 — Fix: buscador de pedidos no funcionaba (bridge faltante) + auditoría de bridges en el resto del admin

## Problema
El buscador de "Cliente, N° pedido..." y todos los filtros de la
grilla de Pedidos (vendedor / zona / canal / cliente / fecha / importe)
no hacían nada al tipear o seleccionar.

## Causa raíz
`pedidos.js` se carga con `type="module"`, por lo que sus funciones
top-level no quedan expuestas en `window`. Los `onclick`/`oninput`
inline del HTML corren en scope global y necesitan un bridge explícito
(`window.fn = fn`) para encontrarlas — patrón ya usado en el archivo
para otras funciones (`cerrarModal`, `limpiarFiltros`, `cambiarEstado`,
etc.), pero **a `aplicarFiltros` — la función detrás del buscador y de
todos los filtros — se le había olvidado ese bridge.**

## Fix
- `frontend/admin/js/pedidos.js`: se agregó
  `window.aplicarFiltros = aplicarFiltros;` junto al resto de los
  bridges de exposición global, con comentario explicando la causa.

## Auditoría del mismo patrón en el resto del admin
Se repitió el chequeo (comparar handlers inline `onclick/oninput/onchange/...`
usados en cada HTML y en templates generados dentro del JS, contra las
funciones top-level definidas y sus bridges `window.X =`) en todas las
páginas principales:

- `automatizacion.html` — OK, sin bridges faltantes
- `cc-proveedores.html` — OK, sin bridges faltantes
- `clientes.html` — OK, sin bridges faltantes
- `rutas.html` (+ `rutas-resumen.js`) — OK, sin bridges faltantes
- `stock.html` — OK, sin bridges faltantes
- `presupuestos.html` — OK, sin bridges faltantes
- `cobranzas.html` — OK, sin bridges faltantes
- `pos.html` — el chequeo automático marcó `cargarVentas` y `usarTurno`
  como "posibles rotos", pero es un falso positivo: `pos.js` se carga
  como `<script src="...">` clásico (NO `type="module"`), así que sus
  funciones top-level ya son globales por defecto y no necesitan
  bridge. Verificado manualmente, sin problema real.
- `pedidos.html` — verificado post-fix, sin bridges faltantes.

**Conclusión: `aplicarFiltros` en `pedidos.js` era el único bridge
faltante en todo el panel admin.** No quedan pendientes de este tipo.
