# v720 — Auditoría real (usuario_id): pedidos

Continuación directa de v719. Mismo criterio en todos los módulos: `usuario_id`
explícito en `audit_log` cuando hay un humano detrás del clic, `null` cuando el
disparo es automático o no hay un `usuarios.id` interno con qué completarlo (ej.
confirmación por link de WhatsApp sin login) — `null` representa "lo disparó el
sistema/un tercero sin cuenta", no "no se sabe quién fue".

Todos los `registrarAuditoriaSilenciosa(...)` son best-effort (nunca rompen el
flujo si `audit_log` falla), mismo helper de `lib/repos/audit.js`.

## `pedidos` (`lib/handlers/pedidos.js`)

Módulo con mayor volumen de escritura de todo el sistema y sin ninguna auditoría
propia hasta esta etapa. Se instrumentaron los 11 write points reales sobre la
tabla `pedidos` (se excluyen a propósito los updates a `entregas`, `devoluciones`
y `presupuestos` — quedan para sus propios módulos):

- `PATCH` actualizar estado (admin) — UPDATE
- `DELETE ?accion=eliminar` (borrado físico) — DELETE
- `DELETE` cancelar — UPDATE (estado=cancelado)
- Confirmación desde link de WhatsApp sin login (`confirmarPedidoSugeridoHandler`)
  — UPDATE, `usuario_id: null` (no hay cuenta interna del cliente que confirma)
- `crearPedidoParaCliente` (función compartida entre alta admin y portal cliente)
  — INSERT, un único punto de auditoría para las 2 formas de llegar a esta función
- Confirmación de pedido desde el portal cliente (crea vía RPC) — INSERT
- Aceptar presupuesto → crea pedido en firme (`crearPedidoDesdePresupuesto`) —
  INSERT, ubicado después de las dos compensaciones de rollback (items, stock)
  para no auditar una fila que termina borrándose si algo falla antes
- Portal del chofer — despachar (`marcarPedidoDespachado`) — UPDATE
- Portal del chofer — entregar (`marcarPedidoEntregado`) — UPDATE, incluye
  `cobro_id` si hubo cobro asociado
- Portal del chofer — no entregar (`revertirPedidoAConfirmado`) — UPDATE, incluye
  `motivo_no_entrega`
- Reserva de número de remito (`reservarRemitoNroRpc`) — UPDATE

Deuda técnica documentada, no tocada a propósito (siguiente etapa según prioridad
acordada): `pos.js` (ventas de mostrador, ~30 write points, ya usa
`emitirFactura()` pero el resto del flujo no tiene auditoría propia).
