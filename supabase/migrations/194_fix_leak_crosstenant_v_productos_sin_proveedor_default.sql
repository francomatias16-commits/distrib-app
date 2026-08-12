-- =============================================================
-- 194_fix_leak_crosstenant_v_productos_sin_proveedor_default.sql
-- Bug crítico de seguridad encontrado al sincronizar el repo tras
-- la migración 193: la vista v_productos_sin_proveedor_default se
-- creó sin `security_invoker = true`. En Postgres, una vista sin
-- ese flag corre con los permisos de su OWNER (postgres), que
-- bypassea RLS — mismo patrón de fuga que ya se había corregido
-- antes en 124_fix_security_definer_views_cross_tenant_leak, pero
-- reintroducido acá porque la vista es nueva.
--
-- Efecto real: cualquier usuario autenticado (de CUALQUIER empresa)
-- podía ver productos_activos/sin_proveedor_default agregados de
-- TODAS las empresas del sistema, no solo la propia, porque la
-- vista ignoraba la policy productos_select (empresa_id =
-- get_empresa_id()) al correr como owner.
--
-- Fix:
--   1) ALTER VIEW ... SET (security_invoker = true) para que la
--      vista respete la RLS del rol que efectivamente consulta.
--   2) Grants: se sacan los privilegios de escritura sin sentido
--      (INSERT/UPDATE/DELETE/TRUNCATE) que quedaron por default
--      privileges del schema, y se saca el acceso de anon (esto es
--      panel admin, no debe ser público). Solo authenticated
--      conserva SELECT, ya filtrado por RLS de productos.
-- =============================================================

ALTER VIEW public.v_productos_sin_proveedor_default SET (security_invoker = true);

REVOKE ALL ON public.v_productos_sin_proveedor_default FROM anon;
REVOKE ALL ON public.v_productos_sin_proveedor_default FROM authenticated;
GRANT SELECT ON public.v_productos_sin_proveedor_default TO authenticated;

COMMENT ON VIEW public.v_productos_sin_proveedor_default IS
  'Gap de datos: productos activos sin proveedor_id_default por empresa (v193). security_invoker=true desde v194 para respetar RLS multi-tenant — antes corría como owner y filtraba cero por empresa.';
