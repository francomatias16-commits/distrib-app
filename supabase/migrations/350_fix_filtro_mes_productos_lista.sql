-- ─────────────────────────────────────────────────────────────────────────
-- 350_fix_filtro_mes_productos_lista.sql
-- Ya aplicada en el proyecto Supabase (jgiquzjwoedmzwqgzubr) vía apply_migration.
--
-- Bug: fn_productos_lista no tenía parámetros de mes/año. El selector de
-- mes en frontend/admin/js/productos.js (seleccionarMes) solo cambiaba el
-- estilo visual del botón activo pero nunca se enviaba al RPC, por lo que
-- la lista de productos era idéntica sin importar el mes elegido.
--
-- Fix: se agregan p_mes/p_anio (nullable, retrocompatible) que filtran por
-- EXTRACT(MONTH/YEAR FROM created_at). Se eliminó la firma vieja de 7 args
-- para evitar overload ambiguo. El frontend (productos.js) ahora envía
-- mesActivo+1 / yearActivo en cada llamada.
-- ─────────────────────────────────────────────────────────────────────────

-- eliminar la firma vieja (7 args) para que no quede duplicada junto a la nueva (9 args)
DROP FUNCTION IF EXISTS public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer);

CREATE OR REPLACE FUNCTION public.fn_productos_lista(
  p_busqueda     text    DEFAULT NULL::text,
  p_categoria_id uuid    DEFAULT NULL::uuid,
  p_estado       text    DEFAULT NULL::text,
  p_orden        text    DEFAULT 'nombre'::text,
  p_asc          boolean DEFAULT true,
  p_limit        integer DEFAULT 50,
  p_offset       integer DEFAULT 0,
  p_mes          integer DEFAULT NULL,   -- 1-12, NULL = sin filtro de mes (retrocompatible)
  p_anio         integer DEFAULT NULL    -- NULL = sin filtro de año
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
        -- fix v350: filtro real por mes/año de creación (antes el selector de
        -- mes en el front no se enviaba a este RPC y no filtraba nada)
        AND ($7::int IS NULL OR EXTRACT(MONTH FROM p.created_at) = $7)
        AND ($8::int IS NULL OR EXTRACT(YEAR  FROM p.created_at) = $8)
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
    USING v_empresa_id, p_categoria_id, p_busqueda, p_estado, p_limit, p_offset, p_mes, p_anio;
END;
$function$;

COMMENT ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer) IS
  'Lista paginada de productos (server-side: busqueda/categoria/estado/orden/mes/anio). '
  'p_mes/p_anio (fix v350) filtran por mes y ano de created_at; antes el selector de '
  'mes del front (Ene..Dic) no enviaba nada a este RPC y la lista no cambiaba entre '
  'meses.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '350_fix_filtro_mes_productos_lista.sql', '350', 'claude-session',
  'Fix: fn_productos_lista no tenia parametros de mes/anio; el selector de mes en frontend/admin/js/productos.js (seleccionarMes) solo cambiaba el estilo visual del boton activo pero nunca se enviaba al RPC, por lo que la lista de productos era identica sin importar el mes elegido. Se agregan p_mes/p_anio (nullable, retrocompatible) que filtran por EXTRACT(MONTH/YEAR FROM created_at). Se elimino la firma vieja de 7 args para evitar overload ambiguo.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
