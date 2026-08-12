-- ─────────────────────────────────────────────────────────────────────────
-- 255_etapa7_catalogo_cliente_stock_sql.sql
-- Auditoría de filtros v280, sección 6.1: el catálogo del portal cliente
-- (frontend/cliente/catalogo.html -> handleClienteProductos en
-- lib/handlers/stock.js) traía TODA la tabla `stock` de la empresa (todos
-- los depósitos, sin filtrar) a memoria de la función serverless en cada
-- búsqueda y cada page load, para recién ahí calcular "disponible" con un
-- Map en JS y armar el filtro de productos por IN(...).
--
-- Confirmado contra la base real: 2008 filas de stock viajando y
-- procesándose en JS por cada request a esta pantalla, que es la de mayor
-- tráfico de todo el sistema (portal público, a veces sin login). El costo
-- escala con productos x depósitos por tenant, así que empeora con cada
-- empresa nueva que sume depósitos o catálogo.
--
-- Esta migración mueve todo el cálculo (disponibilidad agregada, filtro de
-- categoría/búsqueda y paginación) a una sola query SQL server-side, mismo
-- patrón que ya usan fn_reportes_stock_kpis / fn_reportes_stock_distribucion
-- (migración 200) para el mismo problema en Reportes de Stock.
--
-- La función recibe empresa_id explícito (no usa get_empresa_id(), que
-- depende de sesión autenticada de admin) porque el portal cliente resuelve
-- la empresa vía resolverEmpresaCliente(req) y puede no tener sesión admin.
-- Por eso NO se otorga a anon/authenticated: solo el handler serverless
-- (que ya usa SUPABASE_SERVICE_ROLE_KEY) puede invocarla.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cliente_productos_disponibles(
  p_empresa_id uuid,
  p_categoria  uuid    DEFAULT NULL,
  p_busqueda   text    DEFAULT NULL,
  p_limit      integer DEFAULT 24,
  p_offset     integer DEFAULT 0
)
RETURNS TABLE (
  id                uuid,
  codigo            text,
  nombre            text,
  descripcion       text,
  unidad            text,
  precio_base       numeric,
  foto_url          text,
  categoria_id      uuid,
  categoria_nombre  text,
  stock_disponible  numeric,
  total_count       bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH stock_por_producto AS (
    -- Agregación en SQL: reemplaza el Map en JS que sumaba 2008 filas crudas
    -- de `stock` (todos los depósitos de la empresa) en cada request.
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
  ORDER BY p.nombre
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

COMMENT ON FUNCTION public.cliente_productos_disponibles IS
  'Catálogo del portal cliente (Auditoría filtros v280, 6.1): resuelve stock disponible agregado por producto vía JOIN+GROUP BY en SQL, en vez de traer la tabla stock completa a la función serverless y sumarla en JS. Filtro de categoría/búsqueda y paginación en la misma query, con count(*) OVER() para el total. Toma empresa_id explícito porque el portal cliente puede no tener sesión admin (resolverEmpresaCliente) — por eso solo se otorga a service_role, no a anon/authenticated.';

-- Índice de apoyo: covering index para que la agregación por producto_id no
-- necesite ir al heap a buscar cantidad/cantidad_reservada fila por fila.
-- CONCURRENTLY porque stock ya tiene ~2000 filas en producción y esto corre
-- fuera de una transacción de migración normal (mismo criterio que el resto
-- de índices agregados en caliente en este proyecto).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_producto_cantidades
  ON public.stock (producto_id)
  INCLUDE (cantidad, cantidad_reservada, deposito_id);

REVOKE ALL ON FUNCTION public.cliente_productos_disponibles(uuid, uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cliente_productos_disponibles(uuid, uuid, text, integer, integer) TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '255_etapa7_catalogo_cliente_stock_sql.sql', '255', 'claude-session',
        'Auditoria filtros v280 seccion 6.1: RPC cliente_productos_disponibles resuelve stock disponible del catalogo del portal cliente en SQL (JOIN+GROUP BY con HAVING > 0) en vez de traer toda la tabla stock (2008 filas) a la funcion serverless en cada busqueda/page load. Incluye filtro de categoria/busqueda y paginacion (count(*) OVER()) en la misma query. Agrega indice de apoyo idx_stock_producto_cantidades (covering cantidad/cantidad_reservada/deposito_id). Solo otorgada a service_role: la funcion recibe empresa_id explicito sin validarlo contra sesion autenticada, por lo que exponerla a anon/authenticated seria un riesgo de fuga cross-tenant.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
