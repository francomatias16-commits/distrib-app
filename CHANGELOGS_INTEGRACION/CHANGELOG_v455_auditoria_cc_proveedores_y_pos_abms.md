# v455 — Auditoría real (usuario_id): pagos a proveedores + ABMs de configuración POS

Continuación directa de v454. Cierra los dos últimos puntos de deuda técnica
documentados en la serie:

- v722: *"Cobranzas/cobro manual... sería el siguiente módulo lógico"* → ya
  cerrado en v454 (cobro manual). Este changelog cierra **cc_proveedores**,
  mencionado en v722 como "ya con auditoría parcial" pero sin una pasada
  dedicada como el resto de la serie.
- v721: *"favoritos, config de hardware, PIN de supervisor, promociones,
  umbral de descuento, movimientos de caja manuales, transferencias de
  stock entre depósitos — son ABMs de configuración/operativa interna...
  Quedan para una pasada aparte si se decide extender la cobertura."*

Mismo criterio de toda la serie: `usuario_id` explícito cuando hay un humano
detrás del clic, `registrarAuditoriaSilenciosa(...)` best-effort (nunca
rompe el flujo si `audit_log` falla).

## `cc_proveedores` (`lib/handlers/cc_proveedores.js`)

Se instrumentaron los 3 write points reales sobre facturas y pagos a
proveedores (el módulo ya tenía auditoría *indirecta* en `proveedores.js`,
pero no en este handler):

- **Crear factura de proveedor** (POST `?accion=factura`) — INSERT, un
  único registro de auditoría por alta (cubre cabecera + ítems + la
  conciliación automática si aplica, mismo criterio que "Registrar venta"
  en `pos.js`: un hecho de negocio, un registro).
- **Editar factura de proveedor** (PATCH `?accion=factura`) — UPDATE. Se
  reutilizó la consulta que el propio handler ya hacía para validar que la
  factura no tenga pagos registrados, en vez de duplicarla, para capturar
  el estado anterior sin un round-trip extra a la base.
- **Registrar pago a proveedor** (POST `?accion=pago` → RPC
  `registrar_pago_proveedor`) — dinero real saliendo. A diferencia del
  cobro manual (v454), este RPC **sí** se llama siempre a través de este
  handler (confirmado: no hay ninguna llamada directa desde el frontend a
  `registrar_pago_proveedor`), así que se audita en JS con el patrón
  estándar de la serie. El RPC no devuelve el id de la fila insertada en
  `pagos_proveedor`, así que se usa `factura_id` como `registro_id` —mismo
  criterio que usar el id de la entidad relacionada cuando el write point
  no expone un id propio.

No tocado a propósito: `conciliar_oc_factura` (RPC de conciliación
automática/manual) — es un cálculo de discrepancias que actualiza la
factura con su resultado, no un movimiento de dinero ni un alta/baja; queda
fuera del criterio "hecho consumado" de esta serie, igual que la creación de
preferencia de pago en `pagos.js` (v722).

## ABMs de configuración de POS (`lib/handlers/pos.js`)

Se instrumentaron los 8 write points de configuración/operativa interna que
v721 había dejado fuera de alcance a propósito:

- **Favoritos** (alta/baja) — INSERT/DELETE sobre `favoritos_pos`.
- **Movimientos de caja manuales** (sangría/refuerzo/retiro final) —
  INSERT sobre `movimientos_caja`. A diferencia de los favoritos/config,
  acá sí hay dinero real moviéndose fuera del flujo de venta — mismo
  espíritu que "Registrar venta"/"Anular venta" de v721, solo que había
  quedado afuera de esa pasada por estar named como "operativa interna" en
  el changelog original.
- **ABM de cajas** (crear/editar/activar/desactivar) — INSERT/UPDATE sobre
  `cajas_pos`.
- **Umbral de descuento por cajero** — UPDATE sobre `usuarios`.
- **Config de hardware** (impresora/terminal) — UPDATE sobre
  `empresas.config`, con el objeto `pos_hardware` completo antes/después.
- **PIN de supervisor** (activar/desactivar) — UPDATE sobre `empresas`.
  Se audita únicamente el hecho (`pin_supervisor_activo: true/false`) —
  el PIN ni su hash se escriben nunca en `audit_log`, mismo criterio que
  el `access_token` de Mercado Pago en `pagos.js` (v722).
- **Promociones** (crear/editar/eliminar/toggle) — INSERT/UPDATE/DELETE
  sobre `promociones`.
- **Transferencias de stock entre depósitos** — UPDATE (vía RPC
  `transferir_stock_entre_depositos`, confirmado sin llamadas directas
  desde el frontend, mismo chequeo que se hizo para
  `registrar_pago_proveedor`).

Con v454 + v455, las dos piezas de deuda técnica documentadas en toda la
serie ("Auditoría real — usuario_id") quedan cerradas. No queda ningún
punto pendiente marcado explícitamente en los changelogs v720-v722/v724.
