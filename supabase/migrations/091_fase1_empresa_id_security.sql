--
-- Migración 091: Fase 1 — Base de Datos
-- * NOT NULL en empresa_id para 23 tablas
-- * RLS policies para 5 tablas sin policy
-- * Índices en empresa_id para 5 tablas sin índice
--
-- Ejecución: psql -d distrib < 091_fase1_empresa_id_security.sql

-- =============================================================================
-- FASE 1.1: Agregar NOT NULL a empresa_id (23 tablas)
-- =============================================================================

-- audit_log
ALTER TABLE public.audit_log
  ALTER COLUMN empresa_id SET NOT NULL;

-- cajas_pos
ALTER TABLE public.cajas_pos
  ALTER COLUMN empresa_id SET NOT NULL;

-- categorias
ALTER TABLE public.categorias
  ALTER COLUMN empresa_id SET NOT NULL;

-- cheques
ALTER TABLE public.cheques
  ALTER COLUMN empresa_id SET NOT NULL;

-- clientes
ALTER TABLE public.clientes
  ALTER COLUMN empresa_id SET NOT NULL;

-- cobros
ALTER TABLE public.cobros
  ALTER COLUMN empresa_id SET NOT NULL;

-- depositos
ALTER TABLE public.depositos
  ALTER COLUMN empresa_id SET NOT NULL;

-- devoluciones
ALTER TABLE public.devoluciones
  ALTER COLUMN empresa_id SET NOT NULL;

-- email_log
ALTER TABLE public.email_log
  ALTER COLUMN empresa_id SET NOT NULL;

-- facturas
ALTER TABLE public.facturas
  ALTER COLUMN empresa_id SET NOT NULL;

-- listas_precios
ALTER TABLE public.listas_precios
  ALTER COLUMN empresa_id SET NOT NULL;

-- lotes
ALTER TABLE public.lotes
  ALTER COLUMN empresa_id SET NOT NULL;

-- notas_internas
ALTER TABLE public.notas_internas
  ALTER COLUMN empresa_id SET NOT NULL;

-- notif_log
ALTER TABLE public.notif_log
  ALTER COLUMN empresa_id SET NOT NULL;

-- ordenes_compra
ALTER TABLE public.ordenes_compra
  ALTER COLUMN empresa_id SET NOT NULL;

-- pedidos
ALTER TABLE public.pedidos
  ALTER COLUMN empresa_id SET NOT NULL;

-- presupuestos
ALTER TABLE public.presupuestos
  ALTER COLUMN empresa_id SET NOT NULL;

-- productos
ALTER TABLE public.productos
  ALTER COLUMN empresa_id SET NOT NULL;

-- ruta_items
ALTER TABLE public.ruta_items
  ALTER COLUMN empresa_id SET NOT NULL;

-- rutas
ALTER TABLE public.rutas
  ALTER COLUMN empresa_id SET NOT NULL;

-- usuarios
ALTER TABLE public.usuarios
  ALTER COLUMN empresa_id SET NOT NULL;

-- ventas_pos
ALTER TABLE public.ventas_pos
  ALTER COLUMN empresa_id SET NOT NULL;

-- zonas
ALTER TABLE public.zonas
  ALTER COLUMN empresa_id SET NOT NULL;

-- =============================================================================
-- FASE 1.2: Crear índices en empresa_id (5 tablas sin índice)
-- =============================================================================

-- cajas_pos — sin índice en ninguna columna
CREATE INDEX IF NOT EXISTS idx_cajas_pos_empresa_id 
  ON public.cajas_pos(empresa_id);

-- contadores_empresa — sin índice en ninguna columna
CREATE INDEX IF NOT EXISTS idx_contadores_empresa_empresa_id 
  ON public.contadores_empresa(empresa_id);

-- empresas — sin índice en empresa_id (y es la tabla de empresas misma)
CREATE INDEX IF NOT EXISTS idx_empresas_id 
  ON public.empresas(id);

-- notif_prefs_auto — sin índice en ninguna columna
CREATE INDEX IF NOT EXISTS idx_notif_prefs_auto_empresa_id 
  ON public.notif_prefs_auto(empresa_id);

-- productos — índice en empresa_id si no existe
CREATE INDEX IF NOT EXISTS idx_productos_empresa_id 
  ON public.productos(empresa_id);

-- =============================================================================
-- FASE 1.3: RLS policies para 5 tablas sin policy
-- =============================================================================

-- Habilitar RLS (si no está habilitado)
ALTER TABLE public.devolucion_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facturas_proveedor_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proveedor_portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reportes_ruta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_secrets ENABLE ROW LEVEL SECURITY;

-- devolucion_items — policy basada en empresa_id (vía devoluciones)
DROP POLICY IF EXISTS rls_devolucion_items_empresa_access ON public.devolucion_items;
CREATE POLICY rls_devolucion_items_empresa_access 
  ON public.devolucion_items 
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.devoluciones 
      WHERE devoluciones.id = devolucion_items.devolucion_id
        AND devoluciones.empresa_id IN (
          SELECT empresa_id FROM public.usuarios 
          WHERE auth_id = auth.uid()
        )
    )
  );

-- facturas_proveedor_items — policy basada en empresa_id (vía facturas_proveedor)
DROP POLICY IF EXISTS rls_facturas_proveedor_items_empresa_access ON public.facturas_proveedor_items;
CREATE POLICY rls_facturas_proveedor_items_empresa_access 
  ON public.facturas_proveedor_items 
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.facturas_proveedor 
      WHERE facturas_proveedor.id = facturas_proveedor_items.factura_id
        AND facturas_proveedor.empresa_id IN (
          SELECT empresa_id FROM public.usuarios 
          WHERE auth_id = auth.uid()
        )
    )
  );

-- proveedor_portal_tokens — policy basada en empresa_id
DROP POLICY IF EXISTS rls_proveedor_portal_tokens_empresa_access ON public.proveedor_portal_tokens;
CREATE POLICY rls_proveedor_portal_tokens_empresa_access 
  ON public.proveedor_portal_tokens 
  FOR SELECT
  USING (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios 
      WHERE auth_id = auth.uid()
    )
  );

-- reportes_ruta — policy basada en empresa_id
DROP POLICY IF EXISTS rls_reportes_ruta_empresa_access ON public.reportes_ruta;
CREATE POLICY rls_reportes_ruta_empresa_access 
  ON public.reportes_ruta 
  FOR SELECT
  USING (
    empresa_id IN (
      SELECT empresa_id FROM public.usuarios 
      WHERE auth_id = auth.uid()
    )
  );

-- internal_secrets — policy restrictiva (solo admin/system)
DROP POLICY IF EXISTS rls_internal_secrets_admin_only ON public.internal_secrets;
CREATE POLICY rls_internal_secrets_admin_only 
  ON public.internal_secrets 
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.usuarios 
      WHERE auth_id = auth.uid() 
        AND rol = 'admin'
    )
  );

-- =============================================================================
-- Validación final
-- =============================================================================

-- Listar tablas con empresa_id null (debería estar vacío después de migración)
-- SELECT table_name 
-- FROM information_schema.columns 
-- WHERE column_name = 'empresa_id' 
--   AND is_nullable = 'YES'
--   AND table_schema = 'public'
-- ORDER BY table_name;

-- Verificar índices creados
-- SELECT schemaname, tablename, indexname 
-- FROM pg_indexes 
-- WHERE tablename IN ('cajas_pos', 'contadores_empresa', 'empresas', 'notif_prefs_auto', 'productos')
-- ORDER BY tablename, indexname;

-- Verificar RLS policies
-- SELECT schemaname, tablename, policyname, permissive
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('devolucion_items', 'facturas_proveedor_items', 'proveedor_portal_tokens', 'reportes_ruta', 'internal_secrets')
-- ORDER BY tablename, policyname;
