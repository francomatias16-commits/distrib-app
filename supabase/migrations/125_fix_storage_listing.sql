-- 125_fix_storage_listing.sql
-- Corrige la política de listado público en storage buckets.
-- Idempotente.

-- Asegurar que el bucket 'logos' existe y no es público
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'logos', 'logos', false,
  2097152,  -- 2MB
  ARRAY['image/png','image/jpeg','image/webp','image/svg+xml']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 2097152,
  allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp','image/svg+xml'];

-- Política: solo el admin de la empresa puede subir su logo
DROP POLICY IF EXISTS "logos_upload" ON storage.objects;
CREATE POLICY "logos_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'logos'
    AND (storage.foldername(name))[1] = public.get_empresa_id()::text
  );

-- Política: cualquier usuario autenticado puede leer logos (para mostrar en la UI)
DROP POLICY IF EXISTS "logos_read" ON storage.objects;
CREATE POLICY "logos_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'logos');

-- Política: solo el admin puede actualizar/borrar su logo
DROP POLICY IF EXISTS "logos_delete" ON storage.objects;
CREATE POLICY "logos_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'logos'
    AND (storage.foldername(name))[1] = public.get_empresa_id()::text
  );
