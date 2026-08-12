-- 265_idx_proveedores_busqueda_trgm.sql
-- Índice de apoyo para la búsqueda server-side de Proveedores
-- (lib/handlers/proveedores.js, GET, .or(ilike...)), agregada junto con
-- la paginación real para reemplazar el .limit(500) fijo.
--
-- Volumen bajo hoy (proveedores suele ser una tabla chica comparada con
-- clientes/productos), pero mismo criterio que idx_clientes_busqueda_trgm /
-- idx_productos_busqueda_trgm: barato de mantener y evita un seq scan si
-- algún tenant crece.

CREATE INDEX IF NOT EXISTS idx_proveedores_busqueda_trgm
  ON public.proveedores
  USING gin ((razon_social || ' ' || COALESCE(nombre_fantasia, '') || ' ' || COALESCE(cuit, '')) gin_trgm_ops);
