-- ─────────────────────────────────────────────────────────────────────────
-- 267_fix_grants_fn_cta_cte_kpis_y_lista.sql
-- Auditoría de filtros v280: cierra la misma nota de seguridad ya vista
-- en la migración 258 (fn_productos_lista / fn_productos_contadores),
-- ahora detectada en las RPC agregadas por la migración 266.
--
-- fn_cta_cte_kpis() y fn_cta_cte_lista(...) son SECURITY DEFINER y
-- resuelven el tenant vía public.get_empresa_id() (JWT de sesión). Al
-- verificar pg_proc.proacl directo tras aplicar la 266 se confirmó que
-- CREATE FUNCTION dejó el EXECUTE por defecto otorgado a PUBLIC (y por
-- herencia a anon/authenticated) — la migración 266 solo agregó el GRANT
-- explícito a authenticated/service_role sin revocar antes, mismo
-- patrón heredado ya corregido en Fase 18 y en la 258.
--
-- Son RPCs de panel admin (pantalla Cuenta Corriente / Cobranzas): se
-- llaman siempre con el JWT de un usuario admin autenticado, nunca desde
-- anon ni desde los portales cliente/chofer/proveedor. Se revoca de
-- PUBLIC y anon explícitamente y se deja el EXECUTE solo para
-- authenticated y service_role.
-- ─────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.fn_cta_cte_kpis()
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.fn_cta_cte_lista(text, text, integer, integer)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_cta_cte_kpis()
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_cta_cte_lista(text, text, integer, integer)
  TO authenticated, service_role;
