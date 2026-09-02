-- 461_perf_scope_empresa_dashboard_ejecutivo.sql
--
-- Load test (2026-08-29) detectó /api/admin/dashboard-ejecutivo con 0.6
-- req/s y 100% de timeouts bajo 30 conexiones concurrentes.
--
-- CAUSA RAÍZ: obtener_dashboard_ejecutivo_resumen() (243) lee de
-- v_cobranza_priorizada y v_rentabilidad_zona_ruta y filtra por
-- `empresa_id = p_empresa_id` recién en el SELECT final. Pero las CTEs
-- internas de esas vistas (dias_pago_cliente, cheques_cliente,
-- cubierto_por_cliente en 067/412; margen_entrega en 069) NO filtran por
-- empresa — agregan cobros/cta_cte/facturas/cheques/entregas de TODAS las
-- empresas del SaaS en cada GROUP BY, antes de que el filtro por empresa
-- pueda aplicarse. Cada llamada a esta RPC recalcula esas agregaciones a
-- escala de toda la plataforma, no de la empresa que abrió el panel — y
-- esto empeora con el crecimiento de OTRAS empresas, no de la propia.
-- Con 30 requests concurrentes (uno por conexión del load test) son 30
-- recálculos globales simultáneos: de ahí el 100% de timeouts.
--
-- FIX: esta migración NO toca v_cobranza_priorizada ni
-- v_rentabilidad_zona_ruta (las sigue usando /api/score y otras pantallas
-- sin haber mostrado el mismo problema en este load test — cambiarlas de
-- lastre sería mayor superficie de riesgo sin necesidad). En cambio,
-- reescribe SOLO obtener_dashboard_ejecutivo_resumen() para calcular
-- cobranza y rentabilidad con las mismas fórmulas, pero empujando el
-- filtro por empresa_id adentro de cada CTE desde el arranque —
-- exactamente el mismo cálculo, solo que acotado a una empresa en vez de
-- a toda la base.
--
-- Verificado contra las columnas reales del schema (001_schema.sql):
-- cobros.empresa_id, cheques.empresa_id, facturas.empresa_id y
-- pedidos.empresa_id existen todos directamente (no hace falta join extra
-- para scopear).
--
-- IMPORTANTE: probar en un ambiente de staging con datos de más de una
-- empresa antes de aplicar en prod, comparando el JSON de salida contra la
-- versión vieja para la misma empresa/período — la lógica de puntaje y
-- las fórmulas de margen no cambiaron, solo el scope de las agregaciones,
-- pero es un cálculo financiero/comercial y merece ese chequeo.

CREATE OR REPLACE FUNCTION public.obtener_dashboard_ejecutivo_resumen(
  p_empresa_id UUID,
  p_desde      TIMESTAMPTZ,
  p_hasta      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH
  -- ── Cobranza, scopeada por empresa (réplica de v_cobranza_priorizada,
  -- ver 067/411/412, pero con empresa_id empujado a cada CTE) ────────────
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
           saldo_pendiente,
           CASE
             WHEN (pts_pagos + pts_cheques + pts_deuda + pts_categoria) >= 60 THEN 'cobro_probable'
             WHEN (pts_pagos + pts_cheques + pts_deuda + pts_categoria) >= 35 THEN 'seguimiento'
             ELSE 'accion_urgente'
           END AS prioridad
    FROM componentes
  ),

  -- ── Rentabilidad, scopeada por empresa (réplica de
  -- v_rentabilidad_zona_ruta, ver 069, con empresa_id empujado dentro de
  -- margen_entrega) ───────────────────────────────────────────────────────
  margen_entrega AS (
    SELECT
      e.id            AS entrega_id,
      e.ruta_id,
      e.distancia_km,
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
  -- zona_nombre sale del cliente de la entrega (clientes.zona_id), no de
  -- la ruta — mismo criterio que v_rentabilidad_zona_ruta (069).
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
    GROUP BY rt.id, rt.fecha, z.nombre
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

    -- Stock crítico: sin cambios respecto a la versión anterior — ya
    -- filtraba por empresa desde el arranque (join a depositos con
    -- d.empresa_id = p_empresa_id), no formaba parte del problema.
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

-- Índices de apoyo para las CTEs recién scopeadas — sin esto, el filtro
-- por empresa_id en cobros/cheques/facturas/pedidos sigue siendo un scan
-- completo de esas tablas (acotado a la empresa, pero sin índice igual
-- escanea de más bajo concurrencia).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cobros_empresa_fecha
  ON public.cobros (empresa_id, fecha);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cheques_empresa_cliente
  ON public.cheques (empresa_id, cliente_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_facturas_empresa_estado
  ON public.facturas (empresa_id, estado);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entregas_estado_ruta
  ON public.entregas (estado, ruta_id);

-- ⚠️ Mismo aviso que en 460: los CREATE INDEX CONCURRENTLY no pueden ir en
-- una transacción. La función (CREATE OR REPLACE FUNCTION) sí puede
-- aplicarse vía migración normal; separen los índices si su pipeline
-- envuelve todo en una sola transacción.
