-- ============================================================================
-- 066_semaforo_accion_cobranza.sql
--
-- Innovación #4 (Semáforo de Cliente → Acción de Cobranza), según
-- roadmap-innovaciones-distrib.md.
--
-- Contenido:
--   1. RPC calcular_deuda_cliente(): extrae a una función reusable la misma
--      lógica de suma de cta_cte que ya usa calcular_score_cliente()
--      internamente (debito - haber), para no duplicarla en JS. La van a
--      usar score.js (oferta de plan de pago) y más adelante #9
--      (priorización de cobranza).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.calcular_deuda_cliente(p_cliente_id uuid)
RETURNS numeric
LANGUAGE sql SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(SUM(CASE WHEN tipo = 'debito' THEN monto ELSE -monto END), 0)
  FROM public.cta_cte
  WHERE cliente_id = p_cliente_id;
$$;

COMMENT ON FUNCTION public.calcular_deuda_cliente IS
  'Deuda total actual del cliente (no solo vencida). Misma fórmula que el '
  'componente de deuda de calcular_score_cliente(). Usada por la acción de '
  'cobranza del semáforo (score.js) para decidir si vale la pena ofrecer '
  'plan de pago, y por reportes de priorización de cobranza.';
