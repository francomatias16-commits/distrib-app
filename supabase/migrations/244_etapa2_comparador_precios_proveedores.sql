-- ============================================================
-- 244_etapa2_comparador_precios_proveedores.sql
-- Etapa 2 (Comercial y precios) — Plan por etapas. Ítem 3/3:
-- Comparador de precios entre proveedores para un mismo producto.
--
-- Fuente de verdad: ordenes_compra_items (precio_costo) filtrado a OCs con
-- estado='recibida' — es el único estado donde el precio quedó confirmado
-- por una recepción real (borrador/enviada/confirmada/pendiente_aprobacion
-- son precios todavía especulativos, no lo que efectivamente se pagó).
--
-- Dos funciones:
--   1) comparar_precios_proveedores(): detalle por producto — todos los
--      proveedores que lo vendieron, con su último precio, mínimo, máximo
--      y promedio. Para cuando ya sabés qué producto querés mirar.
--   2) ranking_ahorro_proveedores(): vista de oportunidades — productos
--      ordenados por cuánta plata se dejó sobre la mesa comprándole al
--      proveedor "de siempre" en vez de al más barato disponible en el
--      mismo período. Pensado como punto de entrada (no hace falta saber
--      qué producto mirar primero).
-- ============================================================

-- ── 1. Detalle por producto ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.comparar_precios_proveedores(
  p_empresa_id   uuid,
  p_producto_id  uuid DEFAULT NULL,
  p_meses        integer DEFAULT 12
)
RETURNS TABLE(
  producto_id         uuid,
  producto_nombre     text,
  producto_codigo     text,
  proveedor_id        uuid,
  proveedor_nombre    text,
  precio_ultimo       numeric,
  fecha_ultima_compra timestamptz,
  precio_minimo       numeric,
  precio_maximo       numeric,
  precio_promedio     numeric,
  compras_count       bigint,
  cantidad_total      numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH compras AS (
    SELECT
      oci.producto_id,
      oc.proveedor_id,
      oci.precio_costo,
      COALESCE(oci.cantidad_recibida, oci.cantidad) AS cantidad,
      oc.fecha_recepcion,
      ROW_NUMBER() OVER (
        PARTITION BY oci.producto_id, oc.proveedor_id
        ORDER BY oc.fecha_recepcion DESC
      ) AS rn_ultimo
    FROM ordenes_compra_items oci
    JOIN ordenes_compra oc ON oc.id = oci.orden_id
    WHERE oc.empresa_id = p_empresa_id
      AND oc.estado = 'recibida'
      AND oc.fecha_recepcion >= (CURRENT_DATE - (p_meses || ' months')::interval)
      AND oci.precio_costo IS NOT NULL
      AND oci.precio_costo > 0
      AND (p_producto_id IS NULL OR oci.producto_id = p_producto_id)
  )
  SELECT
    c.producto_id,
    prod.nombre,
    prod.codigo,
    c.proveedor_id,
    prov.nombre_fantasia,
    MAX(c.precio_costo) FILTER (WHERE c.rn_ultimo = 1),
    MAX(c.fecha_recepcion) FILTER (WHERE c.rn_ultimo = 1),
    MIN(c.precio_costo),
    MAX(c.precio_costo),
    ROUND(SUM(c.precio_costo * c.cantidad) / NULLIF(SUM(c.cantidad), 0), 2),
    COUNT(*),
    SUM(c.cantidad)
  FROM compras c
  JOIN productos   prod ON prod.id = c.producto_id
  JOIN proveedores prov ON prov.id = c.proveedor_id
  GROUP BY c.producto_id, prod.nombre, prod.codigo, c.proveedor_id, prov.nombre_fantasia
  ORDER BY c.producto_id, MAX(c.precio_costo) FILTER (WHERE c.rn_ultimo = 1) ASC;
$$;

REVOKE ALL ON FUNCTION public.comparar_precios_proveedores FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.comparar_precios_proveedores TO service_role;

COMMENT ON FUNCTION public.comparar_precios_proveedores IS
  'Etapa 2 del plan por etapas (Comercial y precios), ítem 3/3: precios pagados por producto, desglosado por proveedor (último, mínimo, máximo, promedio ponderado por cantidad). Solo considera OCs con estado=recibida (precio confirmado, no especulativo). p_producto_id NULL = todos los productos con >1 proveedor en el período.';

-- ── 2. Ranking de oportunidades de ahorro ─────────────────────────
CREATE OR REPLACE FUNCTION public.ranking_ahorro_proveedores(
  p_empresa_id  uuid,
  p_meses       integer DEFAULT 12,
  p_limit       integer DEFAULT 50
)
RETURNS TABLE(
  producto_id              uuid,
  producto_nombre          text,
  producto_codigo          text,
  cantidad_proveedores     bigint,
  precio_promedio_pagado   numeric,
  precio_minimo_disponible numeric,
  proveedor_mas_barato_id  uuid,
  proveedor_mas_barato     text,
  proveedor_mas_usado_id   uuid,
  proveedor_mas_usado      text,
  cantidad_comprada        numeric,
  ahorro_potencial         numeric,
  spread_pct               numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH compras AS (
    SELECT
      oci.producto_id,
      oc.proveedor_id,
      oci.precio_costo,
      COALESCE(oci.cantidad_recibida, oci.cantidad) AS cantidad
    FROM ordenes_compra_items oci
    JOIN ordenes_compra oc ON oc.id = oci.orden_id
    WHERE oc.empresa_id = p_empresa_id
      AND oc.estado = 'recibida'
      AND oc.fecha_recepcion >= (CURRENT_DATE - (p_meses || ' months')::interval)
      AND oci.precio_costo IS NOT NULL
      AND oci.precio_costo > 0
  ),
  por_producto AS (
    SELECT
      producto_id,
      COUNT(DISTINCT proveedor_id)                                       AS cantidad_proveedores,
      ROUND(SUM(precio_costo * cantidad) / NULLIF(SUM(cantidad), 0), 2)  AS precio_promedio_pagado,
      MIN(precio_costo)                                                  AS precio_minimo_disponible,
      MAX(precio_costo)                                                  AS precio_maximo_pagado,
      SUM(cantidad)                                                      AS cantidad_comprada
    FROM compras
    GROUP BY producto_id
    HAVING COUNT(DISTINCT proveedor_id) > 1   -- sin alternativa, no hay nada para comparar
  ),
  proveedor_mas_barato AS (
    -- el proveedor con el precio_costo más bajo registrado (si empata, el más reciente)
    SELECT DISTINCT ON (c.producto_id)
      c.producto_id, c.proveedor_id
    FROM compras c
    ORDER BY c.producto_id, c.precio_costo ASC
  ),
  volumen_por_proveedor AS (
    SELECT producto_id, proveedor_id, SUM(cantidad) AS cant,
      ROW_NUMBER() OVER (PARTITION BY producto_id ORDER BY SUM(cantidad) DESC) AS rn
    FROM compras
    GROUP BY producto_id, proveedor_id
  )
  SELECT
    pp.producto_id,
    prod.nombre,
    prod.codigo,
    pp.cantidad_proveedores,
    pp.precio_promedio_pagado,
    pp.precio_minimo_disponible,
    pmb.proveedor_id,
    provb.nombre_fantasia,
    vmp.proveedor_id,
    provu.nombre_fantasia,
    pp.cantidad_comprada,
    ROUND(GREATEST(pp.precio_promedio_pagado - pp.precio_minimo_disponible, 0) * pp.cantidad_comprada, 2) AS ahorro_potencial,
    CASE WHEN pp.precio_minimo_disponible > 0
      THEN ROUND(((pp.precio_maximo_pagado - pp.precio_minimo_disponible) / pp.precio_minimo_disponible) * 100, 1)
      ELSE NULL
    END AS spread_pct
  FROM por_producto pp
  JOIN productos prod              ON prod.id = pp.producto_id
  JOIN proveedor_mas_barato pmb     ON pmb.producto_id = pp.producto_id
  JOIN proveedores provb            ON provb.id = pmb.proveedor_id
  JOIN volumen_por_proveedor vmp    ON vmp.producto_id = pp.producto_id AND vmp.rn = 1
  JOIN proveedores provu            ON provu.id = vmp.proveedor_id
  ORDER BY ahorro_potencial DESC NULLS LAST
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.ranking_ahorro_proveedores FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ranking_ahorro_proveedores TO service_role;

COMMENT ON FUNCTION public.ranking_ahorro_proveedores IS
  'Etapa 2 del plan por etapas (Comercial y precios), ítem 3/3: productos con más de un proveedor histórico, ordenados por ahorro_potencial = (precio_promedio_pagado - precio_minimo_disponible) * cantidad_comprada en el período. Estima cuánto se hubiera ahorrado comprando siempre al proveedor más barato disponible en vez de al que efectivamente se le compró. Solo OCs con estado=recibida.';

-- Registro en la tabla de tracking de migraciones del proyecto
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '244_etapa2_comparador_precios_proveedores.sql',
  '244',
  'claude_assistant',
  'Etapa 2 del plan por etapas (Comercial y precios), ítem 3/3: comparar_precios_proveedores() (detalle por producto) y ranking_ahorro_proveedores() (ranking de oportunidades de ahorro por producto, basado en ordenes_compra_items con estado=recibida).'
)
ON CONFLICT DO NOTHING;
