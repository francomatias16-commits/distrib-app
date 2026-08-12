-- ============================================================================
-- 230_kpis_dashboard_v3_afip_cheques_catalogo.sql
--
-- El panel principal (rediseño Fireart) reemplaza las 4 tarjetas KPI
-- genéricas por 4 indicadores más accionables para el dueño/admin del
-- negocio: Facturación AFIP, Riesgo de cheques / situación crediticia,
-- Catálogo para clientes y accesos directos. Esta migración agrega esos
-- campos a la función de KPIs del dashboard sin tocar obtener_kpis_dashboard
-- ni obtener_kpis_dashboard_v2 (se siguen usando en otros lugares, por
-- ejemplo dashboard-control-tower.js). Se versiona una _v3 aparte, misma
-- convención que ya se usó al pasar de v1 a v2 (ver 076_kpis_dashboard.sql).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.obtener_kpis_dashboard_v3(
  p_empresa_id     UUID,
  p_desde          TIMESTAMPTZ,
  p_hasta          TIMESTAMPTZ,
  p_desde_anterior TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT (
    -- Reutiliza todos los campos ya existentes en v2 (ventas, pedidos,
    -- clientes activos, stock crítico) y les suma los 4 nuevos.
    public.obtener_kpis_dashboard_v2(p_empresa_id, p_desde, p_hasta, p_desde_anterior)
    || jsonb_build_object(
      -- ── Facturación AFIP/ARCA ────────────────────────────────────────
      'facturas_emitidas_periodo', (
        SELECT COUNT(*) FROM facturas
        WHERE empresa_id = p_empresa_id
          AND estado = 'emitida'
          AND fecha_emision >= p_desde AND fecha_emision <= p_hasta
      ),
      'facturas_total_periodo', COALESCE((
        SELECT SUM(total) FROM facturas
        WHERE empresa_id = p_empresa_id
          AND estado = 'emitida'
          AND fecha_emision >= p_desde AND fecha_emision <= p_hasta
      ), 0),
      'facturas_error_afip', (
        SELECT COUNT(*) FROM facturas
        WHERE empresa_id = p_empresa_id AND estado = 'error_afip'
      ),

      -- ── Riesgo de cheques / situación crediticia ─────────────────────
      'cheques_riesgo_clientes', (
        SELECT COUNT(DISTINCT c.cliente_id)
        FROM cheques c
        JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.empresa_id = p_empresa_id
          AND c.estado = 'en_cartera'
          AND cl.score_categoria IN ('riesgo','bloqueado')
      ),
      'cheques_riesgo_monto', COALESCE((
        SELECT SUM(c.monto)
        FROM cheques c
        JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.empresa_id = p_empresa_id
          AND c.estado = 'en_cartera'
          AND cl.score_categoria IN ('riesgo','bloqueado')
      ), 0),

      -- ── Catálogo para clientes (portal online) ───────────────────────
      'productos_catalogo_count', (
        SELECT COUNT(*) FROM productos
        WHERE empresa_id = p_empresa_id AND activo = true
      )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.obtener_kpis_dashboard_v3 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_kpis_dashboard_v3 TO service_role;
