-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 460: fix — dias_restantes engañoso en analizar_stock_autonomo
-- para productos SIN historial de ventas (velocidad de venta = 0).
--
-- La fórmula anterior devolvía 999 días restantes cuando la velocidad de
-- venta era 0, sin importar el stock actual — pensado para productos con
-- mucho stock y sin movimiento reciente (correctamente "no urgente"). Pero
-- para un producto recién creado/migrado CON 0 unidades en stock y sin
-- ventas todavía (por no tener historial), el mismo cálculo daba "999 días
-- restantes", que es al revés de la realidad: ya está en quiebre, no le
-- quedan 999 días de nada.
--
-- Fix: si el stock disponible es <= 0, dias_restantes = 0 (ya en quiebre)
-- sin importar la velocidad de venta. Solo se usa el fallback de 999 días
-- cuando SÍ hay stock pero no hay venta reciente (caso "no urgente" real).
--
-- Se combina con el fix del lado de la aplicación (lib/handlers/stock-auto.js,
-- ver fix 460 en ese archivo): antes, un producto con necesita_reponer=true
-- pero cantidad_sugerida=0 (sin historial de ventas ni stock_objetivo
-- cargado, típico de productos recién migrados) se descartaba en silencio
-- y nunca aparecía en "Reposición sugerida" ni generaba ningún aviso.
-- Ahora se registra una alerta de tipo 'sin_historial' (sin orden de compra
-- automática, porque no hay base para calcular cuánto pedir) para que sea
-- visible y el dueño pueda cargar stock_minimo/stock_objetivo o revisar
-- manualmente.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.analizar_stock_autonomo(p_empresa_id uuid)
RETURNS TABLE(
  producto_id              uuid,
  nombre                   text,
  stock_actual             numeric,
  velocidad_dia            numeric,
  dias_restantes           numeric,
  lead_time                integer,
  necesita_reponer         boolean,
  cantidad_sugerida        numeric,
  proveedor_id             uuid,
  demanda_comprometida     numeric,
  demanda_futura_conocida  numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH ventas_30d AS (
    SELECT pi2.producto_id,
           SUM(pi2.cantidad) / 30.0 AS vel_dia
    FROM pedido_items pi2
    JOIN pedidos ped ON ped.id = pi2.pedido_id
    WHERE ped.empresa_id = p_empresa_id
      AND ped.estado IN ('entregado', 'despachado', 'confirmado')
      AND ped.fecha_pedido >= now() - INTERVAL '30 days'
    GROUP BY pi2.producto_id
  ),
  stock_fisico AS (
    SELECT s.producto_id, SUM(s.cantidad)::numeric AS cantidad_total
    FROM stock s
    JOIN depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
    GROUP BY s.producto_id
  ),
  demanda_comprometida AS (
    SELECT pi3.producto_id, SUM(pi3.cantidad)::numeric AS cantidad
    FROM pedido_items pi3
    JOIN pedidos p3 ON p3.id = pi3.pedido_id
    WHERE p3.empresa_id = p_empresa_id
      AND p3.estado IN ('confirmado', 'preparando')
    GROUP BY pi3.producto_id
  )
  SELECT
    p.id,
    p.nombre,
    GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0)),
    COALESCE(v.vel_dia, 0),
    -- Fix 460: 0 stock disponible ⇒ 0 días restantes, sin importar si hay
    -- o no velocidad de venta calculada (antes daba 999 si vel_dia = 0,
    -- aunque el producto ya estuviera en quiebre real).
    CASE
      WHEN GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0)) <= 0 THEN 0
      WHEN COALESCE(v.vel_dia, 0) > 0
        THEN GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0)) / v.vel_dia
      ELSE 999
    END,
    COALESCE(p.lead_time_dias, 7),
    (
      GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0))
      <=
      (
        COALESCE(v.vel_dia, 0) * COALESCE(p.lead_time_dias, 7)
        + COALESCE((
            SELECT SUM(cc.cantidad_promedio)
            FROM ciclos_compra cc
            WHERE cc.empresa_id  = p_empresa_id
              AND cc.producto_id = p.id
              AND cc.activo
              AND cc.proximo_pedido IS NOT NULL
              AND cc.proximo_pedido <= CURRENT_DATE + COALESCE(p.lead_time_dias, 7)
          ), 0)
        + COALESCE(p.stock_minimo, 0)
      )
    ),
    GREATEST(0,
      COALESCE(NULLIF(p.stock_objetivo, 0), COALESCE(v.vel_dia, 0) * 30)
      + COALESCE(v.vel_dia, 0) * COALESCE(p.lead_time_dias, 7)
      + COALESCE((
          SELECT SUM(cc.cantidad_promedio)
          FROM ciclos_compra cc
          WHERE cc.empresa_id  = p_empresa_id
            AND cc.producto_id = p.id
            AND cc.activo
            AND cc.proximo_pedido IS NOT NULL
            AND cc.proximo_pedido <= CURRENT_DATE + COALESCE(p.lead_time_dias, 7)
        ), 0)
      - GREATEST(0, COALESCE(sf.cantidad_total, 0) - COALESCE(dc.cantidad, 0))
    ),
    p.proveedor_id_default,
    COALESCE(dc.cantidad, 0),
    COALESCE((
      SELECT SUM(cc.cantidad_promedio)
      FROM ciclos_compra cc
      WHERE cc.empresa_id  = p_empresa_id
        AND cc.producto_id = p.id
        AND cc.activo
        AND cc.proximo_pedido IS NOT NULL
        AND cc.proximo_pedido <= CURRENT_DATE + COALESCE(p.lead_time_dias, 7)
    ), 0)
  FROM productos p
  LEFT JOIN stock_fisico        sf ON sf.producto_id = p.id
  LEFT JOIN ventas_30d          v  ON v.producto_id  = p.id
  LEFT JOIN demanda_comprometida dc ON dc.producto_id = p.id
  WHERE p.empresa_id = p_empresa_id AND p.activo = true
  ORDER BY 4 ASC;
END;
$function$;

COMMENT ON FUNCTION public.analizar_stock_autonomo(uuid) IS
  'v460: fix — dias_restantes = 0 cuando el stock disponible ya está en 0, sin importar la velocidad de venta (antes daba 999 "días restantes" para productos recién migrados/sin ventas, aunque estuvieran en quiebre real).';
