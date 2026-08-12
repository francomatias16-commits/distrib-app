-- Plan de comercialización, ítem 1.2 (auditoría RLS completa).
-- Estas 7 funciones SECURITY DEFINER no validan empresa_id internamente,
-- pero estaban GRANTed a anon/authenticated. Como todo el código de la app
-- las invoca exclusivamente desde handlers con SUPABASE_SERVICE_ROLE_KEY
-- (que ignora estos GRANTs), revocar el acceso de anon/authenticated no
-- rompe nada y cierra la posibilidad de que cualquiera con la anon key
-- pública llame estas RPCs directo vía PostgREST con un cliente_id/turno_id/
-- orden_id de OTRA empresa (cross-tenant write/read).
REVOKE EXECUTE ON FUNCTION public.rpc_crear_pedido(uuid, uuid, uuid, jsonb, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calcular_deuda_cliente(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cerrar_turno_caja(uuid, numeric) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resumen_turno_caja(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.conciliar_oc_factura(uuid, uuid, numeric) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.conciliar_recepcion(uuid, jsonb, numeric) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validar_aplicacion_pago_proveedor(numeric, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_lotes_consumir_fefo(uuid, uuid, numeric, text, uuid) FROM anon, authenticated;
