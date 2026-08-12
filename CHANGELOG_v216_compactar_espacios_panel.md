# Fix: espacios vacíos en las filas de dos columnas del Panel principal

## Problema
En "Necesita tu atención" vs. "Gráfico de ventas", y en "Pedidos
recientes" vs. "Stock crítico", cuando una tarjeta tenía mucho más
contenido que su vecina, la más corta terminaba mucho antes y quedaba
un bloque de fondo oscuro/negro expuesto a su lado — sensación de panel
desordenado con huecos.

## Causa raíz
`.dash-tablas-grid` tenía `align-items: start`, que desactiva el
comportamiento por defecto de CSS Grid (que ya estira todas las columnas
de una fila al alto de la más alta). Con "start" cada tarjeta tomaba
solo el alto de su propio contenido.

## Cambios — frontend/admin/css/dashboard.css
- `.dash-tablas-grid`: `align-items: start` → `stretch`.
- `.dash-tablas-grid > .card { height: 100% }` y su `.card-body` con
  `flex:1; display:flex; flex-direction:column` para que la tarjeta
  corta aproveche el alto ganado en vez de dejarlo vacío arriba.
- `.dash-grafico-card` y `.dash-stock-card` (nuevas clases, ver abajo):
  `.card-body { justify-content: center }` para centrar verticalmente
  el gráfico / la tabla corta de stock dentro del alto de la fila, en
  vez de quedar pegados arriba con espacio muerto abajo.

## Cambios — frontend/admin/dashboard.html
- Agregadas las clases `dash-pedidos-card` y `dash-stock-card` a las
  tarjetas de ZONA 3 (antes no tenían clase propia, solo `.card`).
- `#grafico-ventas`: `min-height` de 200px → 260px (gráfico un poco más
  grande, mejor aprovechamiento del alto disponible).

## Resultado esperado
Ambas tarjetas de cada fila (atención/gráfico, pedidos/stock) terminan
a la misma altura, sin fondo oscuro expuesto entre ellas.
