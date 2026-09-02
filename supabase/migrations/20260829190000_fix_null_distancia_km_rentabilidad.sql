-- 463_fix_null_distancia_km_rentabilidad.sql
--
-- HALLAZGO (2026-08-29, validando aislamiento por empresa de 461 contra
-- datos reales de Litoral): entregas.distancia_km puede ser NULL (entregas
-- viejas / campo no cargado). Tanto v_rentabilidad_zona_ruta (069, recreada
-- en 450) como la nueva obtener_dashboard_ejecutivo_resumen (461) calculan
-- SUM(me.distancia_km) sin COALESCE — una sola fila con distancia_km NULL
-- vuelve NULL toda la suma del grupo (ruta/zona), lo que a su vez vuelve
-- NULL margen_neto_estimado y margen_neto_por_km, aunque haya margen bruto
-- real facturado. No es una regresión de 461: el bug ya estaba en la vista
-- original desde 069. Se corrige acá en las dos definiciones a la vez.
--
-- FIX: COALESCE(e.distancia_km, 0) en el CTE margen_entrega — un km NULL
-- se trata como 0 km (sin costo logístico estimable), no como "toda la
-- ruta es NULL". No cambia ninguna otra fórmula ni el contrato de columnas.
--
-- Verificado en vivo contra Litoral (datos reales) y Maribel (0 datos):
-- margen_neto_total de Litoral pasó de 0 (NULL enmascarado) a 3890, con
-- facturado_total sin cambios (10190). Maribel se mantuvo en cero absoluto
-- — el aislamiento por empresa_id de 461 no se vio afectado por este fix.

-- ── 1. Vista compartida (usada por /api/rutas-live vía service_role) ───────
CREATE OR REPLACE VIEW public.v_rentabilidad_zona_ruta AS
 WITH margen_entrega AS (
         SELECT e.id AS entrega_id,
            e.ruta_id,
            COALESCE(e.distancia_km, 0) AS distancia_km,
            e.duracion_minutos,
            e.estado AS estado_entrega,
            p.cliente_id,
            sum(COALESCE(pi.cantidad_entregada, pi.cantidad) * (pi.precio_unitario - COALESCE(pr.costo, 0::numeric))) AS margen_entrega,
            sum(COALESCE(pi.cantidad_entregada, pi.cantidad) * pi.precio_unitario) AS facturado_entrega
           FROM entregas e
             JOIN pedidos p ON p.id = e.pedido_id
             JOIN pedido_items pi ON pi.pedido_id = p.id
             JOIN productos pr ON pr.id = pi.producto_id
          WHERE e.estado = 'entregado'::text
          GROUP BY e.id, e.ruta_id, e.distancia_km, e.duracion_minutos, e.estado, p.cliente_id
        ), costo_km_empresa AS (
         SELECT empresas.id AS empresa_id,
            COALESCE((empresas.config ->> 'costo_km'::text)::numeric, 0::numeric) AS costo_km
           FROM empresas
        )
 SELECT rt.empresa_id,
    z.id AS zona_id,
    z.nombre AS zona_nombre,
    rt.id AS ruta_id,
    rt.fecha AS ruta_fecha,
    rt.chofer_id,
    count(DISTINCT me.entrega_id) AS entregas_completadas,
    sum(me.margen_entrega) AS margen_total,
    sum(me.facturado_entrega) AS facturado_total,
    sum(me.distancia_km) AS km_recorridos,
    sum(me.duracion_minutos) AS minutos_recorridos,
    ck.costo_km AS costo_km_configurado,
    round(sum(me.distancia_km) * ck.costo_km, 2) AS costo_logistico_estimado,
    round(sum(me.margen_entrega) - sum(me.distancia_km) * ck.costo_km, 2) AS margen_neto_estimado,
        CASE
            WHEN sum(me.distancia_km) > 0::numeric THEN round((sum(me.margen_entrega) - sum(me.distancia_km) * ck.costo_km) / sum(me.distancia_km), 2)
            ELSE NULL::numeric
        END AS margen_neto_por_km
   FROM margen_entrega me
     JOIN rutas rt ON rt.id = me.ruta_id
     JOIN clientes c ON c.id = me.cliente_id
     LEFT JOIN zonas z ON z.id = c.zona_id
     JOIN costo_km_empresa ck ON ck.empresa_id = rt.empresa_id
  GROUP BY rt.empresa_id, z.id, z.nombre, rt.id, rt.fecha, rt.chofer_id, ck.costo_km
  ORDER BY rt.fecha DESC, (round(sum(me.margen_entrega) - sum(me.distancia_km) * ck.costo_km, 2)) DESC;

REVOKE ALL ON public.v_rentabilidad_zona_ruta FROM anon, authenticated, public;
GRANT SELECT ON public.v_rentabilidad_zona_ruta TO service_role;

-- ── 2. RPC del panel ejecutivo (461) — mismo fix en su copia del CTE ───────
CREATE OR REPLACE FUNCTION public.obtener_dashboard_ejecutivo_resumen(
  p_empresa_id UUID,
  p_desde      TIMESTAMPTZ,
  p_hasta      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH
  dias_pago_cliente AS (
    SELECT co.cliente_id,
           avg(EXTRACT(epoch FROM co.fecha - f.fecha_vencimiento::timestamp with time zone) / 86400.0) AS dias_prom
    FROM cobros co
    JOIN cta_cte cc ON cc.cobro_id = co.id
    JOIN facturas f ON f.id = cc.factura_id
    WHERE co.fecha >= (now() - '90 days'::interval)
      AND co.empresa_id = p_empresa_id
    GROUP BY co.cliente_id
  ),
  cheques_cliente AS (
    SELECT cheques.cliente_id,
           count(*) FILTER (WHERE cheques.estado = 'rechazado'::text) AS rechazados,
           count(*) AS total_cheques
    FROM cheques
    WHERE cheques.cliente_id IS NOT NULL
      AND cheques.empresa_id = p_empresa_id
    GROUP BY cheques.cliente_id
  ),
  cubierto_por_cliente AS (
    SELECT f.cliente_id, SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0::numeric), 0::numeric)) AS cubierto
    FROM facturas f
    WHERE f.estado = ANY (ARRAY['emitida'::estado_factura, 'parcial'::estado_factura, 'pendiente'::estado_factura, 'error_afip'::estado_factura])
      AND f.empresa_id = p_empresa_id
    GROUP BY f.cliente_id
  ),
  componentes AS (
    SELECT
        f.id AS factura_id,
        f.empresa_id,
        f.cliente_id,
        f.numero,
        f.total,
        f.total_cobrado,
        f.total - COALESCE(f.total_cobrado, 0::numeric) AS saldo_pendiente,
        f.fecha_vencimiento,
        GREATEST(0, CURRENT_DATE - f.fecha_vencimiento) AS dias_vencida,
        c.razon_social,
        c.nombre_fantasia,
        c.score_categoria,
        c.limite_credito,
        calcular_deuda_cliente(c.id) AS deuda_actual,
        CASE
            WHEN dp.dias_prom IS NULL THEN 20
            WHEN dp.dias_prom <= '-5'::integer::numeric THEN 40
            WHEN dp.dias_prom <= 0::numeric THEN 35
            WHEN dp.dias_prom <= 7::numeric THEN 25
            WHEN dp.dias_prom <= 15::numeric THEN 15
            WHEN dp.dias_prom <= 30::numeric THEN 5
            ELSE 0
        END AS pts_pagos,
        CASE
            WHEN COALESCE(ch.total_cheques, 0::bigint) = 0 THEN 18::numeric
            ELSE GREATEST(0::numeric, round(25::numeric - 25.0 * ch.rechazados::numeric / ch.total_cheques::numeric))
        END AS pts_cheques,
        CASE
            WHEN COALESCE(c.limite_credito, 0::numeric) = 0::numeric THEN 10
            WHEN calcular_deuda_cliente(c.id) <= 0::numeric THEN 20
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.3 THEN 16
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.6 THEN 10
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.9 THEN 4
            ELSE 0
        END AS pts_deuda,
        CASE c.score_categoria
            WHEN 'premium'::text THEN 15
            WHEN 'bueno'::text THEN 11
            WHEN 'normal'::text THEN 7
            WHEN 'riesgo'::text THEN 2
            WHEN 'bloqueado'::text THEN 0
            ELSE 7
        END AS pts_categoria
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    LEFT JOIN dias_pago_cliente dp ON dp.cliente_id = f.cliente_id
    LEFT JOIN cheques_cliente ch ON ch.cliente_id = f.cliente_id
    WHERE (f.estado = ANY (ARRAY['emitida'::estado_factura, 'parcial'::estado_factura, 'pendiente'::estado_factura, 'error_afip'::estado_factura]))
      AND (f.total - COALESCE(f.total_cobrado, 0::numeric)) > 0::numeric
      AND f.empresa_id = p_empresa_id

    UNION ALL

    SELECT
        NULL::uuid AS factura_id,
        c.empresa_id,
        c.id AS cliente_id,
        'Sin comprobante'::text AS numero,
        GREATEST(c.saldo_deuda - COALESCE(cc.cubierto, 0::numeric), 0::numeric) AS total,
        0::numeric AS total_cobrado,
        GREATEST(c.saldo_deuda - COALESCE(cc.cubierto, 0::numeric), 0::numeric) AS saldo_pendiente,
        CURRENT_DATE AS fecha_vencimiento,
        0 AS dias_vencida,
        c.razon_social,
        c.nombre_fantasia,
        c.score_categoria,
        c.limite_credito,
        calcular_deuda_cliente(c.id) AS deuda_actual,
        CASE
            WHEN dp.dias_prom IS NULL THEN 20
            WHEN dp.dias_prom <= '-5'::integer::numeric THEN 40
            WHEN dp.dias_prom <= 0::numeric THEN 35
            WHEN dp.dias_prom <= 7::numeric THEN 25
            WHEN dp.dias_prom <= 15::numeric THEN 15
            WHEN dp.dias_prom <= 30::numeric THEN 5
            ELSE 0
        END AS pts_pagos,
        CASE
            WHEN COALESCE(ch.total_cheques, 0::bigint) = 0 THEN 18::numeric
            ELSE GREATEST(0::numeric, round(25::numeric - 25.0 * ch.rechazados::numeric / ch.total_cheques::numeric))
        END AS pts_cheques,
        CASE
            WHEN COALESCE(c.limite_credito, 0::numeric) = 0::numeric THEN 10
            WHEN calcular_deuda_cliente(c.id) <= 0::numeric THEN 20
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.3 THEN 16
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.6 THEN 10
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.9 THEN 4
            ELSE 0
        END AS pts_deuda,
        CASE c.score_categoria
            WHEN 'premium'::text THEN 15
            WHEN 'bueno'::text THEN 11
            WHEN 'normal'::text THEN 7
            WHEN 'riesgo'::text THEN 2
            WHEN 'bloqueado'::text THEN 0
            ELSE 7
        END AS pts_categoria
    FROM clientes c
    LEFT JOIN cubierto_por_cliente cc ON cc.cliente_id = c.id
    LEFT JOIN dias_pago_cliente dp ON dp.cliente_id = c.id
    LEFT JOIN cheques_cliente ch ON ch.cliente_id = c.id
    WHERE c.saldo_deuda > COALESCE(cc.cubierto, 0::numeric)
      AND c.empresa_id = p_empresa_id
  ),
  cobranza_priorizada AS (
    SELECT *,
           CASE
             WHEN (pts_pagos + pts_cheques + pts_deuda + pts_categoria) >= 60 THEN 'cobro_probable'
             WHEN (pts_pagos + pts_cheques + pts_deuda + pts_categoria) >= 35 THEN 'seguimiento'
             ELSE 'accion_urgente'
           END AS prioridad
    FROM componentes
  ),
  margen_entrega AS (
    SELECT
      e.id            AS entrega_id,
      e.ruta_id,
      COALESCE(e.distancia_km, 0) AS distancia_km,
      p.cliente_id,
      SUM(
        COALESCE(pi.cantidad_entregada, pi.cantidad)
        * (pi.precio_unitario - COALESCE(pr.costo, 0))
      ) AS margen_entrega,
      SUM(
        COALESCE(pi.cantidad_entregada, pi.cantidad) * pi.precio_unitario
      ) AS facturado_entrega
    FROM entregas e
    JOIN pedidos p       ON p.id = e.pedido_id
    JOIN pedido_items pi ON pi.pedido_id = p.id
    JOIN productos pr    ON pr.id = pi.producto_id
    WHERE e.estado = 'entregado'
      AND p.empresa_id = p_empresa_id
    GROUP BY e.id, e.ruta_id, e.distancia_km, p.cliente_id
  ),
  costo_km_empresa AS (
    SELECT id AS empresa_id, COALESCE((config->>'costo_km')::numeric, 0) AS costo_km
    FROM empresas
    WHERE id = p_empresa_id
  ),
  base AS (
    SELECT
      rt.id AS ruta_id, rt.fecha AS ruta_fecha, z.nombre AS zona_nombre,
      SUM(me.margen_entrega) - (SUM(me.distancia_km) * ck.costo_km) AS margen_neto_estimado,
      SUM(me.facturado_entrega) AS facturado_total,
      SUM(me.distancia_km) AS km_recorridos
    FROM margen_entrega me
    JOIN rutas rt           ON rt.id = me.ruta_id
    JOIN clientes c         ON c.id = me.cliente_id
    LEFT JOIN zonas z       ON z.id = c.zona_id
    JOIN costo_km_empresa ck ON ck.empresa_id = rt.empresa_id
    WHERE rt.empresa_id = p_empresa_id
      AND rt.fecha >= p_desde::date AND rt.fecha <= p_hasta::date
    GROUP BY rt.id, rt.fecha, z.nombre, ck.costo_km
  ),
  por_zona AS (
    SELECT
      COALESCE(zona_nombre, 'Sin zona') AS zona_nombre,
      SUM(margen_neto_estimado) AS margen_neto_zona,
      SUM(facturado_total) AS facturado_zona
    FROM base
    GROUP BY COALESCE(zona_nombre, 'Sin zona')
  )
  SELECT jsonb_build_object(
    'cobranza', (
      SELECT jsonb_build_object(
        'total_pendiente', COALESCE(SUM(saldo_pendiente), 0),
        'monto_accion_urgente', COALESCE(SUM(saldo_pendiente) FILTER (WHERE prioridad = 'accion_urgente'), 0),
        'monto_seguimiento', COALESCE(SUM(saldo_pendiente) FILTER (WHERE prioridad = 'seguimiento'), 0),
        'monto_cobro_probable', COALESCE(SUM(saldo_pendiente) FILTER (WHERE prioridad = 'cobro_probable'), 0),
        'facturas_urgentes_count', COUNT(*) FILTER (WHERE prioridad = 'accion_urgente'),
        'top_urgentes', COALESCE((
          SELECT jsonb_agg(t) FROM (
            SELECT razon_social, nombre_fantasia AS cliente_nombre, numero AS numero_factura, saldo_pendiente, dias_vencida
            FROM cobranza_priorizada
            WHERE prioridad = 'accion_urgente'
            ORDER BY saldo_pendiente DESC
            LIMIT 5
          ) t
        ), '[]'::jsonb)
      )
      FROM cobranza_priorizada
    ),
    'rentabilidad', (
      SELECT jsonb_build_object(
        'margen_neto_total', COALESCE((SELECT SUM(margen_neto_estimado) FROM base), 0),
        'facturado_total', COALESCE((SELECT SUM(facturado_total) FROM base), 0),
        'km_recorridos_total', COALESCE((SELECT SUM(km_recorridos) FROM base), 0),
        'mejor_zona', (SELECT jsonb_build_object('zona_nombre', zona_nombre, 'margen_neto_zona', margen_neto_zona)
                        FROM por_zona ORDER BY margen_neto_zona DESC NULLS LAST LIMIT 1),
        'peor_zona', (SELECT jsonb_build_object('zona_nombre', zona_nombre, 'margen_neto_zona', margen_neto_zona)
                       FROM por_zona ORDER BY margen_neto_zona ASC NULLS LAST LIMIT 1),
        'por_zona', COALESCE((
          SELECT jsonb_agg(z ORDER BY z.margen_neto_zona DESC) FROM (
            SELECT zona_nombre, margen_neto_zona, facturado_zona FROM por_zona LIMIT 8
          ) z
        ), '[]'::jsonb)
      )
    ),
    'stock', (
      WITH crit AS (
        SELECT s.producto_id,
               p.nombre, p.codigo,
               SUM(s.cantidad) - SUM(s.cantidad_reservada) AS disponible,
               MAX(p.stock_minimo) AS minimo
        FROM stock s
        JOIN productos p ON p.id = s.producto_id
        JOIN depositos d ON d.id = s.deposito_id
        WHERE d.empresa_id = p_empresa_id AND p.activo = true
        GROUP BY s.producto_id, p.nombre, p.codigo
        HAVING SUM(s.cantidad) - SUM(s.cantidad_reservada) <= GREATEST(MAX(p.stock_minimo), 5)
      )
      SELECT jsonb_build_object(
        'criticos_count', (SELECT COUNT(*) FROM crit),
        'top_criticos', COALESCE((
          SELECT jsonb_agg(c) FROM (
            SELECT nombre, codigo, disponible, minimo FROM crit
            ORDER BY disponible ASC LIMIT 5
          ) c
        ), '[]'::jsonb)
      )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.obtener_dashboard_ejecutivo_resumen FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_dashboard_ejecutivo_resumen TO service_role;
