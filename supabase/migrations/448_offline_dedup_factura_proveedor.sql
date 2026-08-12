-- ============================================================
-- 448_offline_dedup_factura_proveedor.sql
--
-- Plan offline — Etapa 3 (cierre): portal proveedor, subir-factura.
--
-- confirmar-entrega (actualizarFechaEsperadaOrden) es un UPDATE sobre
-- ordenes_compra — reintentar la misma acción offline con el mismo
-- payload es naturalmente idempotente, no necesita dedup.
--
-- subir-factura (insertarFacturaProveedorPortal) es un INSERT sobre
-- facturas_proveedor — sin protección, un reintento del outbox (ej. la
-- respuesta se perdió por la red pero el insert ya se había aplicado)
-- duplica la factura. Mismo patrón que 443/444/446 (offline_local_id +
-- índice único parcial).
-- ============================================================

BEGIN;

ALTER TABLE facturas_proveedor
  ADD COLUMN IF NOT EXISTS offline_local_id TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_proveedor_offline_local_id
  ON facturas_proveedor (offline_local_id)
  WHERE offline_local_id IS NOT NULL;

COMMENT ON COLUMN facturas_proveedor.offline_local_id IS
  'ID generado en el dispositivo (crypto.randomUUID()) cuando la factura se '
  'cargó desde el portal de proveedor mientras estaba offline (Plan offline, '
  'Etapa 3). Evita duplicar la factura si el outbox reintenta subir-factura.';

COMMIT;
