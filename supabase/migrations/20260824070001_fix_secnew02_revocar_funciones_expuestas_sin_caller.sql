-- SECNEW-02 (2026-08-24) — encontrado y corregido directo en producción vía
-- MCP de Supabase. Este archivo reconstruye esa migración (2 pasos, mismo
-- criterio que sesión 9 usó para SEC-005..014). Ver
-- AUDITORIA_2026/00_PLAN_MAESTRO.md, fila SECNEW-02.
--
-- conciliar_oc_factura: exponía a anon/authenticated datos de conciliación
--   de compras (cantidades, precios, discrepancias) de cualquier empresa,
--   sin validar p_empresa_id contra la sesión.
-- fn_generar_alertas_stock_autonomo: función de ESCRITURA (crea
--   ordenes_compra + alertas_stock) sin ningún caller real en el código ni
--   en pg_cron, expuesta y explotable para generar órdenes falsas en
--   cualquier empresa.
-- fn_asegurar_piso_reciente_demo: mitigada por diseño (exige
--   empresas.es_demo = true internamente) pero sin caller legítimo sin
--   sesión — revocada por defensa en profundidad.
--
-- Los únicos callers reales de las 3 (lib/repos/cc-proveedores.js vía
-- service_role, y las llamadas internas desde alta_factura_proveedor/
-- editar_factura_proveedor, ambas propiedad de postgres) no se ven
-- afectados por este REVOKE.

REVOKE EXECUTE ON FUNCTION public.conciliar_oc_factura(uuid, uuid, uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_generar_alertas_stock_autonomo(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_asegurar_piso_reciente_demo(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.conciliar_oc_factura(uuid, uuid, uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_generar_alertas_stock_autonomo(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_asegurar_piso_reciente_demo(uuid) TO service_role;
