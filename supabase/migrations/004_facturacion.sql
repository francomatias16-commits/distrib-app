-- 004_facturacion.sql
-- Etapa 2.8 — Integración de facturación (AFIP vía FacturAPI)
--
-- Ejecutar después de 001_schema.sql

-- ── Detalle de error cuando AFIP rechaza un comprobante ──────────────
ALTER TABLE facturas
  ADD COLUMN IF NOT EXISTS notas_error TEXT;

-- ── Configuración de FacturAPI por empresa ───────────────────────────
-- La columna `config` (JSONB) de `empresas` ya existe (001_schema.sql).
-- Para cada empresa, cargar dentro de `config` el siguiente bloque:
--
-- {
--   "facturacion": {
--     "proveedor":          "facturapi",
--     "api_key":            "<clave secreta del proveedor>",
--     "punto_venta":        "0001",
--     "tipo_factura_default": "B"
--   }
-- }
--
-- Notas:
--  - api_key NUNCA se expone al frontend: solo la leen las funciones
--    serverless en /api/facturas usando la service_role key de Supabase.
--  - punto_venta y tipo_factura_default se configuran una sola vez
--    al dar de alta la empresa (ver 6.1 Onboarding y 2.3 Integración AFIP).

-- Ejemplo de carga (reemplazar valores reales):
-- UPDATE empresas
-- SET config = config || '{
--   "facturacion": {
--     "proveedor": "facturapi",
--     "api_key": "CAMBIAR_POR_CLAVE_REAL",
--     "punto_venta": "0001",
--     "tipo_factura_default": "B"
--   }
-- }'::jsonb
-- WHERE id = '<empresa_id>';
