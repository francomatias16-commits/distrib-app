-- PERF-06 parte 2: índices para FKs sin cobertura
BEGIN;

CREATE INDEX IF NOT EXISTS idx_chofer_invitaciones_creado_por ON public.chofer_invitaciones (creado_por);
CREATE INDEX IF NOT EXISTS idx_conteos_stock_deposito_id ON public.conteos_stock (deposito_id);
CREATE INDEX IF NOT EXISTS idx_conteos_stock_usuario_id ON public.conteos_stock (usuario_id);
CREATE INDEX IF NOT EXISTS idx_export_contable_log_usuario_id ON public.export_contable_log (usuario_id);
CREATE INDEX IF NOT EXISTS idx_producto_insumos_insumo_id ON public.producto_insumos (insumo_id);

COMMIT;
