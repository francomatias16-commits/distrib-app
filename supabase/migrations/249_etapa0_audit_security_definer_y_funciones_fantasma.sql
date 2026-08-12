-- =============================================================
-- 249_etapa0_audit_security_definer_y_funciones_fantasma.sql
-- Etapa 0 del plan por etapas (Higiene de base).
--
-- Contexto: el patrón que causó la fuga cross-tenant de v194
-- (vista sin security_invoker=true corriendo como owner y
-- bypasseando RLS) y el que motivó los REVOKE de 135/136/142
-- (funciones SECURITY DEFINER sin chequeo de empresa_id, pero
-- GRANTed a anon/authenticated) ya se corrigieron caso por caso
-- cuando se detectaron. Esta migración no corrige nada nuevo:
-- agrega las RPCs de auditoría para que ese patrón se detecte
-- solo, en vez de depender de encontrarlo de casualidad.
--
-- También agrega la RPC para el barrido "funciones fantasma"
-- (funciones que viven en producción pero no tienen ningún
-- CREATE FUNCTION rastreable en supabase/migrations/) — mismo
-- caso que forzar_cierre_turno_caja antes de trackearla en 241.
--
-- Las tres RPCs son SECURITY DEFINER (necesitan leer pg_proc/
-- pg_class, catálogos a los que authenticated/anon no tienen
-- acceso de por sí) pero SOLO se le otorga EXECUTE a service_role.
-- Nadie con la anon key puede llamarlas.
-- =============================================================

-- ── 1) Funciones SECURITY DEFINER: search_path fijo + grantees + heurística tenant ──
CREATE OR REPLACE FUNCTION public.audit_security_definer_grants()
RETURNS TABLE (
  funcion               text,
  argumentos            text,
  tiene_search_path_fijo boolean,
  anon_puede_ejecutar    boolean,
  authenticated_puede_ejecutar boolean,
  parece_filtrar_por_tenant boolean,
  riesgo_potencial       boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    p.proname::text                                            AS funcion,
    pg_get_function_arguments(p.oid)                            AS argumentos,
    EXISTS (
      SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) cfg
      WHERE cfg LIKE 'search_path=%'
    )                                                            AS tiene_search_path_fijo,
    has_function_privilege('anon', p.oid, 'EXECUTE')             AS anon_puede_ejecutar,
    has_function_privilege('authenticated', p.oid, 'EXECUTE')    AS authenticated_puede_ejecutar,
    (
      pg_get_function_arguments(p.oid) ILIKE '%empresa_id%'
      OR p.prosrc ILIKE '%empresa_id%'
      OR p.prosrc ILIKE '%get_empresa_id%'
      OR p.prosrc ILIKE '%auth_empresa_id%'
    )                                                            AS parece_filtrar_por_tenant,
    -- riesgo: corre con privilegios de owner, es invocable por
    -- anon/authenticated directo vía PostgREST, y no se ve ninguna
    -- referencia a empresa_id en la firma ni en el cuerpo.
    (
      (has_function_privilege('anon', p.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      AND NOT (
        pg_get_function_arguments(p.oid) ILIKE '%empresa_id%'
        OR p.prosrc ILIKE '%empresa_id%'
        OR p.prosrc ILIKE '%get_empresa_id%'
        OR p.prosrc ILIKE '%auth_empresa_id%'
      )
    )                                                            AS riesgo_potencial
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef = true              -- SECURITY DEFINER
    AND p.prokind = 'f'                 -- función normal (no trigger, no agregado)
  ORDER BY riesgo_potencial DESC, funcion;
$$;

-- ── 2) Vistas: security_invoker + quién puede leerlas ────────────────────────
CREATE OR REPLACE FUNCTION public.audit_views_security_invoker()
RETURNS TABLE (
  vista                  text,
  security_invoker       boolean,
  anon_puede_leer        boolean,
  authenticated_puede_leer boolean,
  riesgo_potencial       boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    c.relname::text AS vista,
    COALESCE(
      (SELECT (option_value)::boolean
         FROM pg_options_to_table(c.reloptions)
        WHERE option_name = 'security_invoker'),
      false
    ) AS security_invoker,
    has_table_privilege('anon', c.oid, 'SELECT')          AS anon_puede_leer,
    has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_puede_leer,
    (
      NOT COALESCE(
        (SELECT (option_value)::boolean
           FROM pg_options_to_table(c.reloptions)
          WHERE option_name = 'security_invoker'),
        false
      )
      AND (has_table_privilege('anon', c.oid, 'SELECT')
           OR has_table_privilege('authenticated', c.oid, 'SELECT'))
    ) AS riesgo_potencial  -- exactamente el patrón de v124 y v194
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'v'
  ORDER BY riesgo_potencial DESC, vista;
$$;

-- ── 3) Funciones vivas en public (para diff contra el repo) ──────────────────
CREATE OR REPLACE FUNCTION public.audit_funciones_vivas()
RETURNS TABLE (
  funcion        text,
  argumentos     text,
  es_security_definer boolean,
  hash_cuerpo    text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    p.proname::text,
    pg_get_function_arguments(p.oid),
    p.prosecdef,
    md5(coalesce(p.prosrc, ''))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
  ORDER BY p.proname;
$$;

-- ── Grants: solo service_role. Nada de anon/authenticated. ───────────────────
REVOKE ALL ON FUNCTION public.audit_security_definer_grants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_views_security_invoker()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_funciones_vivas()         FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.audit_security_definer_grants() TO service_role;
GRANT EXECUTE ON FUNCTION public.audit_views_security_invoker()  TO service_role;
GRANT EXECUTE ON FUNCTION public.audit_funciones_vivas()         TO service_role;

COMMENT ON FUNCTION public.audit_security_definer_grants() IS
  'Etapa 0: detecta funciones SECURITY DEFINER invocables por anon/authenticated sin evidencia de filtro por empresa_id — mismo patrón que motivó los REVOKE de 135/136/142. Solo service_role puede llamarla.';
COMMENT ON FUNCTION public.audit_views_security_invoker() IS
  'Etapa 0: detecta vistas sin security_invoker=true expuestas a anon/authenticated — mismo patrón de fuga cross-tenant que v124 y v194. Solo service_role puede llamarla.';
COMMENT ON FUNCTION public.audit_funciones_vivas() IS
  'Etapa 0: lista funciones public vivas en la base para diffear contra los CREATE FUNCTION trackeados en supabase/migrations/ y detectar "funciones fantasma" (caso forzar_cierre_turno_caja, trackeada recién en 241). Solo service_role puede llamarla.';

-- Registro en la tabla de tracking de migraciones del proyecto
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '249_etapa0_audit_security_definer_y_funciones_fantasma.sql',
  '249',
  'claude_assistant',
  'Etapa 0 del plan por etapas (Higiene de base): agrega 3 RPCs de auditoría (SECURITY DEFINER sin tenant check, vistas sin security_invoker, funciones fantasma) consumidas por scripts/audit-security-grants.js y scripts/audit-funciones-fantasma.js. Solo service_role puede ejecutarlas.'
)
ON CONFLICT DO NOTHING;
