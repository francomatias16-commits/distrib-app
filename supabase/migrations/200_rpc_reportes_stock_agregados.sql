-- Fase: optimización reportes de stock (evita traer miles de filas al navegador)
-- Ya aplicada en el proyecto Supabase (jgiquzjwoedmzwqgzubr) vía apply_migration.
-- Se agrega acá para mantener el historial de migraciones del repo sincronizado.

-- fn_reportes_stock_kpis: calcula KPIs de la sección "Reportes de Stock" en SQL.
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
    SELECT s.cantidad, s.costo_promedio
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    JOIN public.productos p ON p.id = s.producto_id
    WHERE d.empresa_id = v_empresa_id
      AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
      AND (p_categoria_id IS NULL OR p.categoria_id = p_categoria_id)
  ),
  global AS (
    SELECT s.cantidad, s.costo_promedio
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
    (SELECT COUNT(*) FROM base WHERE cantidad > 0),
    (SELECT COUNT(*) FROM base WHERE cantidad < 10),
    COALESCE((SELECT SUM(cantidad * costo_promedio) FROM global), 0),
    (SELECT COUNT(*) FROM global WHERE cantidad > 0),
    CASE WHEN (SELECT COUNT(*) FROM base) > 0
      THEN ROUND((SELECT total_movido FROM mov) / (SELECT COUNT(*) FROM base), 0)
      ELSE 0
    END;
END;
$function$;

-- fn_reportes_stock_distribucion: totales de valorización agrupados por categoría, en SQL.
CREATE OR REPLACE FUNCTION public.fn_reportes_stock_distribucion(
  p_deposito_id uuid DEFAULT NULL
)
RETURNS TABLE (
  categoria_nombre text,
  valor_total numeric
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
  SELECT COALESCE(c.nombre, 'Sin categoría') AS categoria_nombre,
         SUM(s.cantidad * s.costo_promedio) AS valor_total
  FROM public.stock s
  JOIN public.depositos d ON d.id = s.deposito_id
  JOIN public.productos p ON p.id = s.producto_id
  LEFT JOIN public.categorias c ON c.id = p.categoria_id
  WHERE d.empresa_id = v_empresa_id
    AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
  GROUP BY COALESCE(c.nombre, 'Sin categoría')
  ORDER BY valor_total DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_reportes_stock_kpis(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reportes_stock_distribucion(uuid) TO authenticated;
