-- =============================================================
-- 20260828034821_audit_security_grants_v3_excluye_triggers.sql
-- Etapa 0 v3 (vigente) — reconstruida en el repo, ya estaba
-- aplicada en la base real.
--
-- SECNEW-05 (2026-08-28): las funciones RETURNS trigger no son
-- invocables vía PostgREST /rpc/ sin importar el grant — Postgres
-- rechaza la llamada directa. El advisor de Supabase no distingue
-- esto; esta versión sí, para no generar falsos positivos sobre
-- funciones trigger que de por sí no son alcanzables por
-- anon/authenticated aunque tengan EXECUTE otorgado.
--
-- Esta es la versión que consume scripts/audit-security-grants.js
-- actualmente (mismos campos, se llama sin argumentos).
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
      (p.proname = ANY (ARRAY[
        'auth_usuario_id','auth_usuario_rol','auth_empresa_id','get_empresa_id',
        'chofer_clientes_ids','es_admin','es_chofer','is_saas_owner',
        'get_saas_panel_admin','migracion_superadmin_resumen',
        'trigger_saas_avisar_nuevo_tenant',
        'cancelar_pedido','migracion_confirmar_sesion','recepcionar_orden_compra',
        'registrar_auditoria','registrar_notif_sugerencia','registrar_cobro'
      ])) AS en_allowlist_revisado,
      -- SECNEW-05 (2026-08-28): las funciones RETURNS trigger no son invocables
      -- vía PostgREST /rpc/ sin importar el grant — Postgres rechaza la llamada
      -- directa. El advisor de Supabase no distingue esto; nuestro heurístico sí.
      (p.prorettype = 'trigger'::regtype) AS es_funcion_trigger
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
      NOT es_funcion_trigger
      AND (anon_puede_ejecutar OR authenticated_puede_ejecutar)
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
  '20260828034821_audit_security_grants_v3_excluye_triggers.sql',
  'audit_security_grants_v3',
  'claude_assistant',
  'Etapa 0 v3 (vigente): audit_security_definer_grants() excluye funciones RETURNS trigger del riesgo_potencial (SECNEW-05) — no son invocables vía PostgREST /rpc/ sin importar el grant. Versión que consume scripts/audit-security-grants.js actualmente. Verificado 2026-08-28: 0 hallazgos de riesgo_potencial=true contra la base real. Reconstruida en el repo tras detectar que estaba aplicada en la base real pero no trackeada como archivo ni en este registro.'
)
ON CONFLICT DO NOTHING;
