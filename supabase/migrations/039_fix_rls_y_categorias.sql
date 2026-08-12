-- =============================================================================
-- 039_fix_rls_y_categorias.sql
-- Fix #2: agregar columna activa a categorias (usada en frontend pero ausente en schema)
-- Fix #3: corregir policy RLS de productos_modify para incluir rol depositero
-- Fix #7: asegurar consistencia de get_empresa_id() con schema actual
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. categorias.activa — columna faltante
--    El frontend filtra .eq('activa', true) pero la columna no existía.
--    Por defecto todas las categorías quedan activas (true).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS activa BOOLEAN NOT NULL DEFAULT true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. productos_modify — incluir depositero en la política de escritura
--    El frontend admin permite a depositero acceder a /admin/productos
--    pero la policy RLS original solo permitía dueno y admin.
--    Fix: ampliar a dueno, admin, depositero.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS productos_modify ON public.productos;

CREATE POLICY productos_modify ON public.productos
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Asegurar que get_empresa_id() y get_rol_usuario() (002_rls.sql) usan
--    id = auth.uid() — que es el esquema correcto. Si fueron reemplazadas
--    por versiones rotas, se restauran aquí.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_empresa_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT empresa_id FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_rol_usuario()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rol::TEXT FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;
