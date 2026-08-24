-- 477_fix_empresa_publica_actual_multi_tenant.sql
--
-- Bug encontrado 2026-08-14: empresa_publica_actual() (278) hace
-- `SELECT ... FROM empresas WHERE activa = true LIMIT 1` sin ningún otro
-- filtro. Fue escrita asumiendo un deploy single-tenant (una sola empresa
-- activa por instancia), pero esta base es una SaaS multi-tenant real:
-- confirmado en producción que hay 4 empresas simultáneamente
-- `activa = true` (una con saas_plan 'activo', dos en 'trial', una
-- es_demo), todas sirviendo desde el mismo deploy/dominio compartido.
--
-- Resultado: /admin/login y /cliente/login no tenían forma de saber a
-- qué empresa pertenecían antes de que el usuario ingresara sus
-- credenciales — el RPC devolvía una fila arbitraria entre las 4 (orden
-- físico de Postgres, no determinístico), pudiendo mostrar el nombre/logo
-- de una empresa distinta a la del visitante real. Hoy "acertaba" con
-- del sol srl de pura casualidad de orden interno.
--
-- Fix: mismo patrón que ya usa el catálogo público (empresa_id explícito
-- en la URL, ver 296/476). Se agrega p_empresa_id opcional:
--   - Si se pasa: devuelve esa empresa puntual (si está activa).
--   - Si NO se pasa: solo devuelve algo cuando hay exactamente UNA
--     empresa activa en toda la base (caso single-tenant real, mismo
--     comportamiento de siempre) — si hay más de una, no adivina: no
--     devuelve filas, y el frontend ya maneja ese caso (arranca sin
--     mostrar nombre/logo hasta que el usuario se identifica).
--
-- Cambia la firma de () a (uuid) — DROP explícito porque CREATE OR
-- REPLACE no reemplaza funciones con distinta lista de parámetros.

DROP FUNCTION IF EXISTS public.empresa_publica_actual();

CREATE FUNCTION public.empresa_publica_actual(p_empresa_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid, nombre text, logo_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.nombre, e.logo_url
  FROM public.empresas e
  WHERE e.activa = true
    AND (
      (p_empresa_id IS NOT NULL AND e.id = p_empresa_id)
      OR (
        p_empresa_id IS NULL
        AND (SELECT COUNT(*) FROM public.empresas WHERE activa = true) = 1
      )
    )
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.empresa_publica_actual(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.empresa_publica_actual(uuid) TO anon, authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '477_fix_empresa_publica_actual_multi_tenant.sql', '477', 'claude-session', 'Fix bug real: login mostraba nombre/logo de una empresa arbitraria entre varias activas simultáneas (SaaS multi-tenant, no single-tenant). Ahora exige empresa_id explícito salvo que haya una sola empresa activa en toda la base')
ON CONFLICT DO NOTHING;
