# v721 — Auditoría real (usuario_id): POS (ventas de mostrador)

Continuación directa de v720 (`pedidos`). Mismo criterio: `usuario_id` explícito
cuando hay un humano detrás del clic, `registrarAuditoriaSilenciosa(...)` best-effort
(nunca rompe el flujo si `audit_log` falla).

## `pos` (`lib/handlers/pos.js`)

`pos.js` ya tenía cobertura indirecta vía `emitirFactura()` (que audita `facturas`)
en el camino de facturación automática/manual, pero el núcleo transaccional del
flujo de venta de mostrador — donde se mueve la plata real — no tenía rastro
propio. Se instrumentaron los 3 write points centrales:

- **Registrar venta** (`registrarVentaHandler` → `registrarVentaPosRpc`) — INSERT
  sobre `ventas_pos`. Se omite en reintentos de sync offline (`ya_existia`) para
  no loguear dos veces la misma venta real — mismo criterio que la idempotencia
  de `pedidos.js`.
- **Anular venta** (`anularVentaHandler` → `anularVentaPosRpc`) — UPDATE, guarda
  el `motivo` de anulación (obligatorio en el handler).
- **Devolución** (`devolucionHandler` → `rpc_registrar_devolucion_pos`) — INSERT
  sobre `devoluciones_pos`, con los ítems devueltos.

Deuda técnica documentada, no tocada a propósito (fuera del alcance "dinero real
moviéndose"): favoritos, config de hardware, PIN de supervisor, promociones,
umbral de descuento, movimientos de caja manuales, transferencias de stock entre
depósitos — son ABMs de configuración/operativa interna, no transacciones de
venta. Quedan para una pasada aparte si se decide extender la cobertura.
