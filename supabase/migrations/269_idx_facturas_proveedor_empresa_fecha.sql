-- 269_idx_facturas_proveedor_empresa_fecha.sql
-- Continuación AUDITORIA_FILTROS_v280 — Cc-proveedores server-side.
--
-- Ya existía idx_fp_empresa (empresa_id, created_at DESC), pero la nueva
-- query de accion=facturas ordena/filtra por fecha_factura, no por
-- created_at. Se agrega el índice compuesto que da soporte real al
-- filtro desde/hasta + al ORDER BY fecha_factura DESC.
--
-- Aplicada en vivo contra jgiquzjwoedmzwqgzubr (verificado con pg_indexes
-- antes y después).

CREATE INDEX IF NOT EXISTS idx_fp_empresa_fecha
    ON public.facturas_proveedor (empresa_id, fecha_factura DESC);
