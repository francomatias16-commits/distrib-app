-- 140_apply_pending_fix_storage_listing_logos.sql
-- Aplicada en Supabase: 2026-06-30 (auditoría)
--
-- 125_fix_storage_listing.sql existía en el repo desde antes pero NUNCA se
-- corrió contra producción: el bucket 'logos' seguía public=true. Esta
-- migración aplica lo mismo, pero corrigiendo un detalle que 125 no tenía
-- en cuenta: ya existían policies legacy más estrictas
-- (logos_empresa_upload/update/delete, restringidas a rol dueno/admin) que
-- 125 no contemplaba. Por eso acá NO se recrean logos_upload/logos_delete
-- (quedarían duplicadas y más laxas que las legacy, debilitando el control
-- de acceso real). Solo se agrega logos_read, que es la única que faltaba.

UPDATE storage.buckets
SET public = false,
    file_size_limit = 2097152,
    allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp','image/svg+xml']
WHERE id = 'logos';

DROP POLICY IF EXISTS "logos_read" ON storage.objects;
CREATE POLICY "logos_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'logos');

-- NOTA: logos_empresa_upload / logos_empresa_update / logos_empresa_delete
-- ya existían en producción de antes y se dejan intactas. Cubren INSERT /
-- UPDATE / DELETE restringido a (storage.foldername(name))[1] = empresa_id
-- AND rol IN ('dueno','admin'). No se tocan acá.
