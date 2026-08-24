# v808 — Indicador de devolución en /admin/pedidos

## Motivación
Antes, un pedido `entregado` con una devolución asociada (aprobada,
pendiente o rechazada) se veía exactamente igual que cualquier otro pedido
en /admin/pedidos — el módulo de pedidos no tenía ninguna noción de
devoluciones. Para saber si un pedido tuvo devolución había que ir a
/admin/devoluciones y cruzar manualmente el `pedido_id` contra la lista de
pedidos (cruce que además era confuso hasta v807, por el mismatch de
formato del id — ver changelog anterior).

## Qué se agregó

### Backend
- `lib/repos/pedidos.js`:
  - `obtenerEstadoDevolucionPorPedidos(empresa_id, pedidoIds)` — batch,
    un solo round-trip para toda una página de la lista de pedidos.
    Devuelve `Map<pedido_id, estado>` (la devolución más reciente si hay
    varias).
  - `listarDevolucionesDePedido(empresa_id, pedido_id)` — todas las
    devoluciones de un pedido puntual, para el detalle.
  - `listarDevolucionesFiltradas` ahora acepta `pedido_id` como filtro
    directo.
- `lib/handlers/pedidos.js`:
  - `GET /api/admin/pedidos` (lista): cada fila trae `devolucion_estado`.
  - `GET /api/admin/pedidos?id=`: el payload trae `devoluciones: [...]`
    con el detalle completo.
  - `GET /api/admin/devoluciones?accion=listar`: acepta `pedido_id` en la
    query string.

### Frontend
- `/admin/pedidos` (tabla): chip junto al estado — "Con devolución"
  (info/azul), "Devolución pendiente" (warning/ámbar) o "Devolución
  rechazada" (gris) — clickeable, lleva a
  `/admin/devoluciones?pedido_id=<uuid>`.
- `/admin/pedidos` (modal de detalle): nueva sección "Devoluciones de
  este pedido" listando motivo/fecha/estado de cada una, con link "Ver
  detalle en Devoluciones →". Se consulta vía RLS directo (mismo patrón
  que la sección de notificaciones e ítems del pedido), no depende de que
  el pedido haya venido de la lista paginada.
- `/admin/devoluciones`: soporta `?pedido_id=` en la URL — filtra la
  lista a ese pedido puntual y muestra un banner "Mostrando devoluciones
  del pedido #XXXXXX" con botón para volver a la vista completa.

## No modificado
Sigue sin haber ningún `UPDATE` sobre la tabla `pedidos` al aprobar/
rechazar una devolución — el `estado` del pedido (`entregado`, etc.) no
cambia. Esto es solo un indicador de lectura; el flujo transaccional real
de v805/v806/v807 no se tocó.

## Archivos modificados
- `lib/repos/pedidos.js`
- `lib/handlers/pedidos.js`
- `frontend/admin/js/pedidos.js`
- `frontend/admin/pedidos.html`
- `frontend/admin/js/devoluciones.js`
- `frontend/admin/devoluciones.html`
