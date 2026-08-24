-- ============================================================
-- 20260823030000_529_cliente_productos_destacado.sql
-- Suma `destacado` (527_destacados_columna_y_alta.sql) a la salida de
-- cliente_productos_disponibles, para que el catálogo del portal
-- cliente pueda armar la sección fija de destacados arriba del
-- listado. También se antepone destacado a la ordenación por nombre
-- (los destacados aparecen primero incluso en el listado general,
-- no solo en la sección fija — coherente con lo que ve el visitante).
-- Se agrega p_solo_destacados (nullable/default false, al final) para
-- poder pedir solo los destacados en una query aparte, independiente
-- de la categoría/búsqueda/paginación activa — es la que arma la
-- sección fija sin pisar el filtro que el visitante esté usando en el
-- resto del catálogo.
-- Mismo gateo SEC-008 que la versión vigente (292), sin tocarlo.
-- ============================================================

-- CREATE OR REPLACE no permite cambiar el RETURNS TABLE (se agrega la
-- columna destacado) — hace falta DROP primero, misma firma de parámetros.
DROP FUNCTION IF EXISTS public.cliente_productos_disponibles(uuid, uuid, text, integer, integer);

CREATE OR REPLACE FUNCTION public.cliente_productos_disponibles(p_empresa_id uuid, p_categoria uuid DEFAULT NULL::uuid, p_busqueda text DEFAULT NULL::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0, p_solo_destacados boolean DEFAULT false)
 RETURNS TABLE(id uuid, codigo text, nombre text, descripcion text, unidad text, precio_base numeric, foto_url text, categoria_id uuid, categoria_nombre text, stock_disponible numeric, destacado boolean, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- SEC-008 (292): mismo gateo, sin cambios.
  IF auth.role() <> 'service_role'
     AND public.get_empresa_id() IS DISTINCT FROM p_empresa_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.empresas e
       WHERE e.id = p_empresa_id
         AND COALESCE((e.config->>'catalogo_publico_habilitado')::boolean, false) = true
    ) THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH stock_por_producto AS (
    SELECT s.producto_id,
           SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) AS disponible
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
    GROUP BY s.producto_id
    HAVING SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) > 0
  )
  SELECT
    p.id, p.codigo, p.nombre, p.descripcion, p.unidad, p.precio_base,
    p.foto_url, p.categoria_id, c.nombre AS categoria_nombre,
    sp.disponible AS stock_disponible,
    p.destacado,
    COUNT(*) OVER() AS total_count
  FROM public.productos p
  JOIN stock_por_producto sp ON sp.producto_id = p.id
  LEFT JOIN public.categorias c ON c.id = p.categoria_id
  WHERE p.empresa_id = p_empresa_id
    AND p.activo = true
    AND (p_categoria IS NULL OR p.categoria_id = p_categoria)
    AND (
      p_busqueda IS NULL OR p_busqueda = '' OR (
        p.nombre      ILIKE '%' || p_busqueda || '%' OR
        p.codigo      ILIKE '%' || p_busqueda || '%' OR
        p.descripcion ILIKE '%' || p_busqueda || '%'
      )
    )
    AND (NOT p_solo_destacados OR p.destacado = true)
  ORDER BY p.destacado DESC, p.nombre
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

COMMENT ON FUNCTION public.cliente_productos_disponibles(uuid, uuid, text, integer, integer, boolean) IS
  'v529: suma destacado a la salida, lo antepone en el orden por nombre, y agrega p_solo_destacados (default false) para pedir solo los destacados en una query aparte de la sección fija — no pisa el filtro de categoría/búsqueda que el visitante tenga activo en el resto del catálogo. Usado por handleClienteProductos (lib/handlers/stock.js).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260823030000_529_cliente_productos_destacado.sql',
  '529',
  'claude_assistant',
  'Suma destacado a cliente_productos_disponibles (mismos parámetros que 292) y lo antepone en el ORDER BY. Habilita la sección fija de Destacados en el catálogo del portal cliente.'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
