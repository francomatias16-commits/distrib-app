# v583 — Fase 7, paso 8, lote 1: repo de datos de `presupuestos`

Arranca la migración de `lib/handlers/pedidos.js` (3164 líneas, 130
`.from()` al empezar) a la capa de repos, mismo criterio que cerró
`notif.js` en el paso 7: no se migra el archivo entero de una, se parte
por concern.

## Por qué `presupuestos` primero

Es el sub-módulo más autocontenido de todo el archivo: usa las tablas
`presupuestos`/`presupuesto_items` en exclusiva, y ningún otro concern de
`pedidos.js` (confirmación de pedido, chofer, devoluciones, remito) depende
de este código. Sirve además de piloto para el patrón que van a repetir los
próximos lotes: funciones de repo explícitas por `empresa_id`, sin tocar
comportamiento observable.

## Qué se hizo

- **`lib/repos/pedidos.js` (nuevo) — 28 funciones**, agrupadas en:
  - Alta: `obtenerClienteParaPresupuesto`, `contarPresupuestosPorEmpresa`,
    `obtenerConfigEmpresa`, `crearPresupuesto`, `insertarItemsPresupuesto`.
  - Lectura: `obtenerPresupuestoConDetalle`, `listarPresupuestos`,
    `obtenerClientePorUsuarioId`.
  - PATCH / aceptación: `obtenerPresupuestoParaPatch`,
    `bloquearPresupuestoAceptado` (lock optimista v85),
    `obtenerPresupuestoCompleto`, `obtenerClienteCredito`,
    `obtenerStockDepositoPrincipal`, `listarStockOtrosDepositos`,
    `crearPedidoDesdePresupuesto`, `insertarItemsPedidoDesdePresupuesto`,
    `incrementarStockReservadoRpc`, `liberarStockReservadoRpc`,
    `registrarMovimientoStockReserva`, `eliminarItemsPedido`,
    `eliminarPedido`, `revertirPresupuestoAEnviado`,
    `vincularPresupuestoConPedido`, `actualizarPresupuesto`.
  - DELETE: `obtenerPresupuestoParaEliminar`, `eliminarItemsPresupuesto`,
    `eliminarPresupuesto`.
- **Reuso en vez de duplicar**: `resolverPreciosClienteRpc` (RPC
  `resolver_precios_cliente`) ya existía en `lib/repos/whatsapp-bot.js` —
  se reexporta desde `lib/repos/pedidos.js` en vez de crear una copia.
- **Funciones migradas sin cambiar comportamiento observable**:
  `crearPresupuestoParaCliente` (usada por el asistente de ayuda, tool
  `crear_presupuesto`) y `handlePresupuestos` completo — GET (detalle y
  lista, con el chequeo "cliente solo ve lo suyo"), POST admin, PATCH
  (update simple + el flujo grande de aceptación: lock optimista →
  chequeo de crédito → validación de stock principal/fallback → creación
  del pedido → items → reserva de stock con rollback en cada paso si algo
  falla) y DELETE.
- El fix post-Fase-11 documentado en el propio handler (revertir el lock
  optimista si falla la creación del pedido/items/reserva, en vez de dejar
  el presupuesto trabado en 'aceptado' sin pedido real detrás) se replicó
  tal cual — no se tocó lógica de negocio en este lote, solo dónde vive el
  código que arma cada query.

## Tests

- `tests/repos/pedidos.test.js` (nuevo, 29 casos) — cubre las 28 funciones
  del repo. Foco en aislamiento por `empresa_id` (que ninguna función lea/
  edite datos de otra empresa) y en el lock optimista de
  `bloquearPresupuestoAceptado`. Las funciones de rollback/limpieza
  (`registrarMovimientoStockReserva`, `eliminarItemsPedido`,
  `eliminarPedido`, `revertirPresupuestoAEnviado`,
  `vincularPresupuestoConPedido`) se testean como fire-and-forget, mismo
  comportamiento silencioso que tenían en el handler original.
- Suite completa: **671/671 OK** (28 archivos de test previos + el nuevo).
- `node --check` limpio en repo y handler.
- `grep -c "\.from(" lib/handlers/pedidos.js`: 130 → 97 (33 llamadas
  migradas: los `.from()`/`.rpc()` de todo el bloque de presupuestos, cero
  restantes en esa sección).

## Qué queda pendiente en `pedidos.js`

97 `.from()` repartidos en: confirmación de pedido (`confirmarPedidoHandler`,
`crearPedidoParaCliente`, notificaciones), gestión desde el portal del
chofer (`handleChofer`), devoluciones (`crearDevolucionCore`,
`handleDevolucionesAdmin`) y remito (`handleRemitoNro`) — próximos lotes,
mismo criterio de partir por concern y no tocar comportamiento.
