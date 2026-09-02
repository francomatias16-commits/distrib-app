# v351 — Elegir depósito(s) al crear un producto

## Problema

La v346 arregló el bug donde los productos nuevos no aparecían en las
pantallas de Stock (porque las consultas de Stock hacen `INNER JOIN` con
`stock`, y un producto recién creado sin ninguna fila de stock quedaba
invisible). La solución de la v346 fue un trigger que, en cada alta de
producto, creaba automáticamente una fila de stock en 0 en **todos** los
depósitos de la empresa.

Con empresas de varias sucursales (10 depósitos, por ejemplo), esto hacía
que un producto nuevo apareciera 10 veces —una fila en 0 por depósito—
aunque en la práctica solo se vendiera desde 1 o 2. El usuario pidió poder
elegir explícitamente en qué depósito(s) arranca el producto al crearlo,
en vez de duplicarlo automáticamente en todos.

## Cambios

### Base de datos (migración `351_elegir_depositos_al_crear_producto.sql`)

- Se elimina el trigger `trg_productos_crear_stock_inicial` (el de la v346)
  que fanouteaba stock inicial a todos los depósitos en cada `INSERT` sobre
  `productos`. La función que usaba (`fn_productos_crear_stock_inicial`)
  se deja en la base marcada como deprecada, sin borrarla, por si se quiere
  reusar en el futuro.
- Se agrega `fn_crear_producto(p_nombre, p_deposito_ids, p_codigo,
  p_categoria_id, p_precio_base, p_costo, p_stock_minimo, p_activo)`:
  función `SECURITY DEFINER` que crea el producto y una fila de stock en 0
  **solo** en los depósitos pasados en `p_deposito_ids`, en una única
  transacción. Los depósitos recibidos se validan contra la empresa del
  usuario actual (`get_empresa_id()`) para evitar que se pase el uuid de un
  depósito de otra empresa. Si no se recibe ningún depósito válido, la
  función rechaza el alta (`RAISE EXCEPTION`) en vez de crear el producto
  sin stock, para no reintroducir el bug de la v346 (producto invisible en
  Stock por el `INNER JOIN`).
- Los flujos de importación masiva (`025_rpc_importar_productos.sql` y
  afines) ya insertaban stock explícitamente por depósito y no dependían
  del trigger, así que no requieren cambios.

### Frontend (`frontend/admin/productos.html` y `frontend/admin/js/productos.js`)

- El modal de alta de producto (`Productos → +`) suma una sección
  **"Depósitos"** con un checklist de los depósitos de la empresa. El
  depósito marcado como `es_principal` viene pre-tildado; si ninguno está
  marcado como principal, se pre-tilda el primero de la lista para que el
  checklist no arranque vacío.
- Esta sección solo se muestra en el alta. En edición se oculta, porque el
  producto ya existe y el stock por depósito se sigue gestionando desde la
  sección Stock (no cambia nada ahí).
- `guardarProducto()`:
  - **Alta**: en vez de un `insert` directo a `productos` (que antes
    disparaba el trigger de la v346), ahora valida que haya al menos un
    depósito tildado y llama a `fn_crear_producto()` vía RPC.
  - **Edición**: sin cambios — sigue siendo un `update` directo sobre
    `productos`.

## Verificación

- Se confirmó contra la base que el trigger `trg_productos_crear_stock_inicial`
  ya no está en `productos` (quedan solo los triggers de auditoría, código
  y `updated_at`, que no tocan stock).
- Se probó (con `BEGIN`/`ROLLBACK`, sin dejar datos de prueba) que insertar
  un producto y una sola fila de stock para un depósito específico deja
  exactamente **1** fila en `stock` para ese producto, no una por depósito.
- Se revisó que no queden otros `insert` directos a `productos` en el
  frontend que se salteen `fn_crear_producto()`.

## Nota

Este cambio es solo para el alta manual de un producto desde el modal de
Productos. Los productos que ya existían (con sus filas de stock creadas
por el trigger de la v346 antes de este fix) no se tocan — siguen
apareciendo en todos los depósitos donde ya tenían una fila.
