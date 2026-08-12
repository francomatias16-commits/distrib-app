-- ═══════════════════════════════════════════════════════════════════════════
-- 187_saas_tenant_cambiar_plan.sql
-- Plan de comercialización, ítem 3: self-serve upgrade/downgrade de plan.
--
-- El tenant (dueño/admin) puede cambiar su plan_tier sin intervención
-- humana, siempre que la cuenta esté activa y al día. Enterprise queda
-- afuera del self-serve (precio a medida, requiere contacto comercial).
-- El billing sigue siendo transferencia manual (saas_facturas / cron
-- existente): este RPC solo actualiza plan_tier + saas_precio_mes, que es
-- lo que toma el generador de facturas para el próximo período.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.saas_tenant_cambiar_plan(p_tier public.plan_tier)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_empresa_id   UUID := public.get_empresa_id();
  v_rol          TEXT;
  v_tier_actual  public.plan_tier;
  v_saas_plan    TEXT;
  v_suspendida   BOOLEAN;
  v_orden        CONSTANT JSONB := '{"basico":1,"pro":2}'::jsonb;
  v_es_downgrade BOOLEAN;
  v_limite       public.planes_limites%ROWTYPE;
  v_usuarios     INT;
  v_clientes     INT;
BEGIN
  IF v_empresa_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SIN_EMPRESA');
  END IF;

  IF p_tier NOT IN ('basico', 'pro') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TIER_INVALIDO',
      'mensaje', 'El plan Enterprise no está disponible en autogestión — escribinos para cotizarlo.');
  END IF;

  SELECT rol INTO v_rol FROM public.usuarios WHERE id = auth.uid();
  IF v_rol IS DISTINCT FROM 'dueno' AND v_rol IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SIN_PERMISOS',
      'mensaje', 'Solo el dueño o un administrador puede cambiar el plan.');
  END IF;

  SELECT plan_tier, saas_plan, saas_suspendida
    INTO v_tier_actual, v_saas_plan, v_suspendida
  FROM public.empresas WHERE id = v_empresa_id;

  IF v_saas_plan IS DISTINCT FROM 'activo' OR v_suspendida THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CUENTA_NO_ACTIVA',
      'mensaje', 'Solo se puede cambiar de plan con la cuenta activa y al día.');
  END IF;

  IF p_tier = v_tier_actual THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISMO_PLAN',
      'mensaje', 'Ya estás en ese plan.');
  END IF;

  v_es_downgrade := (v_orden->>p_tier::text)::int < (v_orden->>v_tier_actual::text)::int;

  SELECT * INTO v_limite FROM public.planes_limites WHERE tier = p_tier;

  IF v_es_downgrade THEN
    SELECT COUNT(*) INTO v_usuarios FROM public.usuarios WHERE empresa_id = v_empresa_id AND activo = true;
    SELECT COUNT(*) INTO v_clientes FROM public.clientes WHERE empresa_id = v_empresa_id AND activo = true;

    IF v_limite.max_usuarios IS NOT NULL AND v_usuarios > v_limite.max_usuarios THEN
      RETURN jsonb_build_object('ok', false, 'error', 'EXCEDE_LIMITE_USUARIOS',
        'mensaje', format('Tenés %s usuarios activos y el plan %s permite %s. Desactivá usuarios antes de bajar de plan.',
          v_usuarios, v_limite.nombre_visible, v_limite.max_usuarios));
    END IF;

    IF v_limite.max_clientes IS NOT NULL AND v_clientes > v_limite.max_clientes THEN
      RETURN jsonb_build_object('ok', false, 'error', 'EXCEDE_LIMITE_CLIENTES',
        'mensaje', format('Tenés %s clientes activos y el plan %s permite %s. No podés bajar de plan hasta reducir esa cantidad.',
          v_clientes, v_limite.nombre_visible, v_limite.max_clientes));
    END IF;
  END IF;

  UPDATE public.empresas
  SET plan_tier       = p_tier,
      saas_precio_mes = v_limite.precio_mes
  WHERE id = v_empresa_id;

  RETURN jsonb_build_object(
    'ok',            true,
    'tier_anterior', v_tier_actual,
    'tier_nuevo',    p_tier,
    'precio_nuevo',  v_limite.precio_mes,
    'downgrade',     v_es_downgrade,
    'mensaje',       format('Listo, tu plan es %s ahora. El nuevo precio ($ %s/mes) se aplica desde tu próxima factura.',
                        v_limite.nombre_visible, v_limite.precio_mes)
  );
END;
$$;

COMMENT ON FUNCTION public.saas_tenant_cambiar_plan(public.plan_tier) IS
  'Self-serve upgrade/downgrade de plan_tier para el propio tenant (plan comercial, ítem 3, v187). Enterprise excluido (requiere contacto).';

REVOKE ALL ON FUNCTION public.saas_tenant_cambiar_plan(public.plan_tier) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.saas_tenant_cambiar_plan(public.plan_tier) TO authenticated;
