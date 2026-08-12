# CHANGELOG v684 — Fase 7: tests dedicados al circuito de creación/confirmación de pedido

## Contexto

El Paso 8 de Fase 7 (`pedidos.js` → repo de datos) quedó completo en la
entrega anterior (v683), incluyendo el lote 4 sub-lote 3 (creación/
confirmación de pedido: `verPedidoSugeridoHandler`,
`confirmarPedidoSugeridoHandler`, `crearPedidoParaCliente`,
`crearPedidoAdminHandler`, `confirmarPedidoHandler`). Ese sub-lote se migró
sin sumar tests propios — quedó cubierto solo indirecto por la suite
existente (671/671 OK en ese momento), con la nota explícita en
`FASE7_PLAN_ARRANQUE.md` de que faltaban casos dedicados. Esta entrega
cierra ese pendiente.

## Detalle

Nuevo `tests/repos/pedidos-creacion.test.js` (16 casos), foco en:

- **Rutas públicas sin sesión** (`ver-sugerido`, `confirmar-sugerido`,
  checkout de pago): `obtenerPedidoSugeridoDetalle`,
  `obtenerPedidoParaConfirmarSugerido`, `obtenerPedidoParaPagoPublico` y
  `confirmarPedidoSugeridoRpc` — estas funciones son la única barrera antes
  de invocar RPCs con `service_role`, así que se verifica que resuelven
  `empresa_id`/`cliente_id` server-side desde el `pedido_id`, nunca
  aceptándolos del caller.
- **Aislamiento cross-tenant**: `obtenerClienteParaPedido`,
  `obtenerClientePorIdParaConfirmar` y `obtenerClientePorEmailParaConfirmar`
  — casos explícitos de "cliente/email que existe pero en otra empresa no
  matchea" (mismo patrón que el resto de los tests de repos de esta fase).
- **Resolución de perfil**: `obtenerPerfilParaCrearPedidoAdmin` (modal
  admin) y `obtenerUsuarioParaConfirmarPedido` (portal cliente, incluyendo
  el caso `cliente_id` nulo para usuarios legacy resueltos por email).
- **Validación de stock**: `listarStockParaValidarPedido`.
- **Limpieza post-confirmación**: `vaciarCarritoCliente` — caso
  fire-and-forget, se verifica que no lanza si la tabla devuelve error
  (mismo criterio best-effort del handler original).

No se tocó lógica de negocio ni el handler — solo se agregó cobertura
sobre funciones del repo que ya existían desde v683.

## Validación

`npx vitest run`: **964/964 OK** (948 previos + 16 nuevos). Sin fallas
preexistentes en esta corrida (a diferencia de la nota de v612 sobre un
posible mismatch de versión de Node — no se reprodujo acá).

Con esto queda cerrado el único pendiente explícito que dejó anotado el
Paso 8 de Fase 7. El resto de los frentes pendientes del plan ERP son
Fase 8 (observabilidad continua, arrancada en v599 pero no consolidada del
todo).
