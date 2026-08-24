-- CONCILIACION-AUDIT-02 (auditoría etapa 3): conciliacion_buscar_candidatos
-- matcheaba por fecha/monto contra `cobros` sin mirar nunca
-- conciliacion_bancaria_movimientos.tipo. `cobros` son siempre ingresos
-- (dinero que entra), pero un movimiento del extracto puede ser
-- tipo='debito' (comisión bancaria, transferencia saliente, etc.) — si el
-- monto/fecha coinciden por casualidad con un cobro real de un cliente,
-- la UI lo ofrecía como "candidato" y un usuario podía confirmarlo,
-- marcando ese cobro como conciliado_bancario=true por error (y dejándolo
-- sin poder matchear contra su movimiento de crédito real más adelante).
-- Caso real ya en producción: movimiento "COMISION MANTENIMIENTO CUENTA"
-- ($1500, débito) sin filtro de tipo.
--
-- Fix: la función ahora lee también el tipo del movimiento y solo busca
-- candidatos cuando es 'credito' — un débito nunca tiene candidatos hasta
-- que exista un módulo de conciliación contra egresos/gastos (fuera de
-- alcance de esta migración).
CREATE OR REPLACE FUNCTION public.conciliacion_buscar_candidatos(
  p_movimiento_id uuid,
  p_empresa_id uuid,
  p_tolerancia_dias integer DEFAULT 3,
  p_tolerancia_monto numeric DEFAULT 1
)
RETURNS TABLE(cobro_id uuid, fecha timestamp with time zone, monto numeric, cliente_nombre text, medio text, diff_dias integer, diff_monto numeric, score numeric)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_fecha  date;
  v_monto  numeric;
  v_tipo   text;
BEGIN
  SELECT m.fecha, m.monto, m.tipo INTO v_fecha, v_monto, v_tipo
  FROM conciliacion_bancaria_movimientos m
  WHERE m.id = p_movimiento_id AND m.empresa_id = p_empresa_id;

  IF v_fecha IS NULL THEN
    RETURN; -- movimiento inexistente o de otra empresa: sin candidatos
  END IF;

  IF v_tipo IS DISTINCT FROM 'credito' THEN
    RETURN; -- un débito no puede matchear contra un cobro (ingreso)
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.fecha,
    c.monto,
    cli.razon_social,
    c.medio,
    ABS(c.fecha::date - v_fecha)::integer      AS diff_dias,
    ROUND(ABS(c.monto - v_monto), 2)            AS diff_monto,
    ROUND(
      100
      - (ABS(c.fecha::date - v_fecha)::numeric / GREATEST(p_tolerancia_dias, 1)) * 50
      - (ABS(c.monto - v_monto) / GREATEST(p_tolerancia_monto, 0.01)) * 50
    , 2) AS score
  FROM cobros c
  LEFT JOIN clientes cli ON cli.id = c.cliente_id
  WHERE c.empresa_id = p_empresa_id
    AND c.conciliado_bancario = false
    AND ABS(c.monto - v_monto) <= p_tolerancia_monto
    AND ABS(c.fecha::date - v_fecha) <= p_tolerancia_dias
  ORDER BY score DESC, diff_dias ASC
  LIMIT 20;
END;
$function$;
