-- ─────────────────────────────────────────────────────────────────────────
-- 349_fix_criticos_usa_stock_minimo_real.sql
-- Ya aplicada en el proyecto Supabase (jgiquzjwoedmzwqgzubr) vía apply_migration.
--
-- Bug: productos_criticos en fn_reportes_stock_kpis usaba un umbral fijo
-- "cantidad < 10" para TODOS los productos, ignorando la columna
-- productos.stock_minimo que ya usa el resto del sistema (alertas de
-- stock, punto de pedido predictivo, fn_kpis_dashboard) como umbral real
-- por producto. En la auditoría se detectó que ~976 de 1001 productos de
-- una empresa tenían un stock_minimo distinto de 10 (promedio ~24.5).
--
-- Fix: se agrupa por producto (disponible total = cantidad -
-- cantidad_reservada, sumado entre depósitos) y se compara contra
-- GREATEST(stock_minimo, 5), mismo criterio que fn_kpis_dashboard.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_reportes_stock_kpis(
  p_deposito_id uuid DEFAULT NULL,
  p_categoria_id uuid DEFAULT NULL
)
RETURNS TABLE (
  valor_total numeric,
  productos_en_stock bigint,
  productos_criticos bigint,
  valor_total_global numeric,
  productos_en_stock_global bigint,
  rotacion_promedio numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT s.producto_id, s.cantidad, s.costo_promedio, s.cantidad_reservada, p.stock_minimo
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    JOIN public.productos p ON p.id = s.producto_id
    WHERE d.empresa_id = v_empresa_id
      AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
      AND (p_categoria_id IS NULL OR p.categoria_id = p_categoria_id)
  ),
  base_por_producto AS (
    -- agrupamos por producto porque el crítico se define sobre el disponible
    -- TOTAL del producto (sumado entre depósitos), no fila por fila de stock
    SELECT
      producto_id,
      SUM(cantidad - COALESCE(cantidad_reservada, 0)) AS disponible_total,
      MAX(stock_minimo) AS minimo
    FROM base
    GROUP BY producto_id
  ),
  global AS (
    SELECT s.producto_id, s.cantidad, s.costo_promedio
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = v_empresa_id
  ),
  mov AS (
    SELECT COALESCE(SUM(ABS(m.cantidad)), 0) AS total_movido, COUNT(*) AS n_mov
    FROM public.movimientos_stock m
    JOIN public.depositos d ON d.id = m.deposito_id
    WHERE d.empresa_id = v_empresa_id
      AND m.created_at >= now() - interval '30 days'
      AND (p_deposito_id IS NULL OR m.deposito_id = p_deposito_id)
  )
  SELECT
    COALESCE((SELECT SUM(cantidad * costo_promedio) FROM base), 0),
    (SELECT COUNT(DISTINCT producto_id) FROM base WHERE cantidad > 0),
    -- crítico real: disponible total del producto <= su propio stock_minimo
    -- (con piso de 5 unidades para productos con stock_minimo en 0, igual
    -- que en fn_kpis_dashboard)
    (SELECT COUNT(*) FROM base_por_producto WHERE disponible_total <= GREATEST(COALESCE(minimo, 0), 5)),
    COALESCE((SELECT SUM(cantidad * costo_promedio) FROM global), 0),
    (SELECT COUNT(DISTINCT producto_id) FROM global WHERE cantidad > 0),
    CASE WHEN (SELECT COUNT(DISTINCT producto_id) FROM base) > 0
      THEN ROUND((SELECT total_movido FROM mov) / (SELECT COUNT(DISTINCT producto_id) FROM base), 0)
      ELSE 0
    END;
END;
$function$;

COMMENT ON FUNCTION public.fn_reportes_stock_kpis IS
  'KPIs agregados de Stock/Reportes de stock. productos_en_stock/productos_criticos '
  'cuentan producto_id DISTINCT (fix v348). productos_criticos ahora compara el '
  'disponible total del producto (sumado entre depositos, cantidad - cantidad_reservada) '
  'contra su propio stock_minimo (con piso de 5), igual criterio que fn_kpis_dashboard, '
  'en vez del umbral fijo "cantidad < 10" que no reflejaba el stock_minimo real por '
  'producto (fix v349).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '349_fix_criticos_usa_stock_minimo_real.sql', '349', 'claude-session',
  'Fix: productos_criticos en fn_reportes_stock_kpis usaba umbral fijo cantidad < 10 en vez del stock_minimo real de cada producto. Ahora agrupa por producto (disponible = cantidad - cantidad_reservada sumado entre depositos) y compara contra GREATEST(stock_minimo, 5), consistente con fn_kpis_dashboard.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
