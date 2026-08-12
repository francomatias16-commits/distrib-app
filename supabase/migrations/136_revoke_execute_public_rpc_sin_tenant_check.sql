-- Las funciones tenían EXECUTE heredado de PUBLIC (default de Postgres para
-- funciones nuevas), no un grant explícito a anon/authenticated. Hay que
-- revocarlo de PUBLIC directamente y volver a otorgarlo solo a service_role.
REVOKE EXECUTE ON FUNCTION public.calcular_deuda_cliente(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.conciliar_oc_factura(uuid, uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.conciliar_recepcion(uuid, jsonb, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_lotes_consumir_fefo(uuid, uuid, numeric, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validar_aplicacion_pago_proveedor(numeric, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.calcular_deuda_cliente(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.conciliar_oc_factura(uuid, uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.conciliar_recepcion(uuid, jsonb, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_lotes_consumir_fefo(uuid, uuid, numeric, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.validar_aplicacion_pago_proveedor(numeric, jsonb) TO service_role;
