-- ─────────────────────────────────────────────────────────────────────────
-- 256_rpc_productos_lista_server_side.sql
-- Auditoría de filtros v280: la pantalla de Productos (admin) traía TODA
-- la tabla `productos` de la empresa a memoria del navegador y hacía ahí
-- el filtrado por búsqueda/categoría/estado, el orden y la paginación
-- (arrays `productosAll` / `productosFilt` en frontend/admin/js/productos.js).
--
-- Esta migración mueve ese trabajo a dos funciones server-side, mismo
-- patrón que fn_reportes_stock_kpis / fn_reportes_stock_distribucion
-- (migración 200) y cliente_productos_disponibles (migración 255):
--
--   - fn_productos_lista(...)      -> página ya filtrada/ordenada, con
--                                      total_count via window function,
--                                      para paginación real LIMIT/OFFSET.
--   - fn_productos_contadores()    -> contadores globales (total, activos,
--                                      sin_stock) para topbar/alertas, sin
--                                      traer filas de producto a JS.
--
-- Reconstruida el 10/07/2026 a partir de pg_get_functiondef() contra la
-- base real (jgiquzjwoedmzwqgzubr), donde ya estaba aplicada (registrada
-- en supabase_migrations.schema_migrations como 256_rpc_productos_lista_
-- server_side pero sin este archivo .sql en el repo). Ver nota de
-- seguridad al final sobre los GRANT heredados.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_productos_contadores()
 RETURNS TABLE(total_productos bigint, total_activos bigint, total_sin_stock bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  WITH stock_por_producto AS (
    SELECT s.producto_id,
           SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) AS disponible
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = v_empresa_id
    GROUP BY s.producto_id
  )
  SELECT
    COUNT(*) AS total_productos,
    COUNT(*) FILTER (WHERE p.activo AND COALESCE(sp.disponible, 0) > 0) AS total_activos,
    COUNT(*) FILTER (WHERE p.activo AND COALESCE(sp.disponible, 0) <= 0) AS total_sin_stock
  FROM public.productos p
  LEFT JOIN stock_por_producto sp ON sp.producto_id = p.id
  WHERE p.empresa_id = v_empresa_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_productos_lista(
  p_busqueda     text    DEFAULT NULL::text,
  p_categoria_id uuid    DEFAULT NULL::uuid,
  p_estado       text    DEFAULT NULL::text,
  p_orden        text    DEFAULT 'nombre'::text,
  p_asc          boolean DEFAULT true,
  p_limit        integer DEFAULT 50,
  p_offset       integer DEFAULT 0
)
 RETURNS TABLE(
   id uuid, codigo text, nombre text, activo boolean, estado text,
   categoria_id uuid, categoria_nombre text,
   precio_base numeric, costo numeric, stock_minimo numeric,
   stock_disponible numeric,
   updated_at timestamp with time zone, created_at timestamp with time zone,
   total_count bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
  v_orden_col  text;
  v_dir        text := CASE WHEN p_asc THEN 'ASC' ELSE 'DESC' END;
  v_sql        text;
BEGIN
  -- Whitelist de columnas ordenables (evita inyección vía p_orden: nunca se
  -- concatena el parámetro crudo, solo se usa para elegir un identificador
  -- ya conocido de esta lista fija).
  v_orden_col := CASE p_orden
    WHEN 'nombre'      THEN 'nombre'
    WHEN 'precio'      THEN 'precio_base'
    WHEN 'precio_base' THEN 'precio_base'
    WHEN 'costo'       THEN 'costo'
    WHEN 'stock'       THEN 'stock_disponible'
    WHEN 'fechaAct'    THEN 'updated_at'
    WHEN 'updated_at'  THEN 'updated_at'
    ELSE 'nombre'
  END;

  v_sql := format(
    $q$
    WITH stock_por_producto AS (
      SELECT s.producto_id,
             SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) AS disponible
      FROM public.stock s
      JOIN public.depositos d ON d.id = s.deposito_id
      WHERE d.empresa_id = $1
      GROUP BY s.producto_id
    ),
    base AS (
      SELECT
        p.id, p.codigo, p.nombre, p.activo,
        CASE
          WHEN NOT p.activo THEN 'borrador'
          WHEN COALESCE(sp.disponible, 0) <= 0 THEN 'sin_stock'
          ELSE 'activo'
        END AS estado,
        p.categoria_id, c.nombre AS categoria_nombre,
        p.precio_base, p.costo, p.stock_minimo,
        COALESCE(sp.disponible, 0) AS stock_disponible,
        p.updated_at, p.created_at
      FROM public.productos p
      LEFT JOIN stock_por_producto sp ON sp.producto_id = p.id
      LEFT JOIN public.categorias c   ON c.id = p.categoria_id
      WHERE p.empresa_id = $1
        AND ($2::uuid IS NULL OR p.categoria_id = $2)
        AND (
          $3::text IS NULL OR $3 = '' OR
          (COALESCE(p.nombre, '') || ' ' || COALESCE(p.codigo, '')) ILIKE '%%' || $3 || '%%'
        )
    )
    SELECT b.id, b.codigo, b.nombre, b.activo, b.estado,
           b.categoria_id, b.categoria_nombre,
           b.precio_base, b.costo, b.stock_minimo, b.stock_disponible,
           b.updated_at, b.created_at,
           COUNT(*) OVER() AS total_count
    FROM base b
    WHERE ($4::text IS NULL OR $4 = '' OR b.estado = $4)
    ORDER BY b.%I %s NULLS LAST, b.id
    LIMIT $5 OFFSET $6
    $q$,
    v_orden_col, v_dir
  );

  RETURN QUERY EXECUTE v_sql
    USING v_empresa_id, p_categoria_id, p_busqueda, p_estado, p_limit, p_offset;
END;
$function$;

-- NOTA DE SEGURIDAD (no aplicada acá, solo dejada asentada):
-- al reconstruir esta definición se detectó que EXECUTE está otorgado
-- también a anon/authenticated (no solo service_role), igual patrón ya
-- visto en Fase 18 (REVOKE FROM anon sin revocar también de PUBLIC).
-- Al ser RPCs de panel admin, convendría:
--   REVOKE EXECUTE ON FUNCTION public.fn_productos_lista(text,uuid,text,text,boolean,integer,integer) FROM PUBLIC, anon, authenticated;
--   GRANT  EXECUTE ON FUNCTION public.fn_productos_lista(text,uuid,text,text,boolean,integer,integer) TO service_role;
--   (idem para fn_productos_contadores())
-- Pendiente de confirmación antes de aplicar.
