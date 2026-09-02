-- 538_bucket_comprobantes_privado.sql
--
-- Hallazgo crítico (auditoría Facturación/ARCA, 2026-08-24): el bucket
-- "comprobantes" era público y la ruta de cada PDF usa el número de
-- comprobante (facturas.numero / notas_credito.numero), que es
-- correlativo y predecible: empresas/<empresa_id>/facturas/<numero>.pdf.
--
-- Cualquiera que tuviera la URL de UN comprobante propio —típicamente
-- un cliente logueado en el portal, que ya conoce su propio empresa_id
-- por la URL de su propia factura— podía enumerar números vecinos
-- dentro de la misma carpeta y descargar los comprobantes de OTROS
-- clientes de esa empresa (razón social, CUIT, domicilio, detalle de
-- compra, montos), sin ninguna autenticación adicional.
--
-- Fix: bucket privado. El acceso pasa a hacerse siempre vía
-- generarPDFComprobante() / obtenerUrlFirmadaComprobante() en
-- lib/arca/comprobante-pdf.js, que devuelven una signed URL de 5
-- minutos DESPUÉS de validar tenant + (si es cliente) que la factura o
-- nota de crédito le pertenece — mismo gate que ya usaba
-- /api/facturas?accion=pdf, ahora también aplicado a notas de crédito.

update storage.buckets set public = false where id = 'comprobantes';

drop policy if exists "Lectura pública comprobantes" on storage.objects;

-- Sin policy de SELECT: ni anon ni authenticated pueden leer objetos de
-- este bucket directo. Las signed URLs se generan server-side con la
-- service_role key, que bypassea RLS de Storage — no necesitan policy.
