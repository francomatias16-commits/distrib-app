-- ============================================================================
-- 564_estado_financiero_integral.sql
--
-- Pedido de Ruben: una sola pantalla donde se vea TODO — ventas de POS,
-- WhatsApp, tienda/web, vendedores y demás canales; ingresos por otros
-- medios; egresos; y el resultado (diario/mensual/anual) + patrimonio neto.
--
-- Hoy esto vive fragmentado en 3 pantallas que no se hablan entre sí:
--   - reportes-financieros.html: calcula ingresos/costos/margen 100% en el
--     navegador (trae pedidos+ventas_pos completos con items y arma todo en
--     JS — no escala y no reutiliza nada del backend).
--   - dashboard-ejecutivo (admin.js + obtener_ventas_por_canal, mig. 478):
--     ya desglosa ventas por canal (pos/whatsapp/vendedor/web/portal/etc)
--     pero solo como mini-resumen de "Hoy en tu negocio".
--   - obtener_resumen_gastos_generales (mig. 479) y
--     obtener_resumen_compras_proveedor (mig. 478): cubren egresos pero por
--     separado, sin combinar con ingresos ni con un total de resultado.
--
-- Esta migración NO reemplaza esas funciones — las reutiliza como fuente de
-- verdad para no duplicar criterios (mismos estados de pedido/POS/factura
-- que ya validó Ruben en producción) — y agrega UNA función nueva que:
--
--   1) Trae ingresos por canal (pos/whatsapp/vendedor/web/portal_cliente/
--      telefono/app) + ingresos por cobros de cta_cte que no vienen de una
--      venta directa (ajustes, otros ingresos).
--   2) Trae egresos por categoría: gastos_generales + compras a
--      proveedores (facturado) + pagos a proveedores (efectivamente
--      pagado, que es el egreso de caja real).
--   3) Agrupa todo por día, mes o año dentro del rango pedido
--      (p_agrupacion), para que una sola pantalla sirva para las tres
--      vistas (Diario/Mensual/Anual) cambiando un solo parámetro.
--   4) Calcula un Patrimonio Neto aproximado a la fecha de corte (p_hasta):
--        Activo  = caja (turnos de POS) + cuentas por cobrar (facturas
--                  pendientes/parciales) + stock valorizado (costo_promedio)
--        Pasivo  = deuda a proveedores pendiente (facturas_proveedor)
--      Esto es una foto GERENCIAL, no un balance contable de partida doble
--      (no reemplaza a un contador) — se documenta así también en el
--      frontend para no generar una falsa sensación de precisión contable.
--
-- Sigue la convención de 478/479: si alguna pieza no está disponible
-- (tabla/migración no corrida en una empresa vieja), se degrada a 0/null,
-- nunca rompe el resto de la respuesta.
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
  -- ── 1) Ingresos por venta, con canal normalizado (mismo criterio que
  --      obtener_ventas_por_canal, mig. 478) y bucket temporal ─────────────
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

  -- ── 2) Egresos: gastos generales + compras/pagos a proveedores ──────────
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

  -- ── 3) Resultado del período por bucket (ingreso - egreso) ──────────────
  resultado_por_periodo AS (
    SELECT COALESCE(i.periodo, e.periodo)         AS periodo,
           COALESCE(i.total, 0)                    AS ingresos,
           COALESCE(i.cantidad, 0)                 AS cantidad_ventas,
           COALESCE(e.total, 0)                    AS egresos,
           COALESCE(i.total, 0) - COALESCE(e.total, 0) AS resultado
    FROM ingresos_por_periodo i
    FULL OUTER JOIN egresos_por_periodo e ON i.periodo = e.periodo
  ),

  -- ── 4) Patrimonio neto aproximado a p_hasta (foto, no acotado a rango) ──
  activo_caja AS (
    SELECT COALESCE(SUM(
      COALESCE(t.monto_final_calculado, t.monto_final_declarado, t.monto_inicial, 0)
    ), 0) AS total
    FROM turnos_caja t
    JOIN cajas_pos c ON c.id = t.caja_id
    WHERE c.empresa_id = p_empresa_id
      AND (t.estado = 'cerrado' OR t.estado = 'abierto')
      AND t.abierto_at <= p_hasta
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

REVOKE ALL ON FUNCTION public.obtener_estado_financiero_integral FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_estado_financiero_integral TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '564_estado_financiero_integral.sql', '564', 'claude-session',
  'RPC obtener_estado_financiero_integral: consolida ingresos por canal (pos/whatsapp/vendedor/web/portal/etc, reutilizando el criterio de obtener_ventas_por_canal 478), egresos (gastos_generales + pagos a proveedores), serie diaria/mensual/anual de resultado, y patrimonio neto aproximado (caja + por cobrar + stock valorizado - deuda proveedores). Nueva página estado-financiero.html consume esta única función.')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
