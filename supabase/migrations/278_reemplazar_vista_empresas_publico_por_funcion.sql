-- 278_reemplazar_vista_empresas_publico_por_funcion.sql
--
-- Contexto: get_advisors(security) marcó v_empresas_publico (232) como
-- SECURITY DEFINER view (ERROR) — corre con los privilegios del creador,
-- ignorando el RLS estricto de empresas (id = get_empresa_id()).
-- Es intencional (pantallas de login sin sesión necesitan nombre/logo_url
-- de la empresa activa), pero como vista queda "definer" de forma
-- implícita y no auditable. Se reemplaza por una función SECURITY DEFINER
-- explícita, mismo patrón que get_facturacion_config()/es_admin(): el
-- bypass de RLS queda declarado a propósito, con su propio search_path
-- fijo, en vez de heredado silenciosamente del dueño de la vista.
--
-- Solo expone id/nombre/logo_url de la primera empresa activa — igual
-- alcance que la vista que reemplaza, nunca cuit/saas_cbu/saas_alias/etc.
--
-- Requiere actualizar frontend/admin/login.html y
-- frontend/cliente/login.html para usar .rpc('empresa_publica_actual')
-- en vez de .from('v_empresas_publico') — hecho en el mismo release.

CREATE OR REPLACE FUNCTION public.empresa_publica_actual()
RETURNS TABLE(id uuid, nombre text, logo_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, nombre, logo_url
  FROM public.empresas
  WHERE activa = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.empresa_publica_actual() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.empresa_publica_actual() TO anon, authenticated;

REVOKE ALL ON public.v_empresas_publico FROM anon, authenticated;
DROP VIEW IF EXISTS public.v_empresas_publico;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '278_reemplazar_vista_empresas_publico_por_funcion.sql', '278', 'claude-session', 'Fix security_definer_view (ERROR) detectado por get_advisors: reemplaza v_empresas_publico por función SECURITY DEFINER explícita')
ON CONFLICT DO NOTHING;
