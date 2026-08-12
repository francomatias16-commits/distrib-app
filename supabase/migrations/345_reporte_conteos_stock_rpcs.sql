-- =============================================================================
-- 345_reporte_conteos_stock_rpcs.sql
--
-- Pantalla de reporte sobre conteos_stock (v344): KPIs agregados y ranking
-- de productos con más diferencia, calculados en SQL en vez de traer todas
-- las filas al cliente (mismo criterio que fn_reportes_stock_kpis /
-- fn_reportes_stock_distribucion).
--
-- Aplicado directamente en producción el 2026-07-16 (sesión anterior).
-- Este archivo deja el snapshot local en sync con el estado ya aplicado.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_conteos_stock_kpis(
  p_deposito_id uuid DEFAULT NULL,
  p_motivo      text DEFAULT NULL,
  p_desde       date DEFAULT NULL,
  p_hasta       date DEFAULT NULL
)
RETURNS TABLE (
  total_conteos       bigint,
  con_diferencia      bigint,
  diferencia_acumulada numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (get_rol_usuario() IN ('admin', 'dueno', 'depositero')) THEN
    RAISE EXCEPTION 'Sin autorización';
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE cs.diferencia <> 0)::bigint,
    COALESCE(SUM(cs.diferencia), 0)
  FROM public.conteos_stock cs
  WHERE cs.empresa_id = get_empresa_id()
    AND (p_deposito_id IS NULL OR cs.deposito_id = p_deposito_id)
    AND (p_motivo IS NULL OR cs.motivo = p_motivo)
    AND (p_desde IS NULL OR cs.created_at >= p_desde::timestamptz)
    AND (p_hasta IS NULL OR cs.created_at < (p_hasta + 1)::timestamptz);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_conteos_stock_kpis(uuid, text, date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_conteos_stock_top_productos(
  p_deposito_id uuid DEFAULT NULL,
  p_motivo      text DEFAULT NULL,
  p_desde       date DEFAULT NULL,
  p_hasta       date DEFAULT NULL,
  p_limit       integer DEFAULT 10
)
RETURNS TABLE (
  producto_id      uuid,
  producto_nombre  text,
  cantidad_conteos bigint,
  diferencia_neta  numeric,
  diferencia_abs_total numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (get_rol_usuario() IN ('admin', 'dueno', 'depositero')) THEN
    RAISE EXCEPTION 'Sin autorización';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.nombre,
    COUNT(*)::bigint,
    COALESCE(SUM(cs.diferencia), 0),
    COALESCE(SUM(ABS(cs.diferencia)), 0)
  FROM public.conteos_stock cs
  JOIN public.productos p ON p.id = cs.producto_id
  WHERE cs.empresa_id = get_empresa_id()
    AND (p_deposito_id IS NULL OR cs.deposito_id = p_deposito_id)
    AND (p_motivo IS NULL OR cs.motivo = p_motivo)
    AND (p_desde IS NULL OR cs.created_at >= p_desde::timestamptz)
    AND (p_hasta IS NULL OR cs.created_at < (p_hasta + 1)::timestamptz)
    AND cs.diferencia <> 0
  GROUP BY p.id, p.nombre
  ORDER BY SUM(ABS(cs.diferencia)) DESC
  LIMIT p_limit;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_conteos_stock_top_productos(uuid, text, date, date, integer) TO authenticated;

COMMENT ON FUNCTION public.fn_conteos_stock_kpis IS
  'KPIs agregados del reporte de conteos de stock (total, con diferencia, diferencia acumulada), filtrable por depósito/motivo/rango de fechas.';
COMMENT ON FUNCTION public.fn_conteos_stock_top_productos IS
  'Ranking de productos con más diferencia acumulada (valor absoluto) en conteos de stock, para el reporte de conteos históricos.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '345_reporte_conteos_stock_rpcs.sql', '345', 'claude-session', 'RPCs fn_conteos_stock_kpis y fn_conteos_stock_top_productos para la pantalla de reporte de Historial de Conteos de Stock en reportes-stock.html')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
