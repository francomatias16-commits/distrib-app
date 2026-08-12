-- 142_revoke_execute_rpcs_sin_tenant_check_lote2.sql
-- Aplicada en Supabase: 2026-06-30 (auditoría)
--
-- Continuación de 135/136. Esas migraciones cubrieron 8 RPCs SECURITY DEFINER
-- que no validaban empresa_id internamente; quedó pendiente un lote grande
-- (22 funciones) con el mismo patrón de riesgo: SECURITY DEFINER, reciben
-- p_empresa_id como parámetro sin verificar contra el llamador (sin
-- assert_empresa_access ni auth.uid()), y estaban con EXECUTE otorgado a
-- anon y/o authenticated.
--
-- Verificado en el código (grep en lib/handlers/*.js) que TODAS estas
-- funciones se invocan exclusivamente desde handlers usando
-- SUPABASE_SERVICE_ROLE_KEY (supabase / supabaseAdmin = createClient con
-- service role). Ninguna depende de que anon/authenticated tengan EXECUTE
-- directo via PostgREST. Revocar no rompe nada de la app y cierra la
-- posibilidad de que cualquiera con la anon key pública (visible en
-- cualquier bundle de frontend) llame estas RPCs directo con un
-- empresa_id/cliente_id de OTRO tenant.
--
-- Incluye RPCs especialmente sensibles: saas_suspender_empresa,
-- saas_empresa_cancelar, saas_empresa_cambiar_precio, saas_empresa_reactivar
-- (cualquiera podía suspender/cancelar/cambiar precio de CUALQUIER empresa
-- sin login) y registrar_venta_pos / sincronizar_venta_offline / recepcionar_orden_compra
-- / crear_nota_credito / emitir_nota_cta_cte / aplicar_nota_credito_cta_cte
-- (escritura financiera/stock cross-tenant sin autenticación).
--
-- Verificado funcionalmente post-cambio: saas_panel_listar() sigue
-- devolviendo las 3 empresas (no depende de estos grants, usa service_role).

REVOKE EXECUTE ON FUNCTION public._notif_push_async(uuid, text, text, text, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.analizar_stock_autonomo(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.analizar_stock_predictivo(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.aplicar_nota_credito_cta_cte(uuid, uuid, text, text, date, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calcular_ciclos_cliente(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calcular_score_cliente(uuid, uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.confirmar_pedido_sugerido(uuid, uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crear_nota_credito(uuid, uuid, text, text, jsonb, uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.desactivar_oferta_liquidacion(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.emitir_nota_cta_cte(uuid, uuid, text, numeric, text, date) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generar_pedido_sugerido_cliente(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.obtener_sugeridos_para_whatsapp(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recepcionar_orden_compra(uuid, uuid, jsonb, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.registrar_venta_pos(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reservar_remito_nro(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_crear_factura(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_empresa_cambiar_precio(uuid, numeric) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_empresa_cancelar(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_empresa_reactivar(uuid, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.saas_suspender_empresa(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sincronizar_venta_offline(uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, text) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public._notif_push_async(uuid, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.analizar_stock_autonomo(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.analizar_stock_predictivo(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.aplicar_nota_credito_cta_cte(uuid, uuid, text, text, date, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.calcular_ciclos_cliente(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.calcular_score_cliente(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirmar_pedido_sugerido(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.crear_nota_credito(uuid, uuid, text, text, jsonb, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.desactivar_oferta_liquidacion(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.detectar_anomalias_auditoria(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.emitir_nota_cta_cte(uuid, uuid, text, numeric, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.generar_pedido_sugerido_cliente(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.obtener_sugeridos_para_whatsapp(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recepcionar_orden_compra(uuid, uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.registrar_venta_pos(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, numeric, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.reservar_remito_nro(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_crear_factura(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_empresa_cambiar_precio(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_empresa_cancelar(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_empresa_reactivar(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.saas_suspender_empresa(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.sincronizar_venta_offline(uuid, uuid, uuid, uuid, jsonb, jsonb, numeric, text) TO service_role;
