-- ============================================================
-- MIGRACIÓN 087 — Columna factura_origen_id en facturas
--   Referencia a la factura original cuando el registro es
--   una Nota de Crédito (tipo NC_C). wsfev1.js la escribe al
--   emitir la NC; permite trazabilidad bidireccional.
-- ============================================================

ALTER TABLE public.facturas
  ADD COLUMN IF NOT EXISTS factura_origen_id UUID REFERENCES public.facturas(id);

CREATE INDEX IF NOT EXISTS idx_facturas_origen
  ON public.facturas (factura_origen_id)
  WHERE factura_origen_id IS NOT NULL;

COMMENT ON COLUMN public.facturas.factura_origen_id IS
  'UUID de la factura original que esta NC anula. NULL para facturas normales.';

COMMIT;
