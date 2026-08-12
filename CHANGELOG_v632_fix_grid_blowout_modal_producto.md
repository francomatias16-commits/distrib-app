# v632 — Fix: formulario de producto se veía cortado / se escapaba del borde de la pantalla

## Síntoma
Después del v631 (que arregló el `transform` pegado), el modal seguía
viéndose roto: el panel se abría pero su contenido (campo Código, Estado,
foto, y sobre todo los botones Guardar/Cancelar del footer) quedaba
cortado en el borde derecho de la ventana, con toda la pinta de que el
modal era más ancho de lo que la pantalla podía mostrar.

## Causa raíz
`grid-template-columns: 1fr 1fr` — tal cual, sin `minmax(0, ·)` — no
tiene piso: por spec, una pista `1fr` no puede achicarse por debajo del
`min-content` de su contenido. Si cualquier elemento adentro (un input,
un botón, un select) pide más ancho del que le tocaría en esa columna,
la pista de grid crece para darle lugar, y empuja todo el contenedor
(`.modal-grid-2col`, y con él `.form-row` en dos lugares) más ancho de
lo que el modal permite — apareciendo cortado en el borde de la ventana
en vez de ajustarse.

Afectaba dos selectores en `productos.css`:
- `.modal-grid-2col` (las 2 columnas grandes: Identificación/Foto vs.
  Precios/Depósitos)
- `.form-row` (los pares de campos tipo Nombre/Código,
  Categoría/Estado, dentro de cada columna)

## Fix
`minmax(0,1fr)` en ambos, más `min-width: 0` en los contenedores padres
(`.form-group`, `.modal-grid-2col`) para que el achique se propague
correctamente por toda la cadena flex/grid. También se agregó
`overflow-x: hidden` explícito en `.modal--producto .tab-panel` en vez
de depender de la conversión implícita `visible→auto` del spec de CSS
overflow, para no dejarlo librado a comportamiento implícito del
navegador.

Archivo: `frontend/admin/css/productos.css`
Cache-busting: `productos.css?v=233` → `?v=234`.

## Nota
Si después de este deploy seguís viendo el mismo corte, probablemente
el navegador (o Vercel) está sirviendo una versión cacheada — probá
hard refresh (Ctrl+Shift+R) y confirmá en el HTML servido que dice
`?v=234`.
