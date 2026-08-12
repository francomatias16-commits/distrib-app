-- ============================================================
-- Migration: 041_enable_rls_comprehensive.sql
-- Descripción: Habilitar Row Level Security en todas las tablas
--              que tienen políticas RLS definidas pero no estaban
--              activas (ENABLE ROW LEVEL SECURITY faltante)
-- ============================================================

-- Tablas principales (críticas para multi-tenancy)
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zonas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listas_precios ENABLE ROW LEVEL SECURITY;

-- Tablas de operaciones
ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;

-- Tablas de auditoría y control
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Nota: Las siguientes tablas ya tienen RLS habilitado
-- (confirmado en backup.sql):
-- - alertas_score
-- - alertas_stock
-- - bloqueos_cliente
-- - ciclos_compra
-- - contadores_empresa
-- - lotes
-- - movimientos_cta_cte
-- - notas_internas
-- - notif_log
-- - ordenes_compra
-- - ordenes_compra_items
-- - presupuesto_items
-- - presupuestos
-- - reglas_score
-- - scores_cliente

-- ============================================================
-- Validación post-migración (ejecutar manualmente para verificar)
-- ============================================================
-- SELECT schemaname, tablename, rowsecurity 
-- FROM pg_tables 
-- WHERE schemaname = 'public' 
-- ORDER BY tablename;
-- 
-- EXPECTED: Todas las tablas should show rowsecurity = true
