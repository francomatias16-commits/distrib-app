# v807 — Fix: número de pedido en el picker de "Registrar devolución" no coincidía con la lista de /admin/pedidos

## Síntoma
En el modal de alta manual de devolución, el select "Pedido de origen"
mostraba códigos como `Pedido 5c409771`, `Pedido 0a530f11`, `Pedido
f283bcfa` — ninguno de esos códigos aparecía en la lista de
`/admin/pedidos` (que muestra `#20CD0F`, `#99CD98`, etc.), haciendo
imposible saber a qué pedido de la lista correspondía cada opción.

## Causa
Dos recortes distintos del mismo UUID:
- Lista de pedidos (`pedidos.js:532`): `'#' + p.id.slice(-6).toUpperCase()`
  (últimos 6 caracteres).
- Picker de devoluciones (`devoluciones.js:513`, antes del fix):
  `'Pedido ' + p.id.slice(0, 8)` (primeros 8 caracteres, sin uppercase).

No es un bug de datos — el `pedido_id` que se guarda en la devolución
siempre fue el UUID completo y correcto — pero visualmente los dos códigos
nunca coincidían.

## Fix
`frontend/admin/js/devoluciones.js`: el label del `<option>` ahora usa el
mismo formato que la lista de pedidos: `Pedido #${p.id.slice(-6).toUpperCase()}`.

## Archivos modificados
- `frontend/admin/js/devoluciones.js`
