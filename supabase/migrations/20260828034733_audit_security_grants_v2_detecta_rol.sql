-- =============================================================
-- 20260828034733_audit_security_grants_v2_detecta_rol.sql
-- Etapa 0 v2 — reconstruida en el repo, ya estaba aplicada en la
-- base real. Sucesora inmediata de 249 (que solo distinguía
-- "filtra por empresa_id sí/no"). Agrega la detección del patrón
-- fn_crear_producto: mutación SECURITY DEFINER invocable por
-- anon/authenticated sin verificación de rol, aunque SÍ filtre
-- por empresa_id.
--
-- Reemplazada minutos después por v3 (20260828034821), que agrega
-- la exclusión de funciones trigger. Se deja este archivo para que
-- el historial de supabase/migrations/ refleje exactamente lo que
-- corrió contra la base (mismo criterio que check-migraciones-
-- registro.js: no reescribir el pasado, solo trackearlo).
-- =============================================================

DROP FUNCTION IF EXISTS public.audit_security_definer_grants();

CREATE FUNCTION public.audit_security_definer_grants()
 RETURNS TABLE(
   funcion text,
   argumentos text,
   tiene_search_path_fijo boolean,
   anon_puede_ejecutar boolean,
   authenticated_puede_ejecutar boolean,
   muta_datos boolean,
   parece_filtrar_por_tenant boolean,
   parece_verificar_rol boolean,
   en_allowlist_revisado boolean,
   riesgo_potencial boolean
 )
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH base AS (
    SELECT
      p.oid,
      p.proname::text AS funcion,
      pg_get_function_arguments(p.oid) AS argumentos,
      EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) cfg
        WHERE cfg LIKE 'search_path=%'
      ) AS tiene_search_path_fijo,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_puede_ejecutar,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_puede_ejecutar,
      (p.prosrc ~* '(insert into|update |delete from)\s') AS muta_datos,
      (
        pg_get_function_arguments(p.oid) ILIKE '%empresa_id%'
        OR p.prosrc ILIKE '%empresa_id%'
        OR p.prosrc ILIKE '%get_empresa_id%'
        OR p.prosrc ILIKE '%auth_empresa_id%'
        OR p.prosrc ILIKE '%assert_empresa_access%'
      ) AS parece_filtrar_por_tenant,
      (
        p.prosrc ~* '(get_rol_usuario|is_saas_owner|auth\.role\(\)\s*<>|auth\.role\(\)\s*=|auth\.uid\(\)\s*(=|is\s+distinct\s+from)\s*p_usuario_id)'
      ) AS parece_verificar_rol,
      -- SECNEW-04 (2026-08-28): funciones ya revisadas manualmente y confirmadas
      -- seguras aunque el heurístico las marcaría — helpers de RLS que deben ser
      -- ejecutables sin filtro (leen solo la identidad del propio caller), paneles
      -- superadmin con su propio check via is_saas_owner(), y mutaciones donde
      -- "cualquier empleado de la empresa" es la política de negocio intencional
      -- (ya aisladas por tenant, revisadas en la auditoría 2026-08-28).
      (p.proname = ANY (ARRAY[
        'auth_usuario_id','auth_usuario_rol','auth_empresa_id','get_empresa_id',
        'chofer_clientes_ids','es_admin','es_chofer','is_saas_owner',
        'get_saas_panel_admin','migracion_superadmin_resumen',
        'trigger_saas_avisar_nuevo_tenant',
        'cancelar_pedido','migracion_confirmar_sesion','recepcionar_orden_compra',
        'registrar_auditoria','registrar_notif_sugerencia','registrar_cobro'
      ])) AS en_allowlist_revisado
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.prokind = 'f'
  )
  SELECT
    funcion, argumentos, tiene_search_path_fijo,
    anon_puede_ejecutar, authenticated_puede_ejecutar,
    muta_datos, parece_filtrar_por_tenant, parece_verificar_rol,
    en_allowlist_revisado,
    (
      (anon_puede_ejecutar OR authenticated_puede_ejecutar)
      AND NOT en_allowlist_revisado
      AND (
        (NOT parece_filtrar_por_tenant AND NOT parece_verificar_rol)
        OR (muta_datos AND NOT parece_verificar_rol)
      )
    ) AS riesgo_potencial
  FROM base
  ORDER BY riesgo_potencial DESC, funcion;
$function$;

GRANT EXECUTE ON FUNCTION public.audit_security_definer_grants() TO service_role;

INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260828034733_audit_security_grants_v2_detecta_rol.sql',
  'audit_security_grants_v2',
  'claude_assistant',
  'Etapa 0 v2: audit_security_definer_grants() agrega muta_datos + parece_verificar_rol (detecta el patrón fn_crear_producto) y en_allowlist_revisado como lista fija dentro de la función (no parámetro). Reemplazada minutos después por v3. Reconstruida en el repo el 2026-08-28 tras detectar que estaba aplicada en la base real pero no trackeada como archivo ni en este registro.'
)
ON CONFLICT DO NOTHING;
