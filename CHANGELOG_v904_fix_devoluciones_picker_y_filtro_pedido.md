# v904 — Devoluciones: alta manual no permitía agregar productos + filtro por pedido de origen

## Contexto de la captura enviada
La pantalla de la captura (buscador de productos sin foto, sin precio, sin
input de cantidad ni botón "Agregar" — solo el nombre en una cajita) **no
corresponde a la versión actual del código**. La propia barra de título de
la app en la captura muestra "Actualización de aplicación disponible": es
una versión cacheada vieja del picker de productos, de antes de que existiera
el botón "Agregar" por card. Por eso el clic no hacía nada — en esa versión
vieja esos textos no tenían ningún listener enganchado.

**Acción recomendada:** aceptar la actualización de la app (o hacer un
refresco forzado, Ctrl+Shift+R) antes de volver a probar. Además, para
evitar que vuelva a pasar, se subió el número de versión (`?v=904`) de los
archivos del picker en `devoluciones.html` y `pedidos.html`, para forzar que
el navegador/PWA baje la versión nueva en vez de servir la cacheada.

## Cambio 1 — Toda la card del producto agrega, no solo el botón chico
Aun con la versión correcta del picker, el botón "Agregar" es chico y en
modales angostos puede pasar desapercibido. Ahora **hacer clic en cualquier
parte de la card** (nombre, imagen, precio) agrega el producto con la
cantidad que esté cargada en ese momento — el input de cantidad sigue
siendo editable sin disparar el alta al tocarlo.

- `frontend/admin/js/producto-picker.js`: nuevo listener de click a nivel
  de card, con `stopPropagation()` en el botón y en el input de cantidad
  para no duplicar el alta.
- `frontend/admin/css/producto-picker.css`: `cursor: pointer` en toda la
  card para que se note que es clickeable.

Este componente es compartido con Pedidos y Presupuestos, así que el mismo
beneficio aplica ahí también.

## Cambio 2 — Filtrar por el pedido de origen elegido (pedido, no solo cliente)
Antes, elegir un "Pedido de origen" en el alta manual **no hacía nada** —
el buscador de productos seguía mostrando todo el historial de compras del
cliente, obligando a revisar productos que ni estaban en esa entrega
puntual.

Ahora, al elegir un pedido:
- El buscador de productos se restringe a **solo los productos de ese
  pedido**.
- Si se vuelve a "Sin vincular a un pedido", cae de nuevo al historial
  completo de compras del cliente (comportamiento anterior).
- Los ítems ya agregados que no pertenezcan al pedido recién elegido se
  sacan automáticamente de la lista de "seleccionados".
- Si falla la consulta al pedido puntual (red, etc.), no se deja al admin
  sin nada para elegir: cae al historial completo del cliente como
  respaldo.
- El mensaje de "sin resultados" del buscador ahora distingue si está
  vacío por cliente ("Este cliente no tiene productos comprados para
  devolver") o por pedido ("Ese pedido no tiene productos para
  devolver").

### Archivos modificados
- `frontend/admin/js/devoluciones.js`
  - Nueva función `ndFiltrarPickerPorPedido()`, enganchada al `onchange`
    del select de pedido.
  - `ndDesbloquearPickerParaCliente()` ahora pasa el contexto `'cliente'`
    a `setSoloPermitidos()`.
- `frontend/admin/js/producto-picker.js`
  - `setSoloPermitidos(productos, contexto)` acepta un segundo parámetro
    opcional (`'cliente'` | `'pedido'`) para elegir el mensaje vacío
    correcto.
  - Click en toda la card agrega el producto (ver Cambio 1).
- `frontend/admin/css/producto-picker.css`
  - `cursor: pointer` en `.pp-card`.
- `frontend/admin/devoluciones.html`
  - `onchange="ndFiltrarPickerPorPedido()"` en `#nd-pedido`.
  - Bump de versión (`?v=904`) en `producto-picker.css`, `producto-picker.js`
    y `devoluciones.js` para evitar caché vieja.
- `frontend/admin/pedidos.html`
  - Mismo bump de versión en `producto-picker.css`/`.js` (componente
    compartido).

## Validación
`node --check` en `devoluciones.js` y `producto-picker.js` → OK.
Verificado que `onchange="ndFiltrarPickerPorPedido()"` quedó en el HTML y
que la función está expuesta en `window`.

## Pendiente / a probar en caliente
1. Confirmar que, tras actualizar la app, al elegir un pedido puntual el
   buscador ya solo muestra sus productos.
2. Confirmar que un clic en cualquier parte de la card (no solo el botón)
   agrega el producto correctamente, sin duplicados.
