-- ============================================================================
-- SEC-05 (Auditoría Integral 2026) — buckets con public=true expuestos sin
-- autenticación: remitos, devoluciones, facturas-proveedor.
--
-- APLICADA en producción (jgiquzjwoedmzwqgzubr) el 2026-08-18.
--
-- No hizo falta migración de datos: se confirmó contra producción que
-- ninguna fila tenía todavía foto_url/archivo_url cargado en
-- recepciones_mercaderia, devoluciones, pedidos ni facturas_proveedor en el
-- momento del deploy. El código acompañante (mismo commit) ya guarda el
-- path del objeto en vez de una URL pública, y firma la URL recién al leer
-- (lib/utils/storage-urls.js). Si en algún momento aparecen filas viejas
-- con URL pública completa en vez de path, `firmarUrlStorage` las tolera
-- (extrae el path de la URL antes de firmar) — ver ese archivo.
--
-- Lectura/escritura de estos 3 buckets pasa siempre por el backend con
-- service_role (confirmado: ningún código de frontend llama a
-- supabase.storage para estos buckets directo), que bypassea RLS de
-- Storage por definición — no hizo falta agregar políticas SELECT nuevas
-- para authenticated/anon.
-- ============================================================================

UPDATE storage.buckets
   SET public = false
 WHERE id IN ('remitos', 'devoluciones', 'facturas-proveedor');
