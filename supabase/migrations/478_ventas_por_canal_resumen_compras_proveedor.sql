-- ============================================================================
-- 478_ventas_por_canal_resumen_compras_proveedor.sql
--
-- Dos RPCs nuevas para "Hoy en tu negocio" (resumen-arranque) y el Panel
-- ejecutivo (dashboard-ejecutivo), pensadas para cerrar la brecha detectada
-- en reportes-financieros/reportes-ventas: esas pantallas ya suman
-- pedidos + ventas_pos para ingresos, pero en ningún lado del panel se ve
-- CÓMO se compone esa venta (por canal) ni qué está pasando del lado de
-- gastos/compras a proveedores (hoy solo visible en Compras y CC Proveedores,
-- pantallas aparte).
--
-- 1) obtener_ventas_por_canal(): pedidos.canal (real, tal como lo usa el
--    filtro de pedidos.html) + ventas_pos como canal fijo 'pos' (la tabla no
--    tiene columna canal — es sí o sí mostrador). Mismo criterio de "venta"
--    que obtener_kpis_dashboard_v2/v3 y obtener_comparativa_mensual:
--    pedidos.estado IN ('confirmado','preparando','despachado','entregado'),
--    ventas_pos.estado = 'completada'.
--
-- 2) obtener_resumen_compras_proveedor(): usa facturas_proveedor +
--    pagos_proveedor (Etapa 8.5, migración 056), mismo criterio que
--    v_cc_proveedor para saldo pendiente/vencidas, pero acá se resume a
--    nivel empresa (no por proveedor) y se acota el período para
--    total_facturado/total_pagado — el saldo pendiente y las vencidas se
--    dejan sin acotar por fecha a propósito, porque una deuda vieja sigue
--    siendo deuda hoy (mismo criterio que "Deuda por Cliente" en
--    reportes-financieros.js).
--
-- Ambas siguen la convención ya establecida en 243_etapa5_...: si la
-- migración no corrió todavía en una empresa, el handler (admin.js) las
-- llama con Promise.all junto a lo demás y, si fallan, degrada el campo a
-- null sin romper el resto de la respuesta.
-- ============================================================================

-- ── 1: ventas por canal ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.obtener_ventas_por_canal(
  p_empresa_id UUID,
  p_desde      TIMESTAMPTZ,
  p_hasta      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH ventas AS (
    SELECT COALESCE(canal, 'web') AS canal, total
    FROM pedidos
    WHERE empresa_id = p_empresa_id
      AND estado IN ('confirmado','preparando','despachado','entregado')
      AND fecha_pedido >= p_desde AND fecha_pedido <= p_hasta
    UNION ALL
    SELECT 'pos' AS canal, total
    FROM ventas_pos
    WHERE empresa_id = p_empresa_id
      AND estado = 'completada'
      AND created_at >= p_desde AND created_at <= p_hasta
  ),
  por_canal AS (
    SELECT canal, COALESCE(SUM(total), 0) AS total, COUNT(*) AS cantidad
    FROM ventas
    GROUP BY canal
  ),
  total_general AS (
    SELECT COALESCE(SUM(total), 0) AS total FROM por_canal
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'canal',      c.canal,
      'total',      c.total,
      'cantidad',   c.cantidad,
      'porcentaje', CASE WHEN tg.total > 0
                       THEN ROUND((c.total / tg.total) * 100, 1)
                       ELSE 0 END
    ) ORDER BY c.total DESC
  ), '[]'::jsonb)
  FROM por_canal c, total_general tg;
$$;

REVOKE ALL ON FUNCTION public.obtener_ventas_por_canal FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_ventas_por_canal TO service_role;


-- ── 2: resumen de compras a proveedores ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.obtener_resumen_compras_proveedor(
  p_empresa_id UUID,
  p_desde      TIMESTAMPTZ,
  p_hasta      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH facturas_periodo AS (
    SELECT * FROM facturas_proveedor
    WHERE empresa_id = p_empresa_id
      AND estado != 'anulada'
      AND fecha_factura >= p_desde::date AND fecha_factura <= p_hasta::date
  ),
  pagos_periodo AS (
    SELECT * FROM pagos_proveedor
    WHERE empresa_id = p_empresa_id
      AND fecha_pago >= p_desde::date AND fecha_pago <= p_hasta::date
  ),
  -- Deuda actual (no acotada por período — una factura vieja sin pagar
  -- sigue pesando hoy, mismo criterio que "Deuda por Cliente").
  pendientes AS (
    SELECT fp.*, prov.razon_social, prov.fantasia
    FROM facturas_proveedor fp
    JOIN proveedores prov ON prov.id = fp.proveedor_id
    WHERE fp.empresa_id = p_empresa_id
      AND fp.estado IN ('pendiente','parcial')
  ),
  por_proveedor AS (
    SELECT
      proveedor_id,
      COALESCE(fantasia, razon_social) AS nombre,
      SUM(total - total_pagado) AS saldo_pendiente,
      COUNT(*) FILTER (WHERE fecha_vencimiento < CURRENT_DATE) AS facturas_vencidas
    FROM pendientes
    GROUP BY proveedor_id, COALESCE(fantasia, razon_social)
  )
  SELECT jsonb_build_object(
    'total_facturado_periodo', COALESCE((SELECT SUM(total) FROM facturas_periodo), 0),
    'total_pagado_periodo',    COALESCE((SELECT SUM(monto) FROM pagos_periodo), 0),
    'facturas_count_periodo',  (SELECT COUNT(*) FROM facturas_periodo),
    'saldo_pendiente_total',   COALESCE((SELECT SUM(saldo_pendiente) FROM por_proveedor), 0),
    'facturas_vencidas_count', COALESCE((SELECT SUM(facturas_vencidas) FROM por_proveedor), 0),
    'top_proveedores_deuda', COALESCE((
      SELECT jsonb_agg(t) FROM (
        SELECT nombre, saldo_pendiente, facturas_vencidas
        FROM por_proveedor
        ORDER BY saldo_pendiente DESC
        LIMIT 5
      ) t
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.obtener_resumen_compras_proveedor FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_resumen_compras_proveedor TO service_role;
