-- Auditoría 2026, hallazgo del Security Advisor (rls_enabled_no_policy),
-- detectado en el chequeo post-cierre de la Etapa 2 (sec005-014). Aplicada
-- en producción como "fix_sec015_revoke_table_grants_asistente_y_demo_snapshots".
--
-- Hallazgo: asistente_articulos, asistente_uso y demo_snapshots tienen RLS
-- habilitado pero sin políticas, lo cual ya bloquea el acceso (deny-all)
-- para cualquier rol que no sea postgres/service_role. Pero igual que
-- refresh_tokens/tokens_wsaa antes de 198_revoke_table_grants_secret_tables,
-- conservaban el GRANT de tabla por defecto a anon/authenticated —
-- redundante con RLS hoy, pero un riesgo latente si en el futuro alguien
-- agrega una política amplia sin pensarlo dos veces, o si RLS se
-- deshabilita por error.
--
-- Verificado antes de aplicar:
--  - asistente_articulos: solo se escribe desde
--    scripts/generar-embeddings-asistente.js, que exige explícitamente
--    SUPABASE_SERVICE_ROLE_KEY (no anon). Se lee vía
--    buscar_articulos_asistente(), SECURITY DEFINER (no depende del
--    grant de tabla).
--  - asistente_uso / demo_snapshots: sin referencias en frontend/ ni
--    api/index.js; demo_snapshots se escribe solo desde
--    fn_snapshot_demo*/fn_reset_demo*, todas SECURITY DEFINER (tampoco
--    dependen del grant de tabla a anon/authenticated).
-- service_role no se ve afectado por este REVOKE.

REVOKE ALL ON public.asistente_articulos FROM anon, authenticated;
REVOKE ALL ON public.asistente_uso FROM anon, authenticated;
REVOKE ALL ON public.demo_snapshots FROM anon, authenticated;
