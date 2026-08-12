-- ============================================================================
-- 094_innovacion10_portal_proveedor_columnas.sql
-- Innovación #10 — Autogestión de Proveedores ("Vidriera Inversa")
--
-- El handler lib/handlers/portal_proveedor.js, la tabla proveedor_portal_tokens
-- y la RPC validar_token_portal_proveedor ya existían desde
-- supabase/migrations/053_portal_proveedor.sql.
--
-- Este archivo agrega lo que faltaba para que el handler funcione en prod:
--   1. ordenes_compra.confirmada_por_proveedor + fecha_confirmacion_at
--   2. facturas_proveedor.origen
--   3. Storage bucket facturas-proveedor (se crea por SQL en storage.buckets)
-- ============================================================================

-- 1. ordenes_compra: el proveedor puede confirmar/ajustar la fecha de entrega
ALTER TABLE public.ordenes_compra
  ADD COLUMN IF NOT EXISTS confirmada_por_proveedor  boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fecha_confirmacion_at     timestamp with time zone;

COMMENT ON COLUMN public.ordenes_compra.confirmada_por_proveedor IS
  'true cuando el proveedor confirmó la fecha desde el portal de autogestión (#10).';
COMMENT ON COLUMN public.ordenes_compra.fecha_confirmacion_at IS
  'Timestamp de la última confirmación de fecha por parte del proveedor vía portal.';

-- 2. facturas_proveedor: distinguir las cargadas por el proveedor desde las del admin
ALTER TABLE public.facturas_proveedor
  ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'admin'
    CHECK (origen IN ('admin', 'proveedor'));

COMMENT ON COLUMN public.facturas_proveedor.origen IS
  'admin = cargada por el equipo interno. proveedor = autocargada desde el portal (#10). Las de origen=proveedor quedan estado=pendiente hasta que el admin las revise.';

-- 3. Storage bucket para archivos PDF/imagen de facturas del proveedor
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'facturas-proveedor',
  'facturas-proveedor',
  true,           -- público: las URLs en archivo_url funcionan sin auth
  8388608,        -- 8MB, igual que el límite en el handler
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Policies de storage
CREATE POLICY "facturas_proveedor_public_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'facturas-proveedor');

CREATE POLICY "facturas_proveedor_no_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'facturas-proveedor' AND auth.role() = 'service_role');

-- Registrar en registry
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_en, notas)
VALUES (
  'db',
  '094_innovacion10_portal_proveedor_columnas.sql',
  94,
  NOW(),
  'Innovación #10 completa: ADD COLUMN ordenes_compra.confirmada_por_proveedor+fecha_confirmacion_at, facturas_proveedor.origen, bucket facturas-proveedor. Handler+tokens+RPC ya existían desde 053.'
)
ON CONFLICT (carpeta, archivo) DO UPDATE SET aplicada_en = NOW();
