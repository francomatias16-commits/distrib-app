-- ============================================================
-- 108_fix_search_path_security_definer.sql
-- Corrige el bug introducido por 107_functions_search_path_fix.sql.
--
-- 107 le puso SET search_path = '' a 67 funciones SECURITY DEFINER
-- que usan nombres de tabla sin calificar (ej: INSERT INTO pedidos),
-- lo que las rompió en producción ("relation X does not exist").
--
-- Este archivo fija search_path = 'public' en esas mismas 67
-- funciones. Sigue siendo válido para el linter de Supabase Advisor
-- (que solo exige un search_path explícito, no específicamente '').
--
-- Aplicado en prod: 2026-06-26 (vía Supabase MCP, no por deploy/ZIP).
-- Verificado post-aplicación: 0 funciones con search_path="" restantes.
-- ============================================================

ALTER FUNCTION public._audit_productos_precio() SET search_path = 'public';
ALTER FUNCTION public._audit_stock() SET search_path = 'public';
ALTER FUNCTION public._notif_push_async(uuid,text,text,text,jsonb) SET search_path = 'public';
ALTER FUNCTION public._trigger_notif_nuevo_pedido() SET search_path = 'public';
ALTER FUNCTION public._trigger_notif_stock_critico() SET search_path = 'public';
ALTER FUNCTION public.acreditar_puntos(uuid,uuid,integer,text,text,uuid,text) SET search_path = 'public';
ALTER FUNCTION public.ajustar_stock(uuid,uuid,numeric,text) SET search_path = 'public';
ALTER FUNCTION public.analizar_stock_autonomo(uuid) SET search_path = 'public';
ALTER FUNCTION public.analizar_stock_predictivo(uuid) SET search_path = 'public';
ALTER FUNCTION public.aplicar_nota_credito_cta_cte(uuid,uuid,text,text,date,text) SET search_path = 'public';
ALTER FUNCTION public.auth_empresa_id() SET search_path = 'public';
ALTER FUNCTION public.auth_usuario_id() SET search_path = 'public';
ALTER FUNCTION public.auth_usuario_rol() SET search_path = 'public';
ALTER FUNCTION public.calcular_ciclos_cliente(uuid) SET search_path = 'public';
ALTER FUNCTION public.calcular_deuda_cliente(uuid) SET search_path = 'public';
ALTER FUNCTION public.calcular_score_cliente(uuid,uuid,text) SET search_path = 'public';
ALTER FUNCTION public.cancelar_pedido(uuid,text) SET search_path = 'public';
ALTER FUNCTION public.cancelar_pedido(uuid) SET search_path = 'public';
ALTER FUNCTION public.canjear_puntos(uuid,uuid,integer,text,text,uuid,text) SET search_path = 'public';
ALTER FUNCTION public.cerrar_turno_caja(uuid,numeric) SET search_path = 'public';
ALTER FUNCTION public.check_schema_columns() SET search_path = 'public';
ALTER FUNCTION public.check_schema_functions() SET search_path = 'public';
ALTER FUNCTION public.conciliar_oc_factura(uuid,uuid,numeric) SET search_path = 'public';
ALTER FUNCTION public.conciliar_recepcion(uuid,jsonb,numeric) SET search_path = 'public';
ALTER FUNCTION public.confirmar_despacho_stock(uuid,uuid,numeric) SET search_path = 'public';
ALTER FUNCTION public.confirmar_pedido_sugerido(uuid,uuid,uuid) SET search_path = 'public';
ALTER FUNCTION public.confirmar_pedido(uuid,boolean) SET search_path = 'public';
ALTER FUNCTION public.crear_nota_credito(uuid,uuid,text,text,jsonb,uuid,uuid) SET search_path = 'public';
ALTER FUNCTION public.crear_orden_compra(uuid,uuid,date,text,uuid,jsonb) SET search_path = 'public';
ALTER FUNCTION public.crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date) SET search_path = 'public';
ALTER FUNCTION public.desactivar_oferta_liquidacion(uuid,uuid) SET search_path = 'public';
ALTER FUNCTION public.detectar_anomalias_auditoria(uuid,integer) SET search_path = 'public';
ALTER FUNCTION public.es_admin() SET search_path = 'public';
ALTER FUNCTION public.es_chofer() SET search_path = 'public';
ALTER FUNCTION public.fn_audit_generic() SET search_path = 'public';
ALTER FUNCTION public.fn_cierre_financiero_entrega() SET search_path = 'public';
ALTER FUNCTION public.generar_ofertas_liquidacion(uuid,boolean) SET search_path = 'public';
ALTER FUNCTION public.generar_pedido_sugerido_cliente(uuid,uuid) SET search_path = 'public';
ALTER FUNCTION public.generar_pedidos_sugeridos(uuid) SET search_path = 'public';
ALTER FUNCTION public.get_empresa_id() SET search_path = 'public';
ALTER FUNCTION public.get_facturacion_config() SET search_path = 'public';
ALTER FUNCTION public.get_push_secret() SET search_path = 'public';
ALTER FUNCTION public.get_rol_usuario() SET search_path = 'public';
ALTER FUNCTION public.incrementar_stock_reservado(uuid,uuid,numeric) SET search_path = 'public';
ALTER FUNCTION public.liberar_stock_reservado(uuid,uuid,numeric) SET search_path = 'public';
ALTER FUNCTION public.limpiar_refresh_tokens_expirados() SET search_path = 'public';
ALTER FUNCTION public.marcar_preparado(uuid) SET search_path = 'public';
ALTER FUNCTION public.obtener_kpis_dashboard(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) SET search_path = 'public';
ALTER FUNCTION public.obtener_sugeridos_para_whatsapp(uuid) SET search_path = 'public';
ALTER FUNCTION public.obtener_suscriptores_push(text,uuid[]) SET search_path = 'public';
ALTER FUNCTION public.recepcionar_orden_compra(uuid,uuid,jsonb,uuid) SET search_path = 'public';
ALTER FUNCTION public.registrar_auditoria(text,text,text,jsonb,jsonb,text) SET search_path = 'public';
ALTER FUNCTION public.registrar_cobro(uuid,uuid,numeric,text,text,text) SET search_path = 'public';
ALTER FUNCTION public.registrar_movimiento_cta_cte(uuid,uuid,text,numeric,text,timestamp with time zone) SET search_path = 'public';
ALTER FUNCTION public.registrar_notif_sugerencia(uuid,uuid,uuid,text,text,jsonb) SET search_path = 'public';
ALTER FUNCTION public.registrar_pago_proveedor(uuid,uuid,uuid,numeric,text,date,text,text,uuid) SET search_path = 'public';
ALTER FUNCTION public.registrar_venta_pos(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,numeric,numeric,numeric) SET search_path = 'public';
ALTER FUNCTION public.reservar_remito_nro(uuid,uuid) SET search_path = 'public';
ALTER FUNCTION public.resumen_turno_caja(uuid) SET search_path = 'public';
ALTER FUNCTION public.rpc_crear_pedido(uuid,uuid,uuid,jsonb,text,text) SET search_path = 'public';
ALTER FUNCTION public.siguiente_numero_comprobante(uuid,text) SET search_path = 'public';
ALTER FUNCTION public.tg_score_cobro() SET search_path = 'public';
ALTER FUNCTION public.tg_score_entrega() SET search_path = 'public';
ALTER FUNCTION public.transferir_stock_entre_depositos(uuid,uuid,uuid,numeric,uuid,text) SET search_path = 'public';
ALTER FUNCTION public.trigger_notif_pedido_estado() SET search_path = 'public';
ALTER FUNCTION public.trigger_push_nuevo_pedido() SET search_path = 'public';
ALTER FUNCTION public.trigger_push_stock_critico() SET search_path = 'public';
ALTER FUNCTION public.validar_aplicacion_pago_proveedor(numeric,jsonb) SET search_path = 'public';
ALTER FUNCTION public.validar_token_portal_proveedor(text) SET search_path = 'public';
