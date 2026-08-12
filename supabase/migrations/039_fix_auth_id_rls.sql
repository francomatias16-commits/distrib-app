-- =============================================================================
-- 039_fix_auth_id_rls.sql
-- CORRECCIÓN CRÍTICA: auth_id inexistente en tabla usuarios
--
-- PROBLEMA:
--   030_rls_hardening.sql definió funciones usando "WHERE auth_id = auth.uid()"
--   pero el schema (001_schema.sql) define:
--     usuarios.id UUID PRIMARY KEY REFERENCES auth.users(id)
--   Es decir, usuarios.id YA ES el UUID de Supabase Auth — no existe auth_id.
--   Las funciones retornaban NULL en todo caso → RLS bloqueaba acceso legítimo.
--
-- SOLUCIÓN:
--   Reescribir las 5 funciones de contexto usando "id = auth.uid()".
--   Eliminar el índice sobre auth_id (columna inexistente → error en producción).
--   Crear índice correcto sobre (id, empresa_id).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FUNCIONES DE CONTEXTO — corregidas
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_usuario_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.auth_usuario_rol()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rol::TEXT FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- Nueva función auxiliar (alias de get_empresa_id, con SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.auth_empresa_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT empresa_id FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

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
            WHERE id = auth.uid()
              AND rol IN ('dueno', 'admin', 'superadmin')
        );
$$;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ÍNDICES — eliminar el roto, crear el correcto
-- ─────────────────────────────────────────────────────────────────────────────

-- El índice sobre auth_id (columna inexistente) nunca se pudo crear en producción,
-- pero si por alguna migración anterior quedó: eliminarlo.
DROP INDEX IF EXISTS public.idx_usuarios_auth_id;

-- Índice compuesto para acelerar los filtros RLS más frecuentes
CREATE INDEX IF NOT EXISTS idx_usuarios_id_empresa
    ON public.usuarios (id, empresa_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. VERIFICACIÓN
-- Ejecutar tras aplicar para confirmar que las funciones retornan datos reales:
--
--   SELECT
--     public.auth_usuario_id()  AS usuario_id,
--     public.auth_usuario_rol() AS rol,
--     public.auth_empresa_id()  AS empresa_id,
--     public.es_admin()         AS es_admin;
--
-- Debe retornar los valores reales del usuario, NO NULL.
-- ─────────────────────────────────────────────────────────────────────────────

COMMIT;
