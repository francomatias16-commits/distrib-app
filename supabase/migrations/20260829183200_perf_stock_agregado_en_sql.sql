-- 462_perf_stock_agregado_en_sql.sql
--
-- Load test (2026-08-29): /api/admin/stock/bajo (8.1 req/s, p99 9582ms) y
-- /api/admin/resumen-arranque (p99 9760ms) traían con `.select()` TODAS
-- las filas de `stock` (join a `productos`) de la empresa, sin agregar ni
-- filtrar en la base, y hacían el agrupado por producto + el filtro de
-- umbral en JS (ver obtenerStockConProductos/obtenerStockValorizado en
-- lib/repos/admin.js). Eso mueve de más: payload grande por PostgREST,
-- más CPU en el lambda para el Map()/filter(), y no escala con 30
-- conexiones concurrentes.
--
-- FIX: agregar y filtrar en SQL, devolver ya armado el JSON que necesita
-- el handler (mismas claves que devolvía handleStockBajo/handleResumenArranque,
-- para no tener que tocar el contrato del frontend).

CREATE OR REPLACE FUNCTION public.obtener_stock_bajo(
  p_empresa_id UUID,
  p_limit      INT DEFAULT 10
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH agregado AS (
    SELECT
      s.producto_id,
      p.nombre,
      p.codigo,
      COALESCE(p.stock_minimo, 0) AS stock_minimo,
      SUM(s.cantidad) - SUM(s.cantidad_reservada) AS cantidad_disponible
    FROM stock s
    JOIN productos p  ON p.id = s.producto_id
    JOIN depositos d  ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
      AND p.activo = true
    GROUP BY s.producto_id, p.nombre, p.codigo, p.stock_minimo
  )
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  FROM (
    SELECT
      producto_id,
      nombre,
      codigo,
      stock_minimo,
      GREATEST(0, cantidad_disponible) AS cantidad_disponible
    FROM agregado
    WHERE GREATEST(0, cantidad_disponible) < (CASE WHEN stock_minimo > 0 THEN stock_minimo ELSE 5 END)
    ORDER BY GREATEST(0, cantidad_disponible) ASC
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
  ) t;
$$;

REVOKE ALL ON FUNCTION public.obtener_stock_bajo FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_stock_bajo TO service_role;

-- Usada por resumen-arranque (pregunta 1: "¿qué tengo para vender de
-- verdad?"): mismo agrupado que obtener_stock_bajo pero valorizado y sin
-- el detalle de items — solo los 4 totales que ya arma handleResumenArranque.
CREATE OR REPLACE FUNCTION public.obtener_stock_resumen_arranque(
  p_empresa_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH agregado AS (
    SELECT
      s.producto_id,
      COALESCE(p.stock_minimo, 0) AS stock_minimo,
      GREATEST(0, SUM(s.cantidad) - SUM(s.cantidad_reservada)) AS disponible,
      GREATEST(0, SUM(s.cantidad) - SUM(s.cantidad_reservada)) * AVG(s.costo_promedio) AS valorizado
    FROM stock s
    JOIN productos p  ON p.id = s.producto_id
    JOIN depositos d  ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
      AND p.activo = true
    GROUP BY s.producto_id, p.stock_minimo
  )
  SELECT jsonb_build_object(
    'unidades_disponibles',  COALESCE(ROUND(SUM(disponible)), 0),
    'valorizado_disponible', COALESCE(ROUND(SUM(valorizado)::numeric, 2), 0),
    'productos_con_stock',   COALESCE(COUNT(*) FILTER (WHERE disponible > 0), 0),
    'stock_critico_count',   COALESCE(COUNT(*) FILTER (
                                WHERE disponible < (CASE WHEN stock_minimo > 0 THEN stock_minimo ELSE 5 END)
                              ), 0)
  )
  FROM agregado;
$$;

REVOKE ALL ON FUNCTION public.obtener_stock_resumen_arranque FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_stock_resumen_arranque TO service_role;

-- `depositos` no tenía NINGÚN índice en empresa_id (001_schema.sql) —
-- se usa como filtro de entrada en esta función, en obtenerDepositosIds
-- (llamada en casi todos los handlers de admin.js) y ahora en las dos
-- funciones de arriba. stock.deposito_id/producto_id ya estaban
-- indexados (028_indices_optimizados.sql).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_depositos_empresa
  ON public.depositos (empresa_id);

-- ⚠️ Mismo aviso: el CREATE INDEX CONCURRENTLY no puede ir en la misma
-- transacción que las funciones si su pipeline de migraciones envuelve
-- todo en un BEGIN/COMMIT.
