-- ============================================================
-- ⚠️ ADVERTENCIA (agregada post-mortem, 2026-06-26):
-- Esta migración rompió en producción 67 de las 72 funciones que
-- modificó. Les puso SET search_path = '' (vacío), pero esas
-- funciones usan nombres de tabla SIN calificar (ej: INSERT INTO
-- pedidos, FROM stock) — con search_path vacío, Postgres no puede
-- resolverlos y todas esas funciones empezaron a fallar con
-- "relation X does not exist" (detectado al confirmar un pedido
-- desde el portal cliente).
--
-- El fix correcto para el warning de Supabase Advisor es fijar el
-- search_path a un valor explícito como 'public', no a ''.
--
-- CORREGIDO POR: 108_fix_search_path_security_definer.sql
-- No revertir ni volver a aplicar este archivo tal cual está sin
-- aplicar también el 108 a continuación.
-- ============================================================

-- ============================================================
-- 107_functions_search_path_fix.sql
-- Seguridad: 72 funciones SECURITY DEFINER con search_path = ''
-- Elimina warnings de Supabase Advisor sobre search_path mutable
-- Aplicado en prod: 2026-06-24
-- ============================================================
-- Funciones corregidas (72):
-- _audit_productos_precio, _audit_stock, _notif_push_async,
-- _trigger_notif_nuevo_pedido, _trigger_notif_stock_critico,
-- acreditar_puntos, ajustar_stock, analizar_stock_autonomo,
-- analizar_stock_predictivo, aplicar_nota_credito_cta_cte,
-- auth_empresa_id, auth_usuario_id, auth_usuario_rol,
-- calcular_ciclos_cliente, calcular_deuda_cliente,
-- calcular_score_cliente, cancelar_pedido, canjear_puntos,
-- cerrar_turno_caja, check_schema_columns, check_schema_functions,
-- conciliar_oc_factura, conciliar_recepcion,
-- confirmar_despacho_stock, confirmar_pedido,
-- confirmar_pedido_sugerido, crear_nota_credito, crear_orden_compra,
-- crear_pedido_cliente, desactivar_oferta_liquidacion,
-- detectar_anomalias_auditoria, emitir_nota_cta_cte,
-- es_admin, es_chofer, fn_audit_generic,
-- fn_cierre_financiero_entrega, generar_ofertas_liquidacion,
-- generar_pedido_sugerido_cliente, generar_pedidos_sugeridos,
-- get_empresa_id, get_facturacion_config, get_push_secret,
-- get_rol_usuario, importar_productos_lote,
-- incrementar_stock_reservado, liberar_stock_reservado,
-- limpiar_refresh_tokens_expirados, marcar_preparado,
-- obtener_kpis_dashboard, obtener_sugeridos_para_whatsapp,
-- obtener_suscriptores_push, recepcionar_orden_compra,
-- registrar_auditoria, registrar_cobro, registrar_cobro_completo,
-- registrar_movimiento_cta_cte, registrar_notif_sugerencia,
-- registrar_pago_proveedor, registrar_venta_pos,
-- reservar_remito_nro, resumen_turno_caja, rpc_crear_pedido,
-- siguiente_numero_comprobante, tg_score_cobro, tg_score_entrega,
-- transferir_stock_entre_depositos, trigger_notif_pedido_estado,
-- trigger_push_nuevo_pedido, trigger_push_stock_critico,
-- validar_aplicacion_pago_proveedor, validar_token_portal_proveedor
-- ============================================================

-- Este fix fue aplicado via CREATE OR REPLACE FUNCTION con
-- SET search_path = '' en cada función SECURITY DEFINER.
-- Resultado: 0 warnings en Supabase Advisor post-aplicación.

-- Las funciones en prod ya tienen proconfig = ['search_path=""']
-- No se requiere re-ejecutar si la DB ya está en este estado.

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND prosecdef = true
    AND proconfig @> ARRAY['search_path=""'];

  RAISE NOTICE '107_functions_search_path_fix: % funciones SECURITY DEFINER con search_path="" verificadas.', v_count;
END;
$$;
