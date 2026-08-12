-- 396_fn_stock_lista_agrupada.sql
-- Ya aplicada en producción (jgiquzjwoedmzwqgzubr) el 2026-07-19. Este archivo
-- se agrega al repo de migraciones locales para que quede versionada junto al
-- resto (numeración 035-395 existente), igual que el resto de fn_*_lista.
DROP FUNCTION IF EXISTS public.fn_stock_lista_agrupada(text, uuid, uuid, text, uuid[], integer, integer);

CREATE OR REPLACE FUNCTION public.fn_stock_lista_agrupada(
  p_busqueda      text     DEFAULT NULL,
  p_categoria_id  uuid     DEFAULT NULL,
  p_deposito_id   uuid     DEFAULT NULL,
  p_estado        text     DEFAULT NULL,
  p_producto_ids  uuid[]   DEFAULT NULL,
  p_limit         integer  DEFAULT 50,
  p_offset        integer  DEFAULT 0
)
RETURNS TABLE(
  producto_id          uuid,
  codigo               text,
  nombre               text,
  unidad               text,
  categoria_id         uuid,
  categoria_nombre     text,
  cantidad_disponible  numeric,
  cantidad_reservada   numeric,
  cantidad             numeric,
  costo_promedio       numeric,
  n_depositos          integer,
  deposito_id          uuid,
  deposito_nombre      text,
  total_count          bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
  v_umbral_critico numeric := 0;
  v_umbral_bajo    numeric := 5;
BEGIN
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo determinar la empresa del usuario actual.';
  END IF;

  RETURN QUERY
  WITH stock_agg AS (
    SELECT
      s.producto_id,
      SUM(COALESCE(s.cantidad_disponible, 0))  AS disponible,
      SUM(COALESCE(s.cantidad_reservada, 0))   AS reservada,
      SUM(COALESCE(s.cantidad, 0))             AS total,
      CASE WHEN SUM(COALESCE(s.cantidad, 0)) > 0
        THEN SUM(COALESCE(s.costo_promedio, 0) * COALESCE(s.cantidad, 0)) / SUM(COALESCE(s.cantidad, 0))
        ELSE COALESCE(MAX(s.costo_promedio), 0)
      END AS costo_prom,
      COUNT(*)::integer AS n_depositos,
      (array_agg(s.deposito_id ORDER BY COALESCE(s.cantidad_disponible,0) DESC, d.nombre))[1] AS dep_id_rep,
      (array_agg(d.nombre     ORDER BY COALESCE(s.cantidad_disponible,0) DESC, d.nombre))[1] AS dep_nombre_rep
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = v_empresa_id
      AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
    GROUP BY s.producto_id
  ),
  base AS (
    SELECT
      p.id AS producto_id, p.codigo, p.nombre, p.unidad,
      p.categoria_id, c.nombre AS categoria_nombre,
      COALESCE(sa.disponible, 0) AS cantidad_disponible,
      COALESCE(sa.reservada, 0)  AS cantidad_reservada,
      COALESCE(sa.total, 0)      AS cantidad,
      COALESCE(sa.costo_prom, 0) AS costo_promedio,
      COALESCE(sa.n_depositos, 0) AS n_depositos,
      CASE WHEN COALESCE(sa.n_depositos, 0) = 1 THEN sa.dep_id_rep
           WHEN p_deposito_id IS NOT NULL       THEN p_deposito_id
           ELSE NULL END AS deposito_id,
      CASE WHEN COALESCE(sa.n_depositos, 0) = 1 THEN sa.dep_nombre_rep
           ELSE NULL END AS deposito_nombre
    FROM public.productos p
    JOIN stock_agg sa ON sa.producto_id = p.id
    LEFT JOIN public.categorias c ON c.id = p.categoria_id
    WHERE p.empresa_id = v_empresa_id
      AND p.activo = true
      AND (p_categoria_id IS NULL OR p.categoria_id = p_categoria_id)
      AND (p_producto_ids IS NULL OR p.id = ANY(p_producto_ids))
      AND (
        p_busqueda IS NULL OR p_busqueda = '' OR
        (COALESCE(p.nombre, '') || ' ' || COALESCE(p.codigo, '')) ILIKE '%' || p_busqueda || '%'
      )
  )
  SELECT b.producto_id, b.codigo, b.nombre, b.unidad,
         b.categoria_id, b.categoria_nombre,
         b.cantidad_disponible, b.cantidad_reservada, b.cantidad, b.costo_promedio,
         b.n_depositos, b.deposito_id, b.deposito_nombre,
         COUNT(*) OVER() AS total_count
  FROM base b
  WHERE (
    p_estado IS NULL OR p_estado = '' OR
    (p_estado = 'critico' AND b.cantidad_disponible <= v_umbral_critico) OR
    (p_estado = 'bajo'    AND b.cantidad_disponible > v_umbral_critico AND b.cantidad_disponible <= v_umbral_bajo) OR
    (p_estado = 'ok'      AND b.cantidad_disponible > v_umbral_bajo)
  )
  ORDER BY b.nombre ASC, b.producto_id
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

COMMENT ON FUNCTION public.fn_stock_lista_agrupada(text, uuid, uuid, text, uuid[], integer, integer) IS
  'v396: lista de stock agrupada por producto (suma disponible/reservado/total entre todos sus depositos), para que Stock.html no repita una fila por cada deposito con stock. Si se pasa p_deposito_id queda igual que antes: 1 fila = 1 deposito.';

REVOKE EXECUTE ON FUNCTION public.fn_stock_lista_agrupada(text, uuid, uuid, text, uuid[], integer, integer)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_stock_lista_agrupada(text, uuid, uuid, text, uuid[], integer, integer)
  TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_stock_depositos_producto(uuid);

CREATE OR REPLACE FUNCTION public.fn_stock_depositos_producto(p_producto_id uuid)
RETURNS TABLE(
  deposito_id          uuid,
  deposito_nombre      text,
  es_principal         boolean,
  cantidad_disponible  numeric,
  cantidad_reservada   numeric,
  cantidad             numeric,
  costo_promedio       numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT d.id, d.nombre, COALESCE(d.es_principal, false),
         COALESCE(s.cantidad_disponible, 0),
         COALESCE(s.cantidad_reservada, 0),
         COALESCE(s.cantidad, 0),
         COALESCE(s.costo_promedio, 0)
  FROM public.stock s
  JOIN public.depositos d ON d.id = s.deposito_id
  WHERE s.producto_id = p_producto_id
    AND d.empresa_id = public.get_empresa_id()
  ORDER BY d.es_principal DESC NULLS LAST, d.nombre;
$function$;

COMMENT ON FUNCTION public.fn_stock_depositos_producto(uuid) IS
  'v396: breakdown por deposito de un producto puntual, para expandir una fila agrupada de fn_stock_lista_agrupada en Stock.html.';

REVOKE EXECUTE ON FUNCTION public.fn_stock_depositos_producto(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_stock_depositos_producto(uuid)
  TO authenticated, service_role;
