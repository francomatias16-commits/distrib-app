-- ============================================================
-- db/023_logo_storage.sql
-- Storage bucket para logos de empresa + políticas de acceso
-- Ejecutar en Supabase SQL Editor DESPUÉS de 001_schema.sql
-- MF Web Solutions | distrib-app
-- ============================================================

-- ── 1. Crear bucket 'logos' ───────────────────────────────────────────────
-- Si ya existe, este bloque no falla
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'logos',
  'logos',
  true,                              -- público: las URLs son accesibles sin auth
  5242880,                           -- 5 MB máximo por archivo
  ARRAY['image/png','image/jpeg','image/webp','image/svg+xml']
)
ON CONFLICT (id) DO UPDATE SET
  public            = EXCLUDED.public,
  file_size_limit   = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 2. Política: lectura pública (para mostrar logos en la UI) ────────────
DROP POLICY IF EXISTS "logos_public_read" ON storage.objects;
CREATE POLICY "logos_public_read"
ON storage.objects FOR SELECT
USING (bucket_id = 'logos');

-- ── 3. Política: solo dueno/admin de la empresa pueden subir su logo ──────
-- El archivo debe estar dentro de la carpeta <empresa_id>/
DROP POLICY IF EXISTS "logos_empresa_upload" ON storage.objects;
CREATE POLICY "logos_empresa_upload"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'logos'
  AND (storage.foldername(name))[1] = get_empresa_id()::text
  AND get_rol_usuario() IN ('dueno', 'admin')
);

-- ── 4. Política: sobreescribir logo propio ────────────────────────────────
DROP POLICY IF EXISTS "logos_empresa_update" ON storage.objects;
CREATE POLICY "logos_empresa_update"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'logos'
  AND (storage.foldername(name))[1] = get_empresa_id()::text
  AND get_rol_usuario() IN ('dueno', 'admin')
);

-- ── 5. Política: eliminar logo propio ────────────────────────────────────
DROP POLICY IF EXISTS "logos_empresa_delete" ON storage.objects;
CREATE POLICY "logos_empresa_delete"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'logos'
  AND (storage.foldername(name))[1] = get_empresa_id()::text
  AND get_rol_usuario() IN ('dueno', 'admin')
);

-- ── Verificación ─────────────────────────────────────────────────────────
SELECT id, name, public, file_size_limit FROM storage.buckets WHERE id = 'logos';
