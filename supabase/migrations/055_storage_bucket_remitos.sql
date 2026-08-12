-- ============================================================
-- 055_storage_bucket_remitos.sql
-- Etapa 8.3: Bucket de Storage para fotos de remitos
-- ============================================================

-- Crear bucket 'remitos' (público para URLs directas sin firma)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'remitos',
  'remitos',
  true,
  10485760,  -- 10 MB máximo por archivo
  ARRAY['image/jpeg','image/png','image/webp','image/heic','application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public            = EXCLUDED.public,
  file_size_limit   = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Política: solo service_role sube (el backend autentica y sube)
DROP POLICY IF EXISTS remitos_insert_service ON storage.objects;
CREATE POLICY remitos_insert_service ON storage.objects
  FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'remitos');

DROP POLICY IF EXISTS remitos_update_service ON storage.objects;
CREATE POLICY remitos_update_service ON storage.objects
  FOR UPDATE TO service_role
  USING (bucket_id = 'remitos');

-- Política: lectura pública (la URL ya es pública)
DROP POLICY IF EXISTS remitos_select_public ON storage.objects;
CREATE POLICY remitos_select_public ON storage.objects
  FOR SELECT USING (bucket_id = 'remitos');

-- Política: borrado solo para dueno/admin via service_role
DROP POLICY IF EXISTS remitos_delete_service ON storage.objects;
CREATE POLICY remitos_delete_service ON storage.objects
  FOR DELETE TO service_role
  USING (bucket_id = 'remitos');
