-- Cierra el hallazgo de seguridad documentado en la migración 620
-- (conciliacion_saldos_stock_etapa4), Etapa 4 del plan de auditoría de
-- integridad financiera: conciliar_cta_cte(p_empresa_id) y
-- conciliar_stock_por_producto(p_empresa_id) quedaron con EXECUTE para
-- anon/authenticated por el default de Postgres al crear la función
-- (mismo patrón ya visto y corregido antes, ver migraciones
-- "revoke_execute_rpc_sin_tenant_check*" y 514).
--
-- Ambas son SECURITY DEFINER y reciben p_empresa_id como parámetro sin
-- validarlo contra la empresa del caller (auth.uid() / get_empresa_id()).
-- Sin este revoke, cualquier usuario autenticado — y potencialmente
-- anónimo, vía la anon key pública — podría invocarlas directo por
-- PostgREST pasando el empresa_id de OTRA empresa y leer su conciliación
-- de saldo_deuda o de stock (cross-tenant read).
--
-- No rompe nada: los únicos consumidores reales son
-- `npm run conciliar:cta-cte` / `npm run conciliar:stock`
-- (scripts/conciliar-cta-cte.js, scripts/conciliar-stock.js), que llaman
-- con SUPABASE_SERVICE_ROLE_KEY — la service role ignora estos GRANTs por
-- diseño de Postgres/Supabase, así que sigue funcionando igual.

REVOKE EXECUTE ON FUNCTION public.conciliar_cta_cte(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.conciliar_cta_cte(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.conciliar_cta_cte(uuid) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.conciliar_stock_por_producto(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.conciliar_stock_por_producto(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.conciliar_stock_por_producto(uuid) FROM authenticated;

COMMENT ON FUNCTION public.conciliar_cta_cte(uuid) IS
  'Etapa 4 del plan de auditoría de integridad financiera: recalcula clientes.saldo_deuda desde cta_cte y compara contra lo mostrado. Uso exclusivo de scripts/conciliar-cta-cte.js con SUPABASE_SERVICE_ROLE_KEY. EXECUTE revocado de PUBLIC/anon/authenticated (12/9, hallazgo documentado en migración 620): SECURITY DEFINER que recibe empresa_id sin validar contra el caller, no debe ser invocable por un usuario autenticado ni anónimo vía PostgREST.';

COMMENT ON FUNCTION public.conciliar_stock_por_producto(uuid) IS
  'Etapa 4 del plan de auditoría de integridad financiera: recalcula stock por producto desde movimientos_stock y compara contra lo mostrado. Uso exclusivo de scripts/conciliar-stock.js con SUPABASE_SERVICE_ROLE_KEY. EXECUTE revocado de PUBLIC/anon/authenticated (12/9, hallazgo documentado en migración 620): SECURITY DEFINER que recibe empresa_id sin validar contra el caller, no debe ser invocable por un usuario autenticado ni anónimo vía PostgREST.';
