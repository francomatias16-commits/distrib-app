-- ═══════════════════════════════════════════════════════════════════════════
-- 186_metricas_activacion_onboarding.sql
-- Capa de sofisticación comercial — Ítem 1 (nudge de activación) e ítem 2
-- (métricas de conversión) del PLAN_COMERCIALIZACION_DISTRIB.md.
--
-- Reutiliza la infraestructura de 123_saas_billing.sql (saas_email_log +
-- pg_cron + saas-email-sender), no inventa nada nuevo.
--
-- Nota: se usa DROP VIEW ... CASCADE porque get_saas_panel_admin() depende
-- del tipo de fila de la vista — se recrea a continuación.
-- ═══════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS public.saas_panel_admin CASCADE;

-- ---------------------------------------------------------------------------
-- 1. Vista: saas_panel_admin — se amplía con señales de activación real
--    (no solo "pagó o no pagó" sino "usa el sistema de verdad o no").
-- ---------------------------------------------------------------------------
CREATE VIEW public.saas_panel_admin AS
SELECT
  e.id                              AS empresa_id,
  e.nombre,
  e.email,
  e.saas_plan,
  e.saas_trial_fin,
  e.saas_suspendida,
  e.saas_suspendida_at,
  e.saas_precio_mes,
  e.created_at                      AS alta,
  e.setup_completado,
  EXISTS (SELECT 1 FROM public.productos   p WHERE p.empresa_id = e.id LIMIT 1)  AS tiene_productos,
  EXISTS (SELECT 1 FROM public.pedidos     pe WHERE pe.empresa_id = e.id LIMIT 1) AS tiene_pedidos,
  EXISTS (SELECT 1 FROM public.ventas_pos  v  WHERE v.empresa_id = e.id LIMIT 1)  AS tiene_ventas_pos,
  (CURRENT_DATE - e.created_at::DATE)                                            AS dias_desde_alta,
  -- "Activada" = cargó catálogo Y generó al menos un movimiento comercial real
  (
    EXISTS (SELECT 1 FROM public.productos p  WHERE p.empresa_id = e.id LIMIT 1)
    AND (
      EXISTS (SELECT 1 FROM public.pedidos    pe WHERE pe.empresa_id = e.id LIMIT 1)
      OR EXISTS (SELECT 1 FROM public.ventas_pos v  WHERE v.empresa_id = e.id LIMIT 1)
    )
  ) AS activada,
  f.id                              AS ultima_factura_id,
  f.numero                          AS ultima_factura_numero,
  f.periodo                         AS ultima_factura_periodo,
  f.monto                           AS ultima_factura_monto,
  f.estado                          AS ultima_factura_estado,
  f.fecha_emision                   AS ultima_factura_emision,
  f.fecha_vencimiento               AS ultima_factura_vencimiento,
  f.fecha_pago                      AS ultima_factura_pago,
  (f.fecha_vencimiento - CURRENT_DATE) AS dias_para_vencer
FROM public.empresas e
LEFT JOIN LATERAL (
  SELECT *
  FROM public.saas_facturas
  WHERE empresa_id = e.id
  ORDER BY created_at DESC
  LIMIT 1
) f ON true
ORDER BY
  CASE e.saas_plan
    WHEN 'suspendido' THEN 1
    WHEN 'trial'      THEN 2
    WHEN 'activo'     THEN 3
    ELSE 4
  END,
  e.saas_suspendida_at DESC NULLS LAST,
  e.nombre;

COMMENT ON VIEW public.saas_panel_admin IS
  'Panel superadmin: estado de facturación + señales de activación real (v186)';

-- Recrear la función que dependía del tipo de la vista (dropeada por CASCADE)
CREATE OR REPLACE FUNCTION public.get_saas_panel_admin()
RETURNS SETOF public.saas_panel_admin
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_saas_owner() THEN
    RAISE EXCEPTION 'Acceso no autorizado al panel SaaS';
  END IF;
  RETURN QUERY SELECT * FROM public.saas_panel_admin;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. KPIs globales — se agregan "activadas" y "en_riesgo" (trial avanzado
--    sin actividad real: candidatas a churn antes de convertir).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saas_dashboard_kpis()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_activas      INT;
  v_trials       INT;
  v_suspendidas  INT;
  v_mrr          NUMERIC;
  v_morosos      INT;
  v_alta_hoy     INT;
  v_activadas    INT;
  v_en_riesgo    INT;
BEGIN
  IF auth.role() = 'authenticated' AND NOT public.is_saas_owner() THEN
    RAISE EXCEPTION 'Acceso no autorizado al panel SaaS' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_activas      FROM public.empresas WHERE saas_plan = 'activo' AND activa = true;
  SELECT COUNT(*) INTO v_trials       FROM public.empresas WHERE saas_plan = 'trial' AND saas_suspendida = false;
  SELECT COUNT(*) INTO v_suspendidas  FROM public.empresas WHERE saas_suspendida = true;
  SELECT COUNT(*) INTO v_alta_hoy     FROM public.empresas WHERE created_at::DATE = CURRENT_DATE;
  SELECT COALESCE(SUM(saas_precio_mes), 0) INTO v_mrr
    FROM public.empresas WHERE saas_plan = 'activo' AND activa = true;
  SELECT COUNT(DISTINCT empresa_id) INTO v_morosos
    FROM public.saas_facturas
    WHERE estado IN ('pendiente','enviada')
      AND fecha_vencimiento < CURRENT_DATE;

  -- Activadas: entre las que ya usan el sistema (trial o activo), cuántas
  -- tienen catálogo + al menos un movimiento comercial.
  SELECT COUNT(*) INTO v_activadas
    FROM public.saas_panel_admin
    WHERE saas_plan IN ('trial', 'activo') AND activada = true;

  -- En riesgo: van más de la mitad del trial y todavía no activaron.
  SELECT COUNT(*) INTO v_en_riesgo
    FROM public.saas_panel_admin
    WHERE saas_plan = 'trial'
      AND saas_suspendida = false
      AND activada = false
      AND dias_desde_alta >= 3;

  RETURN jsonb_build_object(
    'activas',     v_activas,
    'trials',      v_trials,
    'suspendidas', v_suspendidas,
    'mrr',         v_mrr,
    'morosos',     v_morosos,
    'alta_hoy',    v_alta_hoy,
    'activadas',   v_activadas,
    'en_riesgo',   v_en_riesgo
  );
END;
$$;

-- Recrear también saas_panel_listar (dependía indirectamente de la vista)
CREATE OR REPLACE FUNCTION public.saas_panel_listar()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF auth.role() = 'authenticated' AND NOT public.is_saas_owner() THEN
    RAISE EXCEPTION 'Acceso no autorizado al panel SaaS' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_agg(row_to_json(p)) INTO v_result
  FROM public.saas_panel_admin p;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. CRON: nudge de activación (ítem 1 del plan comercial).
--    Corre diariamente. Empresas en trial con 3 días de antigüedad que
--    todavía no activaron (sin catálogo o sin ningún movimiento) reciben
--    UN solo email de onboarding — se evita duplicar chequeando el log.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saas_cron_activacion_check()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT empresa_id, email, nombre, tiene_productos, tiene_pedidos, tiene_ventas_pos
    FROM public.saas_panel_admin
    WHERE saas_plan = 'trial'
      AND saas_suspendida = false
      AND activada = false
      AND dias_desde_alta = 3   -- un solo disparo, al día 3 exacto de antigüedad
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.saas_email_log
      WHERE empresa_id = rec.empresa_id AND tipo = 'onboarding_nudge'
    ) THEN
      INSERT INTO public.saas_email_log (empresa_id, tipo, destinatario)
      VALUES (rec.empresa_id, 'onboarding_nudge', rec.email);
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.saas_cron_activacion_check IS
  'Detecta trials sin actividad real a los 3 días y dispara un único email de onboarding (v186)';

-- Job diario, mismo horario que el resto de los cron SaaS (11:30 UTC ≈ 08:30 ART)
SELECT cron.unschedule('saas_activacion_check_diario')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'saas_activacion_check_diario');

SELECT cron.schedule(
  'saas_activacion_check_diario',
  '30 11 * * *',
  $$SELECT public.saas_cron_activacion_check()$$
);
