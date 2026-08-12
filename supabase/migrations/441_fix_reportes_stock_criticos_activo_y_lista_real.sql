-- 441_fix_reportes_stock_criticos_activo_y_lista_real.sql
--
-- [reconstruido retroactivamente desde el estado real de producción — el
--  archivo original vivía en db/, carpeta ausente en los exports/zips del
--  repo. Definiciones verificadas contra pg_get_functiondef() de la base
--  viva.]
--
-- F3-01/F3-02 (auditoría de páginas, Fase 3): fn_reportes_stock_kpis ahora
-- filtra productos.activo=true en base y global. Nueva
-- fn_reportes_stock_criticos_lista reemplaza el query client-side
-- stock.cantidad<10 de la tabla de críticos, usando el mismo criterio real
-- (stock_minimo por producto) que el KPI de la misma pantalla.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_reportes_stock_kpis(p_deposito_id uuid DEFAULT NULL::uuid, p_categoria_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(valor_total numeric, productos_en_stock bigint, productos_criticos bigint, valor_total_global numeric, productos_en_stock_global bigint, rotacion_promedio numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
      AND p.activo = true
      AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
      AND (p_categoria_id IS NULL OR p.categoria_id = p_categoria_id)
  ),
  base_por_producto AS (
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
    JOIN public.productos p ON p.id = s.producto_id
    WHERE d.empresa_id = v_empresa_id
      AND p.activo = true
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
    (SELECT COUNT(*) FROM base_por_producto WHERE disponible_total <= GREATEST(COALESCE(minimo, 0), 5)),
    COALESCE((SELECT SUM(cantidad * costo_promedio) FROM global), 0),
    (SELECT COUNT(DISTINCT producto_id) FROM global WHERE cantidad > 0),
    CASE WHEN (SELECT COUNT(DISTINCT producto_id) FROM base) > 0
      THEN ROUND((SELECT total_movido FROM mov) / (SELECT COUNT(DISTINCT producto_id) FROM base), 0)
      ELSE 0
    END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_reportes_stock_criticos_lista(p_deposito_id uuid DEFAULT NULL::uuid, p_categoria_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS TABLE(producto_id uuid, nombre text, cantidad_disponible numeric, stock_minimo numeric, deficit numeric, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la empresa del usuario actual.';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT s.producto_id, p.nombre, p.stock_minimo,
           s.cantidad, s.cantidad_reservada
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    JOIN public.productos p ON p.id = s.producto_id
    WHERE d.empresa_id = v_empresa_id
      AND p.activo = true
      AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
      AND (p_categoria_id IS NULL OR p.categoria_id = p_categoria_id)
  ),
  agg AS (
    SELECT
      producto_id,
      MAX(nombre) AS nombre,
      SUM(cantidad - COALESCE(cantidad_reservada, 0)) AS disponible,
      GREATEST(MAX(stock_minimo), 5) AS minimo
    FROM base
    GROUP BY producto_id
  )
  SELECT
    a.producto_id, a.nombre, a.disponible, a.minimo,
    GREATEST(a.minimo - a.disponible, 0) AS deficit,
    COUNT(*) OVER() AS total_count
  FROM agg a
  WHERE a.disponible <= a.minimo
  ORDER BY a.disponible ASC, a.nombre ASC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_reportes_stock_criticos_lista(uuid, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_reportes_stock_criticos_lista(uuid, uuid, integer, integer) TO authenticated, service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '441_fix_reportes_stock_criticos_activo_y_lista_real.sql', '441', 'claude-session',
  'F3-01/F3-02 (auditoria de paginas, Fase 3): fn_reportes_stock_kpis ahora filtra '
  'productos.activo=true en base y global. Nueva fn_reportes_stock_criticos_lista reemplaza '
  'el query client-side stock.cantidad<10 de la tabla de criticos, usando el mismo criterio '
  'real (stock_minimo por producto) que el KPI de la misma pantalla.')
ON CONFLICT DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
