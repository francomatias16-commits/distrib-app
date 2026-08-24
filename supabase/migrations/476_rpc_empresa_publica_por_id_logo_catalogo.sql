-- 476_rpc_empresa_publica_por_id_logo_catalogo.sql
-- (Renumerada de 475 a 476: el 475 ya estaba tomado en la base real por
-- 475_fix_fn_productos_lista_cast_numeric_stock.sql, aplicado el mismo día.)
--
-- Contexto: se agrega el logo de la empresa al header del catálogo público
-- (/cliente/catalogo, accedido sin login vía "Habilitar catálogo sin
-- login"). Esa pantalla hoy no tiene forma de leer nombre/logo_url de la
-- empresa: empresa_publica_actual() (278) devuelve la primera empresa
-- ACTIVA sin filtrar por id (pensada para login single-tenant), no sirve
-- acá porque el catálogo es multi-empresa y recibe empresa_id por query
-- string o por perfil del cliente logueado.
--
-- Mismo gateo que SEC-008 (292, cliente_productos_disponibles): un caller
-- que no es el dueño de esos datos (no service_role, no un usuario
-- autenticado de esa misma empresa vía get_empresa_id()) solo puede leer
-- nombre/logo_url si la empresa tiene
-- empresas.config->>'catalogo_publico_habilitado' = true. Si no, devuelve
-- 0 filas (no error) — mismo criterio: no filtrar si el empresa_id existe.
--
-- Alcance intencionalmente mínimo: solo id/nombre/logo_url, igual que
-- empresa_publica_actual() — nunca cuit/saas_cbu/saas_alias/config/etc.

CREATE OR REPLACE FUNCTION public.empresa_publica_por_id(p_empresa_id uuid)
RETURNS TABLE(id uuid, nombre text, logo_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF auth.role() <> 'service_role'
     AND public.get_empresa_id() IS DISTINCT FROM p_empresa_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.empresas e
       WHERE e.id = p_empresa_id
         AND COALESCE((e.config->>'catalogo_publico_habilitado')::boolean, false) = true
    ) THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT e.id, e.nombre, e.logo_url
  FROM public.empresas e
  WHERE e.id = p_empresa_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.empresa_publica_por_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.empresa_publica_por_id(uuid) TO anon, authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '476_rpc_empresa_publica_por_id_logo_catalogo.sql', '476', 'claude-session', 'RPC público para nombre+logo de una empresa por id, gateado por catalogo_publico_habilitado (mismo patrón SEC-008) — usado por el header del catálogo público')
ON CONFLICT DO NOTHING;
