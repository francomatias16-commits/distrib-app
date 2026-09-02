# v532 — Auditoría Cobranzas ↔ Caja/POS

Sesión de auditoría a pedido del dueño: "no se guarda el modal de cobros" +
"por qué figura un cliente si la venta fue de mostrador".

## Bugs encontrados y corregidos

1. **`frontend/admin/js/cta-cte.js` — `guardarCobro()`**
   - La RPC `registrar_cobro_completo` devuelve el número de comprobante en
     la clave `nro`, no `numero`. El toast de éxito mostraba literalmente
     "Cobro undefined registrado" — parecía un error aunque el cobro se
     había guardado bien.
   - Después de guardar, `abrirCliente()` podía disparar un toast de error
     ("No se encontró el cliente...") tapando al de éxito, cuando el cobro
     recién registrado saldaba al cliente y este salía de la página actual
     de "Saldos por cliente". Ahora solo se reabre el panel si el cliente
     sigue en la lista recargada.

2. **`anular_venta_pos` (migración 429)**
   - La migración 416 documentaba en el comentario que bloqueaba la
     anulación de ventas ya facturadas, pero el cuerpo real de la función
     seguía sin implementarlo: dependía de `ventas_pos.factura_id`, columna
     que queda `NULL` aunque la venta tenga factura (la relación confiable
     es `facturas.venta_pos_id`).
   - Consecuencia verificada en producción: se anulaban ventas con factura
     ya emitida sin pasar por Nota de Crédito, y la factura vinculada
     quedaba "pendiente" para siempre — visible en Cobranzas como deuda
     real de un cliente, aunque el crédito compensatorio en `cta_cte` ya
     la hubiera saldado. Caso real corregido a mano:
     `41a96ee7-b08d-4b8b-8c2b-bf63ea499873` ($7.106,33).
   - Fix: busca la factura por ambos lados de la relación y, si no tiene
     CAE, la marca `anulada` junto con la venta.

3. **Trigger `trg_sincronizar_cobrado_factura_pos` (migración 430)**
   - El cálculo de "cuánto ya se cobró en caja" al emitir una factura de
     venta POS vivía solo en `lib/facturas.js` (Node). Si fallaba ahí (bug,
     deploy a medias, factura creada por una ruta de código vieja), la
     factura nacía marcada `pendiente` con `total_cobrado = 0` aunque la
     venta ya estuviera 100% cobrada en el momento.
   - Caso real encontrado: factura de la venta POS-20260720-00014
     (consumidor final, $1.210 en efectivo) con `total_cobrado = 0`.
   - Fix: trigger `BEFORE INSERT` en `facturas` que recalcula
     `total_cobrado` en la base de datos misma para toda factura ligada a
     `venta_pos_id` — independiente de que el código de la app lo calcule
     bien. Incluye backfill retroactivo de las facturas ya afectadas.

## Confirmado, no era bug

- Una venta de consumidor final (sin cliente, sin cuenta corriente) nunca
  toca `cta_cte` ni aparece en Cobranzas — ya estaba bien diseñado en
  `registrar_venta_pos` (solo debita cuenta corriente si hay cliente y el
  medio es `cuenta_corriente`). Los dos fixes de arriba tapan los huecos
  que, indirectamente, podían simular ese síntoma.
