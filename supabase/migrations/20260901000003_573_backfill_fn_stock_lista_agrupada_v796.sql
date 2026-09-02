-- Etapa 7 (Bloque 1, Devoluciones) — reconciliación de migraciones contra
-- Supabase real (mismo patrón que el gap ya encontrado con la migración
-- 483, ver 20260831000003_569_track_funciones_fantasma.sql).
--
-- v796 ("Stock: no ocultar más productos inactivos con stock real") dice
-- explícitamente en su changelog: "Cambios (Supabase, aplicados directo —
-- migración 494)". Ese cambio SÍ se aplicó en producción (confirmado con
-- pg_get_functiondef contra el proyecto real), pero nunca se backfilleó
-- como archivo de migración acá. El archivo que hoy ocupa el número 494 en
-- el repo (494_fn_reportes_stock_valorizacion.sql) es una función distinta
-- — un choque de numeración, no el cambio real de v796.
--
-- Consecuencia concreta: la última versión de `fn_stock_lista_agrupada` en
-- el repo (461_fn_stock_lista_agrupada_agrega_foto_url.sql) todavía tiene
-- el filtro viejo `AND p.activo = true` — el bug que v796 vino a arreglar
-- (59 productos inactivos con 22.687 unidades de stock fantasma,
-- invisibles en la pantalla de Stock). Un `supabase db reset` hoy
-- reconstruiría la versión ROTA, no la que corre en producción.
--
-- Esta migración NO cambia comportamiento — es el CREATE OR REPLACE con la
-- definición EXACTA que hoy vive en producción (capturada con
-- pg_get_functiondef). Puramente de trazabilidad, mismo criterio que la
-- migración 498 para el guard de desactivación.
--
-- El trigger `trg_guard_desactivar_producto_con_stock` que v796 agregó en
-- el mismo changelog SÍ ya está cubierto — ver migración 498
-- (498_track_funcion_fantasma_guard_desactivar_producto.sql).

CREATE OR REPLACE FUNCTION public.fn_stock_lista_agrupada(
  p_busqueda text DEFAULT NULL::text,
  p_categoria_id uuid DEFAULT NULL::uuid,
  p_deposito_id uuid DEFAULT NULL::uuid,
  p_estado text DEFAULT NULL::text,
  p_producto_ids uuid[] DEFAULT NULL::uuid[],
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  producto_id uuid, codigo text, nombre text, unidad text,
  categoria_id uuid, categoria_nombre text, foto_url text,
  cantidad_disponible numeric, cantidad_reservada numeric, cantidad numeric,
  costo_promedio numeric, n_depositos integer, deposito_id uuid,
  deposito_nombre text, activo boolean, total_count bigint
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
      SUM(COALESCE(s.cantidad_disponible, 0))::numeric  AS disponible,
      SUM(COALESCE(s.cantidad_reservada, 0))::numeric    AS reservada,
      SUM(COALESCE(s.cantidad, 0))::numeric              AS total,
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
      p.foto_url,
      COALESCE(sa.disponible, 0) AS cantidad_disponible,
      COALESCE(sa.reservada, 0)  AS cantidad_reservada,
      COALESCE(sa.total, 0)      AS cantidad,
      COALESCE(sa.costo_prom, 0) AS costo_promedio,
      COALESCE(sa.n_depositos, 0) AS n_depositos,
      CASE WHEN COALESCE(sa.n_depositos, 0) = 1 THEN sa.dep_id_rep
           WHEN p_deposito_id IS NOT NULL       THEN p_deposito_id
           ELSE NULL END AS deposito_id,
      CASE WHEN COALESCE(sa.n_depositos, 0) = 1 THEN sa.dep_nombre_rep
           ELSE NULL END AS deposito_nombre,
      p.activo
    FROM public.productos p
    JOIN stock_agg sa ON sa.producto_id = p.id
    LEFT JOIN public.categorias c ON c.id = p.categoria_id
    WHERE p.empresa_id = v_empresa_id
      -- v796/v494: antes exigía p.activo = true, escondiendo stock real de
      -- productos desactivados. Ahora solo se ocultan los inactivos que
      -- además ya están en cero (no hay nada que reconciliar).
      AND (p.activo = true OR COALESCE(sa.total, 0) <> 0)
      AND (p_categoria_id IS NULL OR p.categoria_id = p_categoria_id)
      AND (p_producto_ids IS NULL OR p.id = ANY(p_producto_ids))
      AND (
        p_busqueda IS NULL OR p_busqueda = '' OR
        (COALESCE(p.nombre, '') || ' ' || COALESCE(p.codigo, '')) ILIKE '%' || p_busqueda || '%'
      )
  )
  SELECT b.producto_id, b.codigo, b.nombre, b.unidad,
         b.categoria_id, b.categoria_nombre, b.foto_url,
         b.cantidad_disponible, b.cantidad_reservada, b.cantidad, b.costo_promedio,
         b.n_depositos, b.deposito_id, b.deposito_nombre, b.activo,
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
