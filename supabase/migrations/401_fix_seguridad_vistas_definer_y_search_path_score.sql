-- =============================================================================
-- 401_fix_seguridad_vistas_definer_y_search_path_score.sql
--
-- Lote 1 de la auditoría de Supabase Advisors (seguridad):
--
-- 1) v_rentabilidad_producto, v_rentabilidad_vendedor,
--    v_comprobantes_contables_venta, v_comprobantes_contables_compra:
--    se crearon documentando "consumir solo desde el handler backend con
--    SERVICE_ROLE_KEY, nunca exponer directo por PostgREST" (v246, v245),
--    pero nunca se revocó el GRANT SELECT por defecto — anon y authenticated
--    tenían acceso de lectura directo vía /rest/v1/<vista>, sin RLS (estas
--    vistas no tienen security_invoker, así que ni siquiera un usuario
--    autenticado quedaba filtrado por su empresa_id: veía TODAS las
--    empresas). Para v_comprobantes_contables_* el dato expuesto incluía
--    CUIT y razón social de clientes/proveedores de todas las empresas,
--    accesible sin login (anon tenía SELECT).
--
--    Fix: revocar el acceso directo de anon/authenticated, dejando solo
--    service_role (que es como las consume el handler real). No cambia
--    nada para el uso legítimo actual.
--
-- 2) calcular_score_cliente: SECURITY DEFINER sin search_path fijo (mismo
--    patrón de riesgo que ya se corrigió en otras funciones vía
--    106/107/126_fix_search_path_*). Se fija a 'public' explícito.
--
-- Verificado con Supabase Advisors (security) antes/después: los 4
-- security_definer_view ERROR y el function_search_path_mutable WARN
-- desaparecieron sin tocar ninguna otra función.
-- =============================================================================

REVOKE ALL ON public.v_rentabilidad_producto        FROM anon, authenticated;
REVOKE ALL ON public.v_rentabilidad_vendedor         FROM anon, authenticated;
REVOKE ALL ON public.v_comprobantes_contables_venta  FROM anon, authenticated;
REVOKE ALL ON public.v_comprobantes_contables_compra FROM anon, authenticated;

GRANT SELECT ON public.v_rentabilidad_producto        TO service_role;
GRANT SELECT ON public.v_rentabilidad_vendedor         TO service_role;
GRANT SELECT ON public.v_comprobantes_contables_venta  TO service_role;
GRANT SELECT ON public.v_comprobantes_contables_compra TO service_role;

COMMENT ON VIEW public.v_rentabilidad_producto IS
  'Etapa 2 (Comercial y precios): margen por producto. SIN security_invoker '
  '(no filtra por empresa por sí sola) — v401: acceso restringido a '
  'service_role vía REVOKE, se consume exclusivamente desde el handler '
  'backend (api/rutas-live) que filtra empresa_id explícitamente. Antes '
  'anon/authenticated tenían SELECT directo por PostgREST sin ningún filtro '
  'de tenant.';

COMMENT ON VIEW public.v_rentabilidad_vendedor IS
  'Etapa 2 (Comercial y precios): margen por vendedor. SIN security_invoker '
  '(no filtra por empresa por sí sola) — v401: acceso restringido a '
  'service_role vía REVOKE, se consume exclusivamente desde el handler '
  'backend (api/rutas-live) que filtra empresa_id explícitamente. Antes '
  'anon/authenticated tenían SELECT directo por PostgREST sin ningún filtro '
  'de tenant.';

COMMENT ON VIEW public.v_comprobantes_contables_venta IS
  'Vista normalizada de comprobantes de venta (facturas + notas de crédito) '
  'para exportación contable. SIN security_invoker — v401: acceso '
  'restringido a service_role vía REVOKE (antes anon tenía SELECT directo '
  'por PostgREST, exponiendo CUIT/razón social de todas las empresas sin '
  'login). Se consume exclusivamente desde el handler de export contable '
  'con SERVICE_ROLE_KEY, filtrando empresa_id ahí.';

COMMENT ON VIEW public.v_comprobantes_contables_compra IS
  'Vista normalizada de comprobantes de compra (facturas de proveedor) '
  'para exportación contable. SIN security_invoker — v401: acceso '
  'restringido a service_role vía REVOKE (antes anon tenía SELECT directo '
  'por PostgREST, exponiendo CUIT/razón social de todas las empresas sin '
  'login). Se consume exclusivamente desde el handler de export contable '
  'con SERVICE_ROLE_KEY, filtrando empresa_id ahí.';

-- ── 2) search_path fijo para calcular_score_cliente (SECURITY DEFINER) ─────
ALTER FUNCTION public.calcular_score_cliente(uuid, uuid, text)
  SET search_path = 'public';

NOTIFY pgrst, 'reload schema';
