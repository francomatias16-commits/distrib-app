# Auditoría de integridad — Fase 3: pedido → factura → cta_cte → cobro
Fecha: 2026-07-03

## Resumen
Se auditó el flujo pedido → factura → cta_cte → cobro contra el código del
repo Y contra el estado real de la base (Supabase, proyecto
`jgiquzjwoedmzwqgzubr`), ya que se detectó que `supabase/migrations/*.sql`
y `docs/schema-snapshots/*` **no reflejan el estado real de producción**
(ver nota al final).

## Cambios aplicados en la base (ya en vivo)

1. **Migración `unificar_monto_importe_cta_cte`**
   - `cta_cte` tenía dos columnas de monto (`monto` NOT NULL, `importe`
     nullable) desincronizadas según quién escribía.
   - Se hizo backfill (`monto = importe` donde `monto` estaba vacío — 0 filas
     afectadas al momento de aplicar).
   - Se reescribieron `registrar_cobro_completo` y `emitir_nota_cta_cte`
     para escribir solo `monto`.
   - La columna `importe` queda marcada `DEPRECATED` vía `COMMENT ON COLUMN`,
     sin dropear todavía por seguridad (nada la escribe ya, pero no se
     confirmó que nada externo la *lea* directo por REST).

2. **Nueva función `asentar_movimiento_cta_cte_factura(p_factura_id, p_tipo,
   p_monto, p_descripcion)`**
   - Reemplaza el patrón de "INSERT suelto desde Node después de la llamada
     a ARCA", que podía perderse en silencio si fallaba.
   - Es transaccional, valida la factura y el tenant, y es **idempotente**
     (no duplica el asiento si se reintenta la misma factura/tipo).

3. **Nueva función `anular_venta_pos(p_venta_pos_id, p_usuario_id, p_motivo)`**
   - Revierte stock, registra movimientos, acredita `cta_cte` si el pago
     fue en cuenta corriente, y marca la venta como anulada — todo en una
     sola transacción, con `FOR UPDATE` e idempotencia (no repite la
     reversión si la venta ya estaba anulada).

## Cambios aplicados en el código — ronda 1

| Archivo | Qué cambió |
|---|---|
| `lib/facturas.js` | `emitirFactura()` ahora llama a `asentar_movimiento_cta_cte_factura` en vez de insertar directo en `cta_cte`. |
| `lib/arca/wsfev1.js` | `emitirNotaCreditoARCA()` ídem, para el crédito de la Nota de Crédito. |
| `lib/handlers/pagos.js` | El webhook de Mercado Pago (`manejarWebhook`) ahora registra el cobro en `cta_cte` vía `registrar_cobro_completo` y llama a `desbloquearSiSaldado()` (antes código muerto, nunca invocado). |
| `lib/handlers/pedidos.js` | Cancelar un pedido con factura `estado='emitida'` (con CAE real de ARCA) ya no pisa el estado a `'anulada'` directo — dispara el circuito real de Nota de Crédito (`anularFactura`). Solo las facturas `'pendiente'` (sin CAE) se anulan directo. |

## Cambios aplicados en el código — ronda 2

| Archivo | Qué cambió |
|---|---|
| `lib/handlers/pos.js` | `anularVentaHandler` ahora llama a la RPC `anular_venta_pos` en vez del loop suelto de SELECT/UPDATE/INSERT por ítem (Hallazgo 6). |
| `lib/handlers/cc_proveedores.js` | El PATCH de `facturas_proveedor` solo permite pasar directo a `estado='pendiente'`; `parcial`/`pagada`/`anulada` quedan reservados a `registrar_pago_proveedor` / `conciliar_oc_factura` (Hallazgo 7). Verificado el whitelist contra el `CHECK constraint` real (`facturas_proveedor_estado_check`). |


## Nota importante para las próximas fases de la auditoría

`docs/schema-snapshots/public_schema_full.sql` está desactualizado: incluye
una tabla `movimientos_cta_cte` que **no existe** en la base real, y no
refleja parches aplicados directamente en producción (ej. las versiones
reales de `registrar_cobro_completo` y `emitir_nota_cta_cte` no coinciden
con `supabase/migrations/011_fase1_transacciones.sql` ni `038_fix_consistencia_v39.sql`).
Se recomienda regenerar ese snapshot antes de usarlo como fuente de verdad
en la Fase 1.
