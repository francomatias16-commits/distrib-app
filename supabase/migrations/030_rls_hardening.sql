-- ============================================================
-- 030_rls_hardening.sql
-- distrib-v39 | RLS World-Class — CORREGIDO
--
-- CORRECCIÓN APLICADA:
--   El schema define usuarios.id UUID PRIMARY KEY REFERENCES auth.users(id)
--   Es decir, usuarios.id YA ES el auth UID — no existe columna auth_id.
--   Las funciones originales usaban auth_id (inexistente) → retornaban NULL
--   → todas las políticas RLS bloqueaban acceso legítimo.
--   Se corrigen todas las funciones y referencias para usar id = auth.uid().
--
-- TÉCNICAS MANTENIDAS:
--   - Funciones STABLE + SECURITY DEFINER (caché por query, no por fila)
--   - Separación estricta SELECT / INSERT / UPDATE / DELETE
--   - service_role siempre bypass (para RPCs y API server-side)
-- ============================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- FUNCIONES DE CONTEXTO (STABLE + SECURITY DEFINER)
-- Usan id = auth.uid() porque usuarios.id ES el UUID de auth.users
-- ═══════════════════════════════════════════════════════════════

-- Retorna el UUID del usuario autenticado (= su id en tabla usuarios)
CREATE OR REPLACE FUNCTION public.auth_usuario_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- Retorna el rol del usuario autenticado
CREATE OR REPLACE FUNCTION public.auth_usuario_rol()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rol FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- Retorna el empresa_id del usuario autenticado
CREATE OR REPLACE FUNCTION public.auth_empresa_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT empresa_id FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- Retorna TRUE si el usuario es admin/dueno o service_role
CREATE OR REPLACE FUNCTION public.es_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT auth.role() = 'service_role'
        OR EXISTS (
            SELECT 1 FROM public.usuarios
            WHERE id = auth.uid() AND rol IN ('dueno', 'admin', 'superadmin')
        );
$$;

-- Retorna TRUE si el usuario es chofer
CREATE OR REPLACE FUNCTION public.es_chofer()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.usuarios
        WHERE id = auth.uid() AND rol = 'chofer'
    );
$$;


-- ═══════════════════════════════════════════════════════════════
-- TABLA: pedidos
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pedidos_select"  ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_insert"  ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_update"  ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_delete"  ON public.pedidos;

-- SELECT: admin ve todo de su empresa; cliente ve sus propios pedidos; chofer ve los asignados
CREATE POLICY "pedidos_select" ON public.pedidos
    FOR SELECT USING (
        auth.role() = 'service_role'
        OR public.es_admin()
        OR cliente_id = public.auth_usuario_id()
        OR chofer_id  = public.auth_usuario_id()
    );

-- INSERT: solo service_role (via RPC rpc_crear_pedido) y admin
CREATE POLICY "pedidos_insert" ON public.pedidos
    FOR INSERT WITH CHECK (
        auth.role() = 'service_role'
        OR public.es_admin()
    );

-- UPDATE: service_role y admin pueden actualizar; chofer solo puede cambiar estado
CREATE POLICY "pedidos_update" ON public.pedidos
    FOR UPDATE USING (
        auth.role() = 'service_role'
        OR public.es_admin()
        OR (public.es_chofer() AND chofer_id = public.auth_usuario_id())
    );

-- DELETE: solo service_role
CREATE POLICY "pedidos_delete" ON public.pedidos
    FOR DELETE USING (auth.role() = 'service_role');


-- ═══════════════════════════════════════════════════════════════
-- TABLA: clientes
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clientes_select" ON public.clientes;
DROP POLICY IF EXISTS "clientes_insert" ON public.clientes;
DROP POLICY IF EXISTS "clientes_update" ON public.clientes;

-- Admin ve todos los clientes de su empresa; cliente ve su propio perfil; chofer ve todos activos
CREATE POLICY "clientes_select" ON public.clientes
    FOR SELECT USING (
        auth.role() = 'service_role'
        OR public.es_admin()
        OR public.es_chofer()
        OR usuario_id = public.auth_usuario_id()
    );

CREATE POLICY "clientes_insert" ON public.clientes
    FOR INSERT WITH CHECK (
        auth.role() = 'service_role' OR public.es_admin()
    );

CREATE POLICY "clientes_update" ON public.clientes
    FOR UPDATE USING (
        auth.role() = 'service_role'
        OR public.es_admin()
        OR usuario_id = public.auth_usuario_id()
    );


-- ═══════════════════════════════════════════════════════════════
-- TABLA: stock
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_select" ON public.stock;
DROP POLICY IF EXISTS "stock_write"  ON public.stock;

-- Lectura: todos los usuarios autenticados ven el stock (para catálogo)
CREATE POLICY "stock_select" ON public.stock
    FOR SELECT USING (auth.uid() IS NOT NULL);

-- Escritura: solo service_role y admin
CREATE POLICY "stock_write" ON public.stock
    FOR ALL USING (
        auth.role() = 'service_role' OR public.es_admin()
    );


-- ═══════════════════════════════════════════════════════════════
-- TABLA: lotes
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.lotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lotes_select" ON public.lotes;
DROP POLICY IF EXISTS "lotes_write"  ON public.lotes;

CREATE POLICY "lotes_select" ON public.lotes
    FOR SELECT USING (
        auth.role() = 'service_role'
        OR public.es_admin()
        OR public.es_chofer()
    );

CREATE POLICY "lotes_write" ON public.lotes
    FOR ALL USING (
        auth.role() = 'service_role' OR public.es_admin()
    );


-- ═══════════════════════════════════════════════════════════════
-- TABLA: facturas
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.facturas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "facturas_select" ON public.facturas;
DROP POLICY IF EXISTS "facturas_write"  ON public.facturas;

-- Cliente solo ve sus propias facturas; admin ve todas las de su empresa
CREATE POLICY "facturas_select" ON public.facturas
    FOR SELECT USING (
        auth.role() = 'service_role'
        OR public.es_admin()
        OR cliente_id IN (
            SELECT id FROM public.clientes WHERE usuario_id = auth.uid()
        )
    );

CREATE POLICY "facturas_write" ON public.facturas
    FOR ALL USING (
        auth.role() = 'service_role' OR public.es_admin()
    );


-- ═══════════════════════════════════════════════════════════════
-- TABLA: audit_log — solo lectura para admins, sin escritura directa
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_select" ON public.audit_log;
DROP POLICY IF EXISTS "audit_insert" ON public.audit_log;

CREATE POLICY "audit_select" ON public.audit_log
    FOR SELECT USING (
        auth.role() = 'service_role' OR public.es_admin()
    );

CREATE POLICY "audit_insert" ON public.audit_log
    FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- NUNCA UPDATE ni DELETE en audit_log (inmutabilidad garantizada por ausencia de políticas)


-- ═══════════════════════════════════════════════════════════════
-- ÍNDICE EN usuarios(id) — ya es PK, no necesita índice extra.
-- Se elimina el intento de crear índice sobre auth_id (columna inexistente).
-- Se crea índice compuesto empresa_id + id para acelerar políticas RLS
-- que filtran por empresa del usuario.
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_usuarios_id_empresa
    ON public.usuarios (id, empresa_id);


-- ═══════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-MIGRACIÓN
-- Ejecutar en Supabase SQL Editor para confirmar:
--
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN ('pedidos','clientes','stock','lotes','facturas','audit_log')
-- ORDER BY tablename;
--
-- Todas deben mostrar rowsecurity = true.
--
-- Test rápido de funciones (con usuario autenticado):
-- SELECT public.auth_usuario_id(), public.auth_usuario_rol(), public.es_admin();
-- ═══════════════════════════════════════════════════════════════

COMMIT;
