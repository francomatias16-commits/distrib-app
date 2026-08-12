-- ─────────────────────────────────────────────────────────────────────────
-- 258_fix_grants_fn_productos_lista_contadores.sql
-- Auditoría de filtros v280: cierra la nota de seguridad dejada pendiente
-- en la migración 256 (rpc_productos_lista_server_side).
--
-- fn_productos_lista(...) y fn_productos_contadores() son SECURITY DEFINER
-- y resuelven el tenant vía public.get_empresa_id() -> dependen del JWT de
-- sesión (request.jwt.claims) para aislar por empresa. Al reconstruir su
-- definición desde la base real se detectó que el EXECUTE seguía otorgado
-- a PUBLIC (y por herencia a anon/authenticated), mismo patrón de grants
-- heredados ya visto y corregido en Fase 18 para otras funciones.
--
-- Estas dos son RPCs de panel admin: se llaman siempre con el JWT de un
-- usuario admin autenticado a través del cliente de Supabase del backend
-- (api/index.js), nunca desde anon ni desde los portales cliente/chofer/
-- proveedor. No hay caso de uso legítimo para anon/authenticated acá, así
-- que se revoca de PUBLIC (que cubre anon y authenticated) y se deja el
-- EXECUTE explícito solo para los roles que sí las usan.
--
-- Nota: se otorga a `authenticated` (no solo service_role) porque el
-- patrón del proyecto es que el backend usa el JWT del usuario logueado al
-- llamar RPCs de admin (SECURITY DEFINER + get_empresa_id() ya hace el
-- aislamiento por tenant), no el rol de servicio. Se revoca igual de
-- PUBLIC y anon explícitamente para dejarlo asentado y no depender de que
-- "authenticated hereda de PUBLIC" sea la única barrera.
-- ─────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer)
  FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.fn_productos_contadores()
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer)
  TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_productos_contadores()
  TO authenticated, service_role;
