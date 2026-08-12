-- ============================================================================
-- 243_etapa5_dashboard_ejecutivo_comparativa_mensual.sql
--
-- Etapa 5 del plan (BI/Reportes) — 2 piezas:
--
-- 1) obtener_dashboard_ejecutivo_resumen(): agrega en una sola llamada lo que
--    hoy vive repartido en 3 pantallas separadas (cobranzas.html usa
--    v_cobranza_priorizada, rentabilidad-zona.html usa v_rentabilidad_zona_ruta,
--    stock.html/reportes-stock.html usan fn_reportes_stock_kpis). No reemplaza
--    esas vistas ni pantallas — les agrega un resumen ejecutivo pensado para
--    el Panel principal (dashboard.html), reutilizando las mismas vistas ya
--    versionadas para no duplicar lógica de negocio (score de cobrabilidad,
--    margen neto por km, etc.).
--
-- 2) obtener_comparativa_mensual(): serie diaria del mes en curso vs. el mismo
--    tramo del mes anterior (día 1 a día N, donde N = día actual). Se eligió
--    mensual (no interanual) a propósito: los datos de este tenant arrancan
--    en 2026-02, así que una comparativa año-contra-año no tendría con qué
--    compararse todavía. Queda con la misma firma pensada para poder sumar
--    'interanual' como tercer modo el día que haya >12 meses de historia,
--    sin romper esta función.
-- ============================================================================

-- ── Parte 1: resumen ejecutivo (cobranza + rentabilidad + stock) ───────────
CREATE OR REPLACE FUNCTION public.obtener_dashboard_ejecutivo_resumen(
  p_empresa_id UUID,
  p_desde      TIMESTAMPTZ,
  p_hasta      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(

    -- ── Cobranza: reutiliza v_cobranza_priorizada (Etapa 3) ───────────────
    'cobranza', (
      SELECT jsonb_build_object(
        'total_pendiente', COALESCE(SUM(saldo_pendiente), 0),
        'monto_accion_urgente', COALESCE(SUM(saldo_pendiente) FILTER (WHERE prioridad = 'accion_urgente'), 0),
        'monto_seguimiento', COALESCE(SUM(saldo_pendiente) FILTER (WHERE prioridad = 'seguimiento'), 0),
        'monto_cobro_probable', COALESCE(SUM(saldo_pendiente) FILTER (WHERE prioridad = 'cobro_probable'), 0),
        'facturas_urgentes_count', COUNT(*) FILTER (WHERE prioridad = 'accion_urgente'),
        'top_urgentes', COALESCE((
          SELECT jsonb_agg(t) FROM (
            SELECT cliente_nombre, numero_factura, saldo_pendiente, dias_vencida
            FROM v_cobranza_priorizada
            WHERE empresa_id = p_empresa_id AND prioridad = 'accion_urgente'
            ORDER BY saldo_pendiente DESC
            LIMIT 5
          ) t
        ), '[]'::jsonb)
      )
      FROM v_cobranza_priorizada
      WHERE empresa_id = p_empresa_id
    ),

    -- ── Rentabilidad: reutiliza v_rentabilidad_zona_ruta (Etapa 1), ───────
    -- acotada al período del panel por fecha de ruta.
    'rentabilidad', (
      WITH base AS (
        SELECT * FROM v_rentabilidad_zona_ruta
        WHERE empresa_id = p_empresa_id
          AND ruta_fecha >= p_desde::date AND ruta_fecha <= p_hasta::date
      ), por_zona AS (
        SELECT
          COALESCE(zona_nombre, 'Sin zona') AS zona_nombre,
          SUM(margen_neto_estimado) AS margen_neto_zona,
          SUM(facturado_total) AS facturado_zona
        FROM base
        GROUP BY COALESCE(zona_nombre, 'Sin zona')
      )
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

    -- ── Stock crítico: mismo criterio que obtener_kpis_dashboard_v3, ──────
    -- con detalle de los 5 más urgentes para la tabla del panel.
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


-- ── Parte 2: comparativa mensual (mes en curso vs. mismo tramo del anterior) ──
CREATE OR REPLACE FUNCTION public.obtener_comparativa_mensual(
  p_empresa_id UUID,
  p_fecha_ref  DATE DEFAULT CURRENT_DATE
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH meses_es AS (
    -- to_char(..., 'TMMonth') depende del locale del servidor de Postgres
    -- (corre en locale 'C' por defecto → devolvería "July 2026" en vez de
    -- "Julio 2026"). Se arma el nombre a mano para no depender de locales
    -- instalados en el servidor.
    SELECT ARRAY['enero','febrero','marzo','abril','mayo','junio','julio',
                 'agosto','septiembre','octubre','noviembre','diciembre'] AS m
  ),
  rango AS (
    SELECT
      date_trunc('month', p_fecha_ref)::date AS inicio_actual,
      p_fecha_ref AS fin_actual,
      (p_fecha_ref - date_trunc('month', p_fecha_ref)::date) AS dias_transcurridos, -- 0-based
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
