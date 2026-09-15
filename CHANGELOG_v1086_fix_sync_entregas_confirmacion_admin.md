# CHANGELOG v1086 — Fix: confirmación de entrega desde "pedidos" no sincronizaba repartos/armar ruta

## Reporte

Al confirmar la entrega de un pedido desde la sección **pedidos** (override
administrativo, sin que el chofer haya confirmado nada desde su portal), el
pedido pasaba a `entregado`, pero en **repartos / armar ruta** seguía
apareciendo como pendiente de entrega.

## Causa

`PATCH /api/pedidos` (forzado de estado por dueño/admin, en
`lib/handlers/pedidos/index.js`) tiene una rama propia para
`estado === 'entregado'` — separada del flujo normal del chofer
(`lib/handlers/pedidos/chofer.js`, `PATCH /api/chofer/remitos → entregar`).

Esa rama llamaba únicamente a `marcarPedidoEntregado()`, que solo actualiza
`pedidos.estado`/`pedidos.fecha_entrega`. Nunca tocaba la tabla `entregas`
—que es la que lee la pantalla de repartos/armar ruta— ni sincronizaba
`rutas.estado`. El flujo del chofer sí hace ambas cosas (`marcarEntregaCompletada`
+ `sincronizarEstadoRuta`), por eso el bug solo se manifestaba cuando la
confirmación se disparaba desde el lado admin.

## Fix

En `lib/handlers/pedidos/index.js`, rama `estado === 'entregado'` del PATCH
admin: después de `marcarPedidoEntregado()`, se agrega el mismo paso de
sincronización que ya usa `chofer.js`:

- `marcarEntregaCompletada(id, { estado: 'entregado', ... })` — actualiza la
  entrega **activa** (`pendiente`/`en_camino`) del pedido en la tabla
  `entregas`.
- `sincronizarEstadoRuta(ruta_id)` — best-effort (no bloquea la respuesta si
  falla), igual que en el flujo del chofer.

Si `marcarEntregaCompletada` falla, se loguea el error pero no se corta la
respuesta: el pedido ya quedó marcado `entregado` (mismo criterio de
"mejor esfuerzo" que el resto del handler para no dejar al admin sin poder
cerrar la operación por un problema de sincronización secundario).

## Archivos modificados

- `lib/handlers/pedidos/index.js`
  - Import de `marcarEntregaCompletada` (desde `../../repos/pedidos.js`) y
    `sincronizarEstadoRuta` (desde `./_helpers.js`).
  - Rama `estado === 'entregado'` del PATCH admin: sincroniza `entregas` y
    `rutas` tras marcar el pedido.

## Nota

No se tocó la rama `estado === 'despachado'` de este mismo PATCH: la fila en
`entregas` se crea recién al armar la ruta (`lib/repos/rutas.js`), no al
despachar, así que no hay el mismo riesgo de desincronización ahí.
