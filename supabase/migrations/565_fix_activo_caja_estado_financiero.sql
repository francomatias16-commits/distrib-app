-- ============================================================================
-- 565_fix_activo_caja_estado_financiero.sql
--
-- Fix de obtener_estado_financiero_integral (mig. 564): "Activo → Caja"
-- sumaba el monto_final de TODOS los turnos históricos de cada caja, en
-- vez de tomar solo el turno vigente/más reciente. Cada turno se abre con
-- un monto_inicial contado a mano por el cajero (no se encadena del
-- cierre anterior) — es una foto puntual de ESE turno, no efectivo
-- acumulable. Sumar el histórico completo duplicaba caja que ya se
-- retiró/depositó hace tiempo, inflando Activo y Patrimonio Neto de forma
-- irreal (más turnos históricos = más "caja fantasma").
--
-- Fix: DISTINCT ON (caja_id) ordenado por abierto_at DESC, para tomar
-- solo el turno más reciente de cada caja a la fecha de corte (p_hasta).
--
-- Aplicada directo en Supabase (jgiquzjwoedmzwqgzubr) — DB changes apply
-- immediately, este archivo es el respaldo en el repo del CREATE OR
-- REPLACE ya corrido.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.obtener_estado_financiero_integral(
  p_empresa_id UUID,
  p_desde      TIMESTAMPTZ,
  p_hasta      TIMESTAMPTZ,
  p_agrupacion TEXT DEFAULT 'dia'  -- 'dia' | 'mes' | 'anio'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_trunc TEXT;
  v_resultado JSONB;
BEGIN
  v_trunc := CASE p_agrupacion
    WHEN 'mes'  THEN 'month'
    WHEN 'anio' THEN 'year'
    ELSE 'day'
  END;

  WITH
  ventas AS (
    SELECT date_trunc(v_trunc, fecha_pedido) AS periodo,
           COALESCE(canal, 'web')            AS canal,
           total
    FROM pedidos
    WHERE empresa_id = p_empresa_id
      AND estado IN ('confirmado','preparando','despachado','entregado')
      AND fecha_pedido >= p_desde AND fecha_pedido <= p_hasta
    UNION ALL
    SELECT date_trunc(v_trunc, created_at) AS periodo,
           'pos'                           AS canal,
           total
    FROM ventas_pos
    WHERE empresa_id = p_empresa_id
      AND estado = 'completada'
      AND created_at >= p_desde AND created_at <= p_hasta
  ),
  ingresos_por_periodo AS (
    SELECT periodo, COALESCE(SUM(total), 0) AS total, COUNT(*) AS cantidad
    FROM ventas GROUP BY periodo
  ),
  ingresos_por_canal AS (
    SELECT canal, COALESCE(SUM(total), 0) AS total, COUNT(*) AS cantidad
    FROM ventas GROUP BY canal
  ),

  gastos_periodo AS (
    SELECT date_trunc(v_trunc, fecha::timestamptz) AS periodo, categoria, monto
    FROM gastos_generales
    WHERE empresa_id = p_empresa_id AND activo = true
      AND fecha >= p_desde::date AND fecha <= p_hasta::date
  ),
  egresos_gastos_por_periodo AS (
    SELECT periodo, COALESCE(SUM(monto), 0) AS total
    FROM gastos_periodo GROUP BY periodo
  ),
  egresos_gastos_por_categoria AS (
    SELECT categoria, COALESCE(SUM(monto), 0) AS total
    FROM gastos_periodo GROUP BY categoria
  ),
  pagos_prov_periodo AS (
    SELECT date_trunc(v_trunc, fecha_pago::timestamptz) AS periodo, monto
    FROM pagos_proveedor
    WHERE empresa_id = p_empresa_id
      AND fecha_pago >= p_desde::date AND fecha_pago <= p_hasta::date
  ),
  egresos_proveedor_por_periodo AS (
    SELECT periodo, COALESCE(SUM(monto), 0) AS total
    FROM pagos_prov_periodo GROUP BY periodo
  ),
  egresos_por_periodo AS (
    SELECT COALESCE(g.periodo, p.periodo) AS periodo,
           COALESCE(g.total, 0) + COALESCE(p.total, 0) AS total
    FROM egresos_gastos_por_periodo g
    FULL OUTER JOIN egresos_proveedor_por_periodo p ON g.periodo = p.periodo
  ),
  compras_prov_total AS (
    SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS cantidad
    FROM facturas_proveedor
    WHERE empresa_id = p_empresa_id AND estado != 'anulada'
      AND fecha_factura >= p_desde::date AND fecha_factura <= p_hasta::date
  ),

  resultado_por_periodo AS (
    SELECT COALESCE(i.periodo, e.periodo)         AS periodo,
           COALESCE(i.total, 0)                    AS ingresos,
           COALESCE(i.cantidad, 0)                 AS cantidad_ventas,
           COALESCE(e.total, 0)                    AS egresos,
           COALESCE(i.total, 0) - COALESCE(e.total, 0) AS resultado
    FROM ingresos_por_periodo i
    FULL OUTER JOIN egresos_por_periodo e ON i.periodo = e.periodo
  ),

  activo_caja AS (
    -- Cada turno se abre con un monto_inicial contado a mano por el
    -- cajero (no se encadena del cierre anterior) — es una foto puntual
    -- de ESE turno, no efectivo acumulable. Sumar todos los turnos
    -- históricos duplicaría caja que ya se retiró/depositó hace tiempo.
    -- Se toma solo el turno más reciente (abierto o cerrado) de cada
    -- caja, a la fecha de corte.
    SELECT COALESCE(SUM(
      COALESCE(ultimo.monto_final_calculado, ultimo.monto_final_declarado, ultimo.monto_inicial, 0)
    ), 0) AS total
    FROM (
      SELECT DISTINCT ON (t.caja_id)
             t.monto_final_calculado, t.monto_final_declarado, t.monto_inicial
      FROM turnos_caja t
      JOIN cajas_pos c ON c.id = t.caja_id
      WHERE c.empresa_id = p_empresa_id
        AND t.abierto_at <= p_hasta
      ORDER BY t.caja_id, t.abierto_at DESC
    ) ultimo
  ),
  activo_por_cobrar AS (
    SELECT COALESCE(SUM(total - COALESCE(total_cobrado, 0)), 0) AS total
    FROM facturas
    WHERE empresa_id = p_empresa_id
      AND estado IN ('emitida','parcial')
      AND fecha_emision <= p_hasta
  ),
  activo_stock AS (
    SELECT COALESCE(SUM(s.cantidad * s.costo_promedio), 0) AS total
    FROM stock s
    JOIN depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
  ),
  pasivo_proveedores AS (
    SELECT COALESCE(SUM(total - total_pagado), 0) AS total
    FROM facturas_proveedor
    WHERE empresa_id = p_empresa_id
      AND estado IN ('pendiente','parcial')
      AND fecha_factura <= p_hasta::date
  )

  SELECT jsonb_build_object(
    'agrupacion', p_agrupacion,
    'desde', p_desde,
    'hasta', p_hasta,

    'serie', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'periodo', r.periodo,
        'ingresos', r.ingresos,
        'cantidad_ventas', r.cantidad_ventas,
        'egresos', r.egresos,
        'resultado', r.resultado
      ) ORDER BY r.periodo)
      FROM resultado_por_periodo r
    ), '[]'::jsonb),

    'ingresos_por_canal', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'canal', c.canal, 'total', c.total, 'cantidad', c.cantidad
      ) ORDER BY c.total DESC)
      FROM ingresos_por_canal c
    ), '[]'::jsonb),

    'egresos_por_categoria', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'categoria', cat.categoria, 'total', cat.total
      ) ORDER BY cat.total DESC)
      FROM egresos_gastos_por_categoria cat
    ), '[]'::jsonb),

    'compras_proveedor_periodo', (SELECT jsonb_build_object(
      'total', total, 'cantidad', cantidad) FROM compras_prov_total),

    'totales', jsonb_build_object(
      'ingresos', COALESCE((SELECT SUM(total) FROM ingresos_por_canal), 0),
      'egresos',  COALESCE((SELECT SUM(total) FROM egresos_gastos_por_categoria), 0)
                + COALESCE((SELECT SUM(monto) FROM pagos_prov_periodo), 0),
      'resultado', COALESCE((SELECT SUM(total) FROM ingresos_por_canal), 0)
                 - (COALESCE((SELECT SUM(total) FROM egresos_gastos_por_categoria), 0)
                    + COALESCE((SELECT SUM(monto) FROM pagos_prov_periodo), 0))
    ),

    'patrimonio_neto', jsonb_build_object(
      'activo', jsonb_build_object(
        'caja', (SELECT total FROM activo_caja),
        'por_cobrar', (SELECT total FROM activo_por_cobrar),
        'stock_valorizado', (SELECT total FROM activo_stock),
        'total', (SELECT total FROM activo_caja) + (SELECT total FROM activo_por_cobrar) + (SELECT total FROM activo_stock)
      ),
      'pasivo', jsonb_build_object(
        'deuda_proveedores', (SELECT total FROM pasivo_proveedores),
        'total', (SELECT total FROM pasivo_proveedores)
      ),
      'neto', (
        (SELECT total FROM activo_caja) + (SELECT total FROM activo_por_cobrar) + (SELECT total FROM activo_stock)
        - (SELECT total FROM pasivo_proveedores)
      ),
      'nota', 'Foto gerencial aproximada, no es un balance contable de partida doble.'
    )
  ) INTO v_resultado;

  RETURN v_resultado;
END;
$function$;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '565_fix_activo_caja_estado_financiero.sql', '565', 'claude-session',
  'Fix de obtener_estado_financiero_integral (564): activo_caja tomaba la suma de TODOS los turnos históricos de cada caja en vez de solo el más reciente, inflando Caja/Activo/Patrimonio de forma irreal. Ahora usa DISTINCT ON (caja_id) ordenado por abierto_at DESC.')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
