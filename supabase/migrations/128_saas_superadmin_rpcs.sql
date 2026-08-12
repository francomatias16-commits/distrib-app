-- ═══════════════════════════════════════════════════════════════════════════
-- 128_saas_superadmin_rpcs.sql
-- RPCs para el panel superadmin de SaaS: listar empresas, confirmar pago,
-- reactivar empresa, cambiar precio, configurar CBU global.
-- También: fix search_path en funciones saas de 123.
-- Idempotente: OR REPLACE en todo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Fix search_path en funciones SECURITY DEFINER de 123 ─────────────────
ALTER FUNCTION public.saas_crear_factura(UUID, TEXT)
  SET search_path = 'public';

ALTER FUNCTION public.saas_confirmar_pago(UUID, UUID)
  SET search_path = 'public';

ALTER FUNCTION public.saas_suspender_empresa(UUID)
  SET search_path = 'public';

ALTER FUNCTION public.saas_cron_trial_check()
  SET search_path = 'public';

ALTER FUNCTION public.saas_cron_facturacion_mensual()
  SET search_path = 'public';

ALTER FUNCTION public.saas_cron_suspender_morosos()
  SET search_path = 'public';

-- ── Fix search_path en registrar_empresa_saas (127) ──────────────────────
DO $$ BEGIN
  ALTER FUNCTION public.registrar_empresa_saas(TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,TEXT)
    SET search_path = 'public';
EXCEPTION WHEN undefined_function THEN NULL; END $$;

-- ── RPC: saas_panel_listar() ─────────────────────────────────────────────
-- Retorna todas las empresas con estado SaaS para el panel superadmin.
-- Solo callable con service_role (sin política RLS que lo bloquee).
CREATE OR REPLACE FUNCTION public.saas_panel_listar()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_agg(row_to_json(p)) INTO v_result
  FROM public.saas_panel_admin p;

  RETURN COALESCE(v_result, '[]'::JSONB);
END;
$$;

-- ── RPC: saas_config_actualizar(cbu, alias, titular, banco, precio, dias_trial) ──
CREATE OR REPLACE FUNCTION public.saas_config_actualizar(
  p_cbu           TEXT    DEFAULT NULL,
  p_alias         TEXT    DEFAULT NULL,
  p_titular       TEXT    DEFAULT NULL,
  p_banco         TEXT    DEFAULT NULL,
  p_precio        NUMERIC DEFAULT NULL,
  p_dias_trial    INT     DEFAULT NULL,
  p_email_admin   TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.saas_config SET
    cbu           = COALESCE(p_cbu,         cbu),
    alias         = COALESCE(p_alias,       alias),
    titular       = COALESCE(p_titular,     titular),
    banco         = COALESCE(p_banco,       banco),
    precio_mensual = COALESCE(p_precio,     precio_mensual),
    dias_trial    = COALESCE(p_dias_trial,  dias_trial),
    email_admin   = COALESCE(p_email_admin, email_admin),
    updated_at    = now()
  WHERE id = 1;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── RPC: saas_empresa_cambiar_precio(empresa_id, nuevo_precio) ────────────
CREATE OR REPLACE FUNCTION public.saas_empresa_cambiar_precio(
  p_empresa_id UUID,
  p_precio     NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF p_precio < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El precio no puede ser negativo');
  END IF;

  UPDATE public.empresas
  SET saas_precio_mes = p_precio
  WHERE id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Empresa no encontrada');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── RPC: saas_empresa_reactivar(empresa_id) ───────────────────────────────
-- Reactiva una empresa suspendida sin cobro (gracia manual del admin).
CREATE OR REPLACE FUNCTION public.saas_empresa_reactivar(
  p_empresa_id UUID,
  p_dias_extra INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.empresas SET
    saas_plan         = 'trial',
    saas_trial_fin    = (CURRENT_DATE + p_dias_extra)::DATE,
    saas_suspendida   = false,
    saas_suspendida_at = NULL,
    activa            = true
  WHERE id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Empresa no encontrada');
  END IF;

  RETURN jsonb_build_object(
    'ok',       true,
    'nuevo_fin', (CURRENT_DATE + p_dias_extra)::TEXT
  );
END;
$$;

-- ── RPC: saas_empresa_cancelar(empresa_id) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.saas_empresa_cancelar(p_empresa_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.empresas SET
    saas_plan         = 'cancelado',
    saas_suspendida   = true,
    saas_suspendida_at = now(),
    activa            = false
  WHERE id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Empresa no encontrada');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── RPC: saas_dashboard_kpis() ────────────────────────────────────────────
-- KPIs del dashboard superadmin: MRR, cuentas activas, trials, morosos.
CREATE OR REPLACE FUNCTION public.saas_dashboard_kpis()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_activas      INT;
  v_trials       INT;
  v_suspendidas  INT;
  v_mrr          NUMERIC;
  v_morosos      INT;
  v_alta_hoy     INT;
BEGIN
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

  RETURN jsonb_build_object(
    'activas',     v_activas,
    'trials',      v_trials,
    'suspendidas', v_suspendidas,
    'mrr',         v_mrr,
    'morosos',     v_morosos,
    'alta_hoy',    v_alta_hoy
  );
END;
$$;

-- ── Política RLS: solo service_role puede llamar las RPCs SECURITY DEFINER ──
-- (Las RPCs con SECURITY DEFINER ya bypasean RLS internamente — OK)

-- ── Comentarios ──────────────────────────────────────────────────────────
COMMENT ON FUNCTION public.saas_panel_listar        IS 'Superadmin: lista todas las empresas con estado SaaS';
COMMENT ON FUNCTION public.saas_config_actualizar   IS 'Superadmin: actualiza CBU, precio global y configuración';
COMMENT ON FUNCTION public.saas_empresa_reactivar   IS 'Superadmin: reactiva empresa suspendida con N días extra';
COMMENT ON FUNCTION public.saas_empresa_cancelar    IS 'Superadmin: cancela cuenta permanentemente';
COMMENT ON FUNCTION public.saas_empresa_cambiar_precio IS 'Superadmin: precio individual por empresa';
COMMENT ON FUNCTION public.saas_dashboard_kpis      IS 'Superadmin: KPIs del dashboard SaaS (MRR, activas, trials, morosos)';
