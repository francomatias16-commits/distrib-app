# v806 — Fix: toast de error invisible detrás del modal de alta manual (devoluciones)

## Síntoma
"No pasa nada al cliquear Registrar devolución." El botón parecía no hacer
nada — sin mensaje de error, sin cierre de modal, sin feedback visible.
Runtime logs mostraban el POST llegando y devolviendo 400 repetidamente (el
usuario reintentaba porque no veía ninguna respuesta).

## Causa real
El backend estaba funcionando como corresponde: la validación de v805
(cantidad ≤ disponible, producto perteneciente al pedido, etc.) rechazaba la
request con 400 + mensaje de error específico. El frontend (`devoluciones.js
→ guardarNuevaDevolucion`) sí capturaba el error y llamaba a
`mostrarToast(e.message, 'err')` correctamente.

El problema era puramente visual: el FIX v799 (modal que se cerraba solo al
tocar un `<select>`) le dio a `#modal-nueva-devolucion` / `#modal-backdrop-
devolucion` `z-index: 1001` / `1000 !important`, muy por encima del
`z-index: 600` (`--z-toast`) del toast global de `tokens.css`. Como el modal
queda abierto tras un error (solo se cierra en el `if (!data?.ok)` — o sea,
nunca en el path de error), el toast se renderizaba pero quedaba tapado
detrás del modal. El mensaje de error existía en el DOM, era invisible.

## Fix
`frontend/admin/css/devoluciones-gentelella.css`: el override existente de
`.toast` para esta página ahora suma `z-index: 1002 !important`, por encima
del modal (1001) y su backdrop (1000).

## Mismo bug encontrado en productos (corregido acá también)
`#modal-producto` y sus sub-modales (`productos-modal-fix.css`) usan
`z-index: 9999` a `10001 !important`, y esa página tampoco tenía override
de `.toast`. Cualquier error mostrado con el modal de producto abierto
(guardar producto, crear categoría, agregar insumo a receta, etc. — todos
usan `toast()` en `productos.js`) quedaba igual de tapado.

## Archivos modificados
- `frontend/admin/css/devoluciones-gentelella.css`
- `frontend/admin/css/productos-modal-fix.css`
