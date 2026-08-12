-- El default privilege del schema public (rol postgres) le da EXECUTE a
-- anon automáticamente en toda función nueva. Las tres funciones tocadas
-- por 443/444 (ajustar_stock, registrar_conteo_stock,
-- registrar_cobro_completo) quedaron con anon ejecutable tras el
-- DROP+CREATE — mismo patrón que ya se vino corrigiendo en el proyecto
-- (fix_sec012_revocar_exec_anon_funciones_de_negocio y afines). Estas son
-- funciones de negocio que mutan stock/cta_cte — solo authenticated y
-- service_role deben poder ejecutarlas.

REVOKE EXECUTE ON FUNCTION public.ajustar_stock(uuid, uuid, numeric, tipo_movimiento, text, text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.registrar_conteo_stock(uuid, uuid, numeric, text, text, uuid, text, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.registrar_cobro_completo(uuid, uuid, numeric, text, text, text, uuid, uuid, jsonb, text) FROM anon;
