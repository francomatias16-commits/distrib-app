-- ============================================================================
-- 243b_etapa5_fix_labels_mes_espanol_v2.sql
--
-- Fix aplicado en producción sobre 243_etapa5_dashboard_ejecutivo_comparativa_mensual.sql:
-- obtener_comparativa_mensual() devolvía mes_actual_label / mes_anterior_label
-- mal formados (locale del server, no en español). Se reescribe usando un
-- array fijo de nombres de mes en español + initcap, sin depender del locale
-- de la instancia de Postgres.
--
-- Ya aplicada en la base de datos (version 20260708030512). Este archivo
-- deja el repo en paridad con la DB real.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.obtener_comparativa_mensual(
  p_empresa_id UUID,
  p_fecha_ref  DATE DEFAULT CURRENT_DATE
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH meses_es AS (
    SELECT ARRAY['enero','febrero','marzo','abril','mayo','junio','julio',
                 'agosto','septiembre','octubre','noviembre','diciembre'] AS m
  ),
  rango AS (
    SELECT
      date_trunc('month', p_fecha_ref)::date AS inicio_actual,
      p_fecha_ref AS fin_actual,
      (p_fecha_ref - date_trunc('month', p_fecha_ref)::date) AS dias_transcurridos,
      (date_trunc('month', p_fecha_ref) - interval '1 month')::date AS inicio_anterior
  ),
  ventas_actual AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS dia, total
    FROM pedidos, rango
    WHERE empresa_id = p_empresa_id
      AND estado IN ('confirmado','preparando','despachado','entregado')
      AND (created_at AT TIME ZONE 'UTC')::date BETWEEN rango.inicio_actual AND rango.fin_actual
    UNION ALL
    SELECT (created_at AT TIME ZONE 'UTC')::date AS dia, total
    FROM ventas_pos, rango
    WHERE empresa_id = p_empresa_id
      AND estado = 'completada'
      AND (created_at AT TIME ZONE 'UTC')::date BETWEEN rango.inicio_actual AND rango.fin_actual
  ),
  ventas_anterior AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS dia, total
    FROM pedidos, rango
    WHERE empresa_id = p_empresa_id
      AND estado IN ('confirmado','preparando','despachado','entregado')
      AND (created_at AT TIME ZONE 'UTC')::date BETWEEN rango.inicio_anterior
        AND (rango.inicio_anterior + rango.dias_transcurridos)
    UNION ALL
    SELECT (created_at AT TIME ZONE 'UTC')::date AS dia, total
    FROM ventas_pos, rango
    WHERE empresa_id = p_empresa_id
      AND estado = 'completada'
      AND (created_at AT TIME ZONE 'UTC')::date BETWEEN rango.inicio_anterior
        AND (rango.inicio_anterior + rango.dias_transcurridos)
  ),
  serie_actual AS (
    SELECT gs::date AS dia, gs::date - rango.inicio_actual + 1 AS dia_del_mes,
           COALESCE(SUM(va.total), 0) AS total
    FROM rango, generate_series(rango.inicio_actual, rango.fin_actual, interval '1 day') gs
    LEFT JOIN ventas_actual va ON va.dia = gs::date
    GROUP BY gs, rango.inicio_actual
    ORDER BY gs
  ),
  serie_anterior AS (
    SELECT gs::date AS dia, gs::date - rango.inicio_anterior + 1 AS dia_del_mes,
           COALESCE(SUM(van.total), 0) AS total
    FROM rango, generate_series(rango.inicio_anterior, rango.inicio_anterior + rango.dias_transcurridos, interval '1 day') gs
    LEFT JOIN ventas_anterior van ON van.dia = gs::date
    GROUP BY gs, rango.inicio_anterior
    ORDER BY gs
  )
  SELECT jsonb_build_object(
    'mes_actual_label', initcap((SELECT m[EXTRACT(month FROM inicio_actual)::int] FROM rango, meses_es) || ' ' || (SELECT EXTRACT(year FROM inicio_actual)::int FROM rango)),
    'mes_anterior_label', initcap((SELECT m[EXTRACT(month FROM inicio_anterior)::int] FROM rango, meses_es) || ' ' || (SELECT EXTRACT(year FROM inicio_anterior)::int FROM rango)),
    'dias_transcurridos', (SELECT dias_transcurridos + 1 FROM rango),
    'serie_actual', COALESCE((SELECT jsonb_agg(jsonb_build_object('dia_del_mes', dia_del_mes, 'fecha', dia, 'total', total) ORDER BY dia_del_mes) FROM serie_actual), '[]'::jsonb),
    'serie_anterior', COALESCE((SELECT jsonb_agg(jsonb_build_object('dia_del_mes', dia_del_mes, 'fecha', dia, 'total', total) ORDER BY dia_del_mes) FROM serie_anterior), '[]'::jsonb),
    'total_actual', COALESCE((SELECT SUM(total) FROM serie_actual), 0),
    'total_anterior', COALESCE((SELECT SUM(total) FROM serie_anterior), 0),
    'delta_pct', (
      CASE WHEN COALESCE((SELECT SUM(total) FROM serie_anterior), 0) = 0 THEN NULL
      ELSE round((
        (COALESCE((SELECT SUM(total) FROM serie_actual), 0) - (SELECT SUM(total) FROM serie_anterior))
        / (SELECT SUM(total) FROM serie_anterior)
      ) * 100, 1) END
    )
  );
$$;

REVOKE ALL ON FUNCTION public.obtener_comparativa_mensual FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.obtener_comparativa_mensual TO service_role;
