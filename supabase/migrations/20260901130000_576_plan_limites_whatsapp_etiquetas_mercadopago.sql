-- Etapa 8 (plan de comercialización) — auditoría "trial vs. recursos con
-- costo real": el enforcement de plan (migración 137/138/293) solo cubría
-- usuarios/clientes/pedidos_mes. Tres recursos con costo real (o con valor
-- de venta directo) no tenían NINGÚN tope en trial:
--   - Envío de WhatsApp saliente (templates + texto libre): costo real por
--     Meta, sin relación con el corte de demo (esEmpresaDemo, que protege
--     la cuenta demo pública, no el plan contratado).
--   - Generación de etiquetas con código de barras: sin costo externo,
--     pero es una feature de venta (plan pago) que trial usaba sin límite.
--   - MercadoPago: sin ningún corte por plan — ver también
--     tests/handlers/pagos-tope-plan.test.js.
--
-- Política decidida: trial = 10 mensajes de WhatsApp salientes (total
-- histórico, no mensual — mismo criterio simple que max_clientes),
-- 1 generación de etiquetas, MercadoPago bloqueado por completo.

ALTER TABLE public.planes_limites
  ADD COLUMN IF NOT EXISTS max_whatsapp_mensajes    INT,     -- NULL = ilimitado
  ADD COLUMN IF NOT EXISTS max_etiquetas_generaciones INT,   -- NULL = ilimitado
  ADD COLUMN IF NOT EXISTS permite_mercadopago       BOOLEAN NOT NULL DEFAULT true;

UPDATE public.planes_limites SET
  max_whatsapp_mensajes      = 10,
  max_etiquetas_generaciones = 1,
  permite_mercadopago        = false
WHERE tier = 'trial';

COMMENT ON COLUMN public.planes_limites.max_whatsapp_mensajes IS
  'Tope histórico (no mensual) de mensajes de WhatsApp salientes (direccion=out) contados vía join con whatsapp_conversaciones. NULL = ilimitado.';
COMMENT ON COLUMN public.planes_limites.max_etiquetas_generaciones IS
  'Tope histórico de generaciones registradas en etiquetas_generaciones. NULL = ilimitado.';
COMMENT ON COLUMN public.planes_limites.permite_mercadopago IS
  'Si es false, chequear_limite_plan(''mercadopago'') siempre reporta alcanzado=true (no hay noción de "cuota", es todo o nada).';

-- Historial de generaciones de etiquetas — no existía ninguna tabla que
-- registrara esto (lib/handlers/etiquetas.js solo generaba el PDF/preview
-- al vuelo, sin persistir nada).
CREATE TABLE IF NOT EXISTS public.etiquetas_generaciones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  usuario_id   uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  cantidad_productos INT,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_etiquetas_generaciones_empresa
  ON public.etiquetas_generaciones(empresa_id, created_at);

ALTER TABLE public.etiquetas_generaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.etiquetas_generaciones FROM anon, authenticated;
GRANT ALL ON public.etiquetas_generaciones TO service_role;

-- Extiende chequear_limite_plan con los 3 recursos nuevos (mismo patrón que
-- la versión anterior en 293_fix_chequear_limite_plan_excluir_rol_cliente_de_usuarios.sql).
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
  ELSIF p_recurso = 'whatsapp_mensajes' THEN
    SELECT max_whatsapp_mensajes INTO v_limite FROM public.planes_limites WHERE tier = v_tier;
    SELECT COUNT(*) INTO v_actual
      FROM public.whatsapp_mensajes m
      JOIN public.whatsapp_conversaciones c ON c.id = m.conversacion_id
      WHERE c.empresa_id = p_empresa_id AND m.direccion = 'out';
  ELSIF p_recurso = 'etiquetas_generaciones' THEN
    SELECT max_etiquetas_generaciones INTO v_limite FROM public.planes_limites WHERE tier = v_tier;
    SELECT COUNT(*) INTO v_actual FROM public.etiquetas_generaciones WHERE empresa_id = p_empresa_id;
  ELSIF p_recurso = 'mercadopago' THEN
    -- No es un tope numérico sino todo-o-nada: limite=0 (bloqueado) o
    -- NULL (permitido). v_actual queda fijo en 1 para que la aritmética
    -- de "alcanzado" (v_actual >= v_limite) sea la misma que el resto de
    -- los recursos, sin agregar una rama especial más abajo.
    SELECT CASE WHEN permite_mercadopago THEN NULL ELSE 0 END INTO v_limite
      FROM public.planes_limites WHERE tier = v_tier;
    v_actual := 1;
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
