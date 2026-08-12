-- 143_revoke_execute_rpcs_sin_tenant_check_lote3.sql
-- Aplicada en Supabase: 2026-06-30 (auditoría)
--
-- Tercer lote de la auditoría de permisos (continúa 135/136/142).
-- 15 funciones SECURITY DEFINER, dueño 'postgres', sin ningún chequeo interno
-- de auth.uid()/empresa, otorgadas a anon y/o authenticated, y verificadas
-- como NO llamadas desde ningún cliente browser:
--
--   * get_push_secret() y obtener_suscriptores_push(): solo se usan
--     internamente desde trigger_push_nuevo_pedido/trigger_push_stock_critico
--     (mismo owner 'postgres', no necesitan grant externo). Antes de este fix,
--     CUALQUIERA podía llamar get_push_secret() sin login y obtener el secreto
--     interno de push, y obtener_suscriptores_push() exponía endpoint/p256dh/
--     auth_key de TODOS los usuarios de TODAS las empresas: fuga de
--     credenciales de push notification cross-tenant.
--   * rpc_registrar_devolucion_pos() y transferir_stock_entre_depositos():
--     cero validación de empresa/usuario, solo se llaman desde
--     lib/handlers/pos.js con service_role. Antes de este fix, cualquiera
--     podía generar devoluciones POS o mover stock entre depósitos de
--     CUALQUIER empresa adivinando UUIDs.
--   * saas_config_actualizar, saas_confirmar_pago, saas_dashboard_kpis,
--     saas_panel_listar, get_saas_panel_admin: panel superadmin, solo
--     lib/handlers/saas.js con service_role (get_saas_panel_admin no tiene
--     ningún caller, código muerto).
--   * saas_cron_facturacion_mensual, saas_cron_suspender_morosos,
--     saas_cron_trial_check: confirmado en cron.job que corren vía pg_cron
--     con username='postgres', no necesitan grant a anon/authenticated.
--   * registrar_empresa_saas, setup_inicial_empresa: el formulario público
--     de alta llama al endpoint Vercel, que internamente usa
--     SUPABASE_SERVICE_ROLE_KEY para correr la RPC. El browser nunca llama
--     la RPC directo.
--   * limpiar_refresh_tokens_expirados: sin caller, cleanup interno.
--
-- Verificado funcionalmente post-cambio: saas_panel_listar() = 3 filas,
-- saas_dashboard_kpis() responde OK.

REVOKE EXECUTE ON FUNCTION public.get_push_secret() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.obtener_suscriptores_push(text, uuid[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_registrar_devolucion_pos(uuid, jsonb, text, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.transferir_stock_entre_depositos(uuid, uuid, uuid, numeric, uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_config_actualizar(text, text, text, text, numeric, integer, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_confirmar_pago(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_cron_facturacion_mensual() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_cron_suspender_morosos() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_cron_trial_check() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_dashboard_kpis() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_panel_listar() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_saas_panel_admin() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.registrar_empresa_saas(text, text, text, text, text, uuid, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.setup_inicial_empresa(text, text, text, text, text, uuid, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.limpiar_refresh_tokens_expirados() FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_push_secret() TO service_role;
GRANT EXECUTE ON FUNCTION public.obtener_suscriptores_push(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_registrar_devolucion_pos(uuid, jsonb, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.transferir_stock_entre_depositos(uuid, uuid, uuid, numeric, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_config_actualizar(text, text, text, text, numeric, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_confirmar_pago(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_cron_facturacion_mensual() TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_cron_suspender_morosos() TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_cron_trial_check() TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_dashboard_kpis() TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_panel_listar() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_saas_panel_admin() TO service_role;
GRANT EXECUTE ON FUNCTION public.registrar_empresa_saas(text, text, text, text, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.setup_inicial_empresa(text, text, text, text, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.limpiar_refresh_tokens_expirados() TO service_role;
