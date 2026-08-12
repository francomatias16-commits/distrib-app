-- Etapa 14, Hallazgo 2 (hallazgo colateral): chequear_limite_plan('usuarios')
-- contaba TODOS los usuarios activos de la empresa, incluidos los de rol
-- 'cliente' -- filas que se auto-crean en la tabla `usuarios` cada vez que
-- se otorga "acceso portal" a un cliente (lib/handlers/clientes.js,
-- crearAccesoPortal -> upsert en `usuarios` con rol:'cliente'). El cupo
-- max_usuarios del plan está pensado para el equipo interno (dueño, admin,
-- vendedor, depositero, chofer, contador), no para clientes del portal.
-- Confirmado en producción: una empresa ya tenía 10 usuarios de equipo +
-- 5 clientes de portal = 15 contra un límite que en trial/básico es de
-- 3/5 -- el enforcement ya estaba roto para cualquier empresa real con
-- acceso portal activo.
CREATE OR REPLACE FUNCTION public.chequear_limite_plan(p_empresa_id UUID, p_recurso TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier    public.plan_tier;
  v_limite  INT;
  v_actual  INT;
BEGIN
  SELECT CASE WHEN saas_plan = 'trial' THEN 'trial'::public.plan_tier ELSE plan_tier END
  INTO v_tier
  FROM public.empresas WHERE id = p_empresa_id;

  IF v_tier IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EMPRESA_NO_ENCONTRADA');
  END IF;

  IF p_recurso = 'usuarios' THEN
    SELECT max_usuarios INTO v_limite FROM public.planes_limites WHERE tier = v_tier;
    SELECT COUNT(*) INTO v_actual FROM public.usuarios
      WHERE empresa_id = p_empresa_id AND activo = true AND rol <> 'cliente';
  ELSIF p_recurso = 'clientes' THEN
    SELECT max_clientes INTO v_limite FROM public.planes_limites WHERE tier = v_tier;
    SELECT COUNT(*) INTO v_actual FROM public.clientes WHERE empresa_id = p_empresa_id AND activo = true;
  ELSIF p_recurso = 'pedidos_mes' THEN
    SELECT max_pedidos_mes INTO v_limite FROM public.planes_limites WHERE tier = v_tier;
    SELECT COUNT(*) INTO v_actual FROM public.pedidos
      WHERE empresa_id = p_empresa_id
        AND fecha_pedido >= date_trunc('month', now());
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'RECURSO_DESCONOCIDO');
  END IF;

  RETURN jsonb_build_object(
    'ok',          true,
    'tier',        v_tier,
    'recurso',     p_recurso,
    'actual',      v_actual,
    'limite',      v_limite,
    'alcanzado',   v_limite IS NOT NULL AND v_actual >= v_limite
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.chequear_limite_plan(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chequear_limite_plan(uuid, text) TO service_role;
