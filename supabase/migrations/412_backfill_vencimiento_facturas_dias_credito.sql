-- ============================================================
-- 412_backfill_vencimiento_facturas_dias_credito.sql
--
-- Contexto: facturas.vencimiento nunca se completaba en NINGÚN flujo de
-- facturación (ni pedidos ni POS) — lib/facturas.js ahora lo hace en cada
-- factura nueva (fecha_emision + clientes.dias_credito), pero las
-- facturas YA EMITIDAS antes de este fix quedan con vencimiento NULL para
-- siempre, invisibles en Cobranzas (fn_cobranzas_facturas / fn_cta_cte_lista
-- filtran explícitamente por vencimiento no nulo) aunque tengan deuda real
-- pendiente de cobro.
--
-- Este backfill:
--   1) Completa vencimiento = fecha_emision::date + dias_credito del
--      cliente, SOLO para facturas con vencimiento NULL y que todavía
--      tienen saldo pendiente (estado emitida/parcial, total > total_cobrado).
--   2) No toca facturas ya anuladas, pendientes de emitir (sin CAE todavía)
--      ni las que ya tenían vencimiento cargado.
--   3) Es idempotente — puede correrse de nuevo sin duplicar ni pisar
--      datos ya completados.
-- ============================================================

BEGIN;

UPDATE public.facturas f
SET    vencimiento = (f.fecha_emision::date + COALESCE(c.dias_credito, 0))
FROM   public.clientes c
WHERE  f.cliente_id = c.id
  AND  f.vencimiento IS NULL
  AND  f.fecha_emision IS NOT NULL
  AND  f.estado IN ('emitida', 'parcial')
  AND  GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0;

COMMIT;
