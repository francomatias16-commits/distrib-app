-- ─────────────────────────────────────────────────────────────────────────
-- 392_foto_fuente_lista_y_filtro.sql
--
-- v391 agregó productos.foto_fuente (openfoodfacts | openproductsfacts |
-- google_images | pexels | NULL) pero fn_productos_lista no la expone, así
-- que el admin no tiene forma de ver ni filtrar por origen de la foto desde
-- la interfaz. Esta migración:
--   1) Agrega foto_fuente al SELECT/RETURNS TABLE de fn_productos_lista.
--   2) Agrega p_foto_fuente para filtrar: 'real' (barcode/Google Images o
--      subida manual), 'generica' (pexels), 'sin_foto' (foto_url IS NULL).
--      NULL/'' = sin filtro (retrocompatible).
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.fn_productos_lista(
  p_busqueda      text    DEFAULT NULL,
  p_categoria_id  uuid    DEFAULT NULL,
  p_estado        text    DEFAULT NULL,
  p_orden         text    DEFAULT 'nombre',
  p_asc           boolean DEFAULT true,
  p_limit         integer DEFAULT 50,
  p_offset        integer DEFAULT 0,
  p_mes           integer DEFAULT NULL,
  p_anio          integer DEFAULT NULL,
  p_foto_fuente   text    DEFAULT NULL   -- 'real' | 'generica' | 'sin_foto' | NULL/'' sin filtro
)
RETURNS TABLE(
  id uuid, codigo text, nombre text, activo boolean, estado text,
  categoria_id uuid, categoria_nombre text, precio_base numeric, costo numeric,
  stock_minimo numeric, stock_disponible numeric, updated_at timestamp with time zone,
  created_at timestamp with time zone, foto_url text, foto_fuente text, total_count bigint
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
        p.updated_at, p.created_at, p.foto_url, p.foto_fuente
      FROM public.productos p
      LEFT JOIN stock_por_producto sp ON sp.producto_id = p.id
      LEFT JOIN public.categorias c   ON c.id = p.categoria_id
      WHERE p.empresa_id = $1
        AND ($2::uuid IS NULL OR p.categoria_id = $2)
        AND (
          $3::text IS NULL OR $3 = '' OR
          (COALESCE(p.nombre, '') || ' ' || COALESCE(p.codigo, '')) ILIKE '%%' || $3 || '%%'
        )
        AND ($7::int IS NULL OR EXTRACT(MONTH FROM p.created_at) = $7)
        AND ($8::int IS NULL OR EXTRACT(YEAR  FROM p.created_at) = $8)
    )
    SELECT b.id, b.codigo, b.nombre, b.activo, b.estado,
           b.categoria_id, b.categoria_nombre,
           b.precio_base, b.costo, b.stock_minimo, b.stock_disponible,
           b.updated_at, b.created_at, b.foto_url, b.foto_fuente,
           COUNT(*) OVER() AS total_count
    FROM base b
    WHERE ($4::text IS NULL OR $4 = '' OR b.estado = $4)
      AND (
        $9::text IS NULL OR $9 = '' OR
        ($9 = 'sin_foto' AND b.foto_url IS NULL) OR
        ($9 = 'generica' AND b.foto_fuente = 'pexels') OR
        ($9 = 'real' AND b.foto_url IS NOT NULL
                     AND (b.foto_fuente IS NULL OR b.foto_fuente <> 'pexels'))
      )
    ORDER BY b.%I %s NULLS LAST, b.id
    LIMIT $5 OFFSET $6
    $q$,
    v_orden_col, v_dir
  );

  RETURN QUERY EXECUTE v_sql
    USING v_empresa_id, p_categoria_id, p_busqueda, p_estado, p_limit, p_offset, p_mes, p_anio, p_foto_fuente;
END;
$function$;

COMMENT ON FUNCTION public.fn_productos_lista(text, uuid, text, text, boolean, integer, integer, integer, integer, text) IS
  'v392: se agrega foto_fuente a la salida y p_foto_fuente como filtro '
  '(real = barcode/Google Images/subida manual; generica = pexels; '
  'sin_foto = foto_url IS NULL) para que el admin pueda auditar desde la '
  'interfaz qué tan confiables son las fotos cargadas por auto-imagenes.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '392_foto_fuente_lista_y_filtro.sql', '392', 'claude-session',
  'Se agrega foto_fuente a fn_productos_lista y un filtro p_foto_fuente '
  '(real/generica/sin_foto) para poder auditar desde el admin el origen de '
  'las fotos cargadas por auto-imagenes (v388-v391).')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
