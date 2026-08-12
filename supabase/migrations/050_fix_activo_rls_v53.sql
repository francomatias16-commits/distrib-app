-- ═══════════════════════════════════════════════════════════════════════════
-- 050_fix_activo_rls_v53.sql  (rev B — corrige error 42P13)
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Asegurar que el dueño siempre tenga activo = true ─────────────────
UPDATE public.usuarios
SET activo = true
WHERE rol = 'dueno';

UPDATE public.usuarios
SET activo = true
WHERE rol IN ('admin', 'contador')
  AND activo IS NULL;

-- ── 2. Policy: cada usuario puede leer su propio registro ────────────────
DROP POLICY IF EXISTS "usuarios_select_propio" ON public.usuarios;
CREATE POLICY "usuarios_select_propio" ON public.usuarios
  FOR SELECT
  USING (id = auth.uid());

DROP POLICY IF EXISTS "usuarios_select_empresa" ON public.usuarios;
CREATE POLICY "usuarios_select_empresa" ON public.usuarios
  FOR SELECT
  USING (empresa_id = public.get_empresa_id());

-- ── 3. get_empresa_id() — SECURITY DEFINER (no cambia tipo, seguro) ──────
CREATE OR REPLACE FUNCTION public.get_empresa_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT empresa_id FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- ── 4. get_rol_usuario() — debe retornar rol_usuario (ENUM), no TEXT ─────
-- No podemos cambiar el tipo de retorno con CREATE OR REPLACE.
-- Recreamos manteniendo el mismo tipo que el original: rol_usuario.
DROP FUNCTION IF EXISTS public.get_rol_usuario();
CREATE FUNCTION public.get_rol_usuario()
RETURNS public.rol_usuario
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rol FROM public.usuarios WHERE id = auth.uid() LIMIT 1;
$$;

-- ── 5. Policy: empresas — ver la propia empresa ──────────────────────────
DROP POLICY IF EXISTS "empresas_select_propio" ON public.empresas;
CREATE POLICY "empresas_select_propio" ON public.empresas
  FOR SELECT
  USING (
    id = public.get_empresa_id()
    OR activa = true
  );

-- ── 6. Diagnóstico: usuarios activos ─────────────────────────────────────
SELECT id, nombre, email, rol, activo FROM public.usuarios ORDER BY created_at;
