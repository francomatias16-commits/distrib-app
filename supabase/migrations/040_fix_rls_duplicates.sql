-- =============================================================================
-- 040_fix_rls_duplicates.sql
-- LIMPIEZA: políticas RLS duplicadas y en conflicto
--
-- 002_rls.sql creó policies con nombres sin comillas (pedidos_select, etc.)
-- 030_rls_hardening.sql creó policies con nombres entre comillas ("pedidos_select")
-- En Postgres son el MISMO nombre — 030 ya hacía DROP antes del CREATE,
-- así que no hay duplicados reales. Pero con las funciones rotas de auth_id,
-- todas esas policies fallaban. Tras aplicar 039_fix_auth_id_rls.sql las
-- funciones ya retornan valores correctos → las policies existentes funcionan.
--
-- Este script:
--   1. Recrea las policies críticas con la lógica correcta y aislamiento por empresa
--   2. Agrega policy faltante en pedidos para filtrar por empresa_id
--   3. Corrige clientes_select: usa usuario_id (FK correcta del schema)
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PEDIDOS: agregar filtro por empresa para que admin solo vea los suyos
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "pedidos_select"  ON public.pedidos;
DROP POLICY IF EXISTS pedidos_select    ON public.pedidos;

CREATE POLICY pedidos_select ON public.pedidos
    FOR SELECT USING (
        auth.role() = 'service_role'
        OR (public.es_admin()   AND empresa_id = public.auth_empresa_id())
        OR (public.es_chofer()  AND chofer_id  = public.auth_usuario_id())
        OR cliente_id IN (
            SELECT id FROM public.clientes WHERE usuario_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "pedidos_insert"  ON public.pedidos;
DROP POLICY IF EXISTS pedidos_insert    ON public.pedidos;

CREATE POLICY pedidos_insert ON public.pedidos
    FOR INSERT WITH CHECK (
        auth.role() = 'service_role'
        OR (public.es_admin() AND empresa_id = public.auth_empresa_id())
    );

DROP POLICY IF EXISTS "pedidos_update"  ON public.pedidos;
DROP POLICY IF EXISTS pedidos_update    ON public.pedidos;

CREATE POLICY pedidos_update ON public.pedidos
    FOR UPDATE USING (
        auth.role() = 'service_role'
        OR (public.es_admin()  AND empresa_id = public.auth_empresa_id())
        OR (public.es_chofer() AND chofer_id  = public.auth_usuario_id())
    );

DROP POLICY IF EXISTS "pedidos_delete"  ON public.pedidos;
DROP POLICY IF EXISTS pedidos_delete    ON public.pedidos;

CREATE POLICY pedidos_delete ON public.pedidos
    FOR DELETE USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────────────────────
-- CLIENTES: usa usuario_id (FK correcta según schema, no id directamente)
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "clientes_select" ON public.clientes;
DROP POLICY IF EXISTS clientes_select   ON public.clientes;

CREATE POLICY clientes_select ON public.clientes
    FOR SELECT USING (
        auth.role() = 'service_role'
        OR (public.es_admin()  AND empresa_id = public.auth_empresa_id())
        OR public.es_chofer()
        OR usuario_id = auth.uid()
    );

DROP POLICY IF EXISTS "clientes_insert" ON public.clientes;
DROP POLICY IF EXISTS clientes_insert   ON public.clientes;

CREATE POLICY clientes_insert ON public.clientes
    FOR INSERT WITH CHECK (
        auth.role() = 'service_role'
        OR (public.es_admin() AND empresa_id = public.auth_empresa_id())
    );

DROP POLICY IF EXISTS "clientes_update" ON public.clientes;
DROP POLICY IF EXISTS clientes_update   ON public.clientes;

CREATE POLICY clientes_update ON public.clientes
    FOR UPDATE USING (
        auth.role() = 'service_role'
        OR (public.es_admin() AND empresa_id = public.auth_empresa_id())
        OR usuario_id = auth.uid()
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- STOCK, LOTES, FACTURAS, AUDIT_LOG: políticas ya correctas tras fix #1
-- Solo se recrean para garantizar nombres consistentes (sin comillas)
-- ─────────────────────────────────────────────────────────────────────────────

-- stock
DROP POLICY IF EXISTS "stock_select" ON public.stock;
DROP POLICY IF EXISTS stock_select   ON public.stock;
CREATE POLICY stock_select ON public.stock
    FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "stock_write" ON public.stock;
DROP POLICY IF EXISTS stock_write   ON public.stock;
CREATE POLICY stock_write ON public.stock
    FOR ALL USING (auth.role() = 'service_role' OR public.es_admin());

-- lotes
DROP POLICY IF EXISTS "lotes_select" ON public.lotes;
DROP POLICY IF EXISTS lotes_select   ON public.lotes;
CREATE POLICY lotes_select ON public.lotes
    FOR SELECT USING (
        auth.role() = 'service_role'
        OR public.es_admin()
        OR public.es_chofer()
    );

DROP POLICY IF EXISTS "lotes_write" ON public.lotes;
DROP POLICY IF EXISTS lotes_write   ON public.lotes;
CREATE POLICY lotes_write ON public.lotes
    FOR ALL USING (auth.role() = 'service_role' OR public.es_admin());

-- facturas
DROP POLICY IF EXISTS "facturas_select" ON public.facturas;
DROP POLICY IF EXISTS facturas_select   ON public.facturas;
CREATE POLICY facturas_select ON public.facturas
    FOR SELECT USING (
        auth.role() = 'service_role'
        OR (public.es_admin() AND empresa_id = public.auth_empresa_id())
        OR cliente_id IN (
            SELECT id FROM public.clientes WHERE usuario_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "facturas_write" ON public.facturas;
DROP POLICY IF EXISTS facturas_write   ON public.facturas;
CREATE POLICY facturas_write ON public.facturas
    FOR ALL USING (auth.role() = 'service_role' OR public.es_admin());

-- audit_log
DROP POLICY IF EXISTS "audit_select" ON public.audit_log;
DROP POLICY IF EXISTS audit_select   ON public.audit_log;
CREATE POLICY audit_select ON public.audit_log
    FOR SELECT USING (auth.role() = 'service_role' OR public.es_admin());

DROP POLICY IF EXISTS "audit_insert" ON public.audit_log;
DROP POLICY IF EXISTS audit_insert   ON public.audit_log;
CREATE POLICY audit_insert ON public.audit_log
    FOR INSERT WITH CHECK (auth.role() = 'service_role');

COMMIT;
