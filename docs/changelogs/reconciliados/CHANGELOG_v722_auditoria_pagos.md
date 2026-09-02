# v722 — Auditoría real (usuario_id): pagos (Mercado Pago)

Continuación directa de v721 (`pos`). Mismo criterio: `usuario_id` explícito
cuando hay un humano detrás del clic, `null` cuando el disparo es el propio
Mercado Pago (webhook, o la respuesta a una consulta de polling) reportando un
cambio de estado — no una acción deliberada de la persona que está mirando la
pantalla. `registrarAuditoriaSilenciosa(...)` best-effort en todos los casos.

## `pagos` (`lib/handlers/pagos.js`)

Confirmado antes de tocar nada: `pagos.js` es exclusivamente la integración con
Mercado Pago (checkout online del portal cliente) — no tiene relación con
`pagos a proveedores`, que vive en otro módulo (`cc_proveedores.js`/
`proveedores.js`, ya con auditoría parcial). Sí toca `cta_cte` directamente: es
el único camino, además del cobro manual desde Cobranzas, que acredita `cta_cte`
en producción.

Write points instrumentados:

- **Conectar cuenta MP** (`guardarConfigMP`) — UPDATE sobre `integraciones_pago`.
  Se audita únicamente metadata no sensible (nickname/site_id de la cuenta,
  `activa`) — el `access_token` nunca se escribe en `audit_log`, ni siquiera
  cifrado.
- **Desconectar cuenta MP** (`desactivarConfigMP`) — UPDATE, `activa: false`.
- **Confirmación de pago** (`verificarPago`, polling desde el cliente, y
  `manejarWebhook`, notificación de MP) — mismo flujo duplicado en ambos
  caminos, instrumentado igual en los dos:
  - UPDATE `transacciones_pago` (cambio de estado pendiente→completado/fallido)
  - UPDATE `pedidos` (confirmación del pedido tras el pago aprobado)
  - INSERT `cta_cte` (acreditación del cobro vía `registrar_cobro_completo`,
    mismo RPC que usa el cobro manual de Cobranzas) — solo se audita si el RPC
    devolvió éxito; si falló, ya queda el log de recuperación manual existente
    y no hay nada que auditar como hecho.

Deuda técnica documentada, no tocada a propósito: la creación de la preferencia
de pago (`_generarPreferenciaPago`, INSERT `transacciones_pago` en estado
`pendiente`) no se instrumentó — es la apertura de un intento de pago, no un
movimiento de dinero confirmado; el criterio de esta serie es auditar hechos
consumados. Cobranzas/cobro manual (mismo RPC `registrar_cobro_completo` desde
`cc_clientes`/admin) sigue sin auditoría propia — sería el siguiente módulo
lógico si se decide extender la cobertura de `cta_cte`.
