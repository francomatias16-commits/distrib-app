-- ─────────────────────────────────────────────────────────────────────────
-- 348_fix_doble_conteo_productos_en_stock.sql
-- Ya aplicada en el proyecto Supabase (jgiquzjwoedmzwqgzubr) vía apply_migration.
-- Se agrega acá para mantener el historial de migraciones del repo sincronizado
-- (mismo criterio que la migración 256).
--
-- Bug: fn_reportes_stock_kpis contaba filas de stock (producto x depósito)
-- en vez de productos distintos para productos_en_stock/productos_criticos.
-- Con empresas de 2+ depósitos, un mismo producto podía tener varias filas
-- de stock y se contaba una vez por depósito, inflando la tarjeta
-- "Productos en Stock" (ej.: 2000 filas quedaban mostradas como 2000
-- "productos" cuando en realidad eran 1000 productos distintos).
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
    SELECT s.producto_id, s.cantidad, s.costo_promedio
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    JOIN public.productos p ON p.id = s.producto_id
    WHERE d.empresa_id = v_empresa_id
      AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
      AND (p_categoria_id IS NULL OR p.categoria_id = p_categoria_id)
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
    (SELECT COUNT(DISTINCT producto_id) FROM base WHERE cantidad < 10),
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
  'cuentan producto_id DISTINCT (no filas de stock) — con más de un depósito, un '
  'mismo producto puede tener varias filas de stock y antes se contaba una vez por '
  'depósito, inflando la tarjeta "Productos en Stock" (fix v348).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '348_fix_doble_conteo_productos_en_stock.sql', '348', 'claude-session',
  'Fix: fn_reportes_stock_kpis contaba filas de stock (producto x depósito) en vez de productos distintos para productos_en_stock/productos_criticos, duplicando la tarjeta con empresas de 2+ depósitos.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
