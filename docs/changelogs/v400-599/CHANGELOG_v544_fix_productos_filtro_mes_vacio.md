# v544 — Fix: catálogo de Productos aparecía vacío ("0 productos")

## Causa raíz

`frontend/admin/js/productos.js` inicializaba el estado con:

```js
let mesActivo = new Date().getMonth(); // mes calendario actual
```

Y ese valor se mandaba siempre al RPC `fn_productos_lista` como `p_mes`
(agregado en la migración 350), que filtra por `EXTRACT(MONTH FROM
p.created_at)` — es decir, **filtraba por defecto los productos creados
en el mes calendario en curso**.

El selector de meses (Ene..Dic) en la pantalla de Productos está pensado
como un filtro opcional ("¿qué productos di de alta este mes?"), no como
el estado por defecto del catálogo. El resultado: cualquier empresa que
abra Productos un día en que no haya dado de alta productos nuevos ese
mes ve "0 productos / No se encontraron productos con los filtros
actuales" — aunque tenga cientos de productos cargados en meses
anteriores. Se reprodujo con la captura real del 1° de agosto de 2026
(mes recién empezado, filtro forzado a "Ago", catálogo entero oculto).

## Fix

- `mesActivo` ahora arranca en `null` ("Todos", sin filtro de mes/año).
- Se agregó un tab **"Todos"** al selector de meses (antes solo estaban
  Ene..Dic, no había forma de volver a ver el catálogo completo desde la
  UI una vez elegido un mes).
- `seleccionarMes()` y el listener de inicialización ahora comparan por
  `data-mes` en vez de por índice de posición en la lista de botones
  (el índice se corría al agregar el tab "Todos").
- `cargarProductos()` manda `p_mes`/`p_anio` como `null` cuando el filtro
  activo es "Todos", en vez de forzar siempre un mes/año al RPC.
- Sin cambios en el RPC (`fn_productos_lista`, migración 350) — ya
  soportaba `p_mes`/`p_anio` nulos correctamente; el bug era 100%
  frontend (el default elegido, no el mecanismo de filtrado en sí).

## Archivos tocados

- `frontend/admin/productos.html` (tab "Todos" en el nav de meses)
- `frontend/admin/js/productos.js` (default null, comparación por data-mes)
- `frontend/admin/css/productos.css` (estilo del tab "Todos" + separador)
- `frontend/admin/css/productos-gentelella.css` (mismo separador bajo el
  reskin Gentelella)
