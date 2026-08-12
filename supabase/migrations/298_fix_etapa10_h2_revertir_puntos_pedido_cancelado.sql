-- 298_fix_etapa10_h2_revertir_puntos_pedido_cancelado.sql
--
-- Auditoría de módulos, Etapa 10 (Fidelización) — Hallazgo 2.
-- Ya aplicada directo en producción (jgiquzjwoedmzwqgzubr) vía Supabase
-- MCP. Este archivo la deja versionada en el repo.
--
-- Cancelar un pedido (DELETE /api/pedidos?id=, lib/handlers/pedidos.js)
-- revierte stock reservado y anula/emite NC de la factura, pero nunca
-- tocaba los puntos de fidelización ya acreditados por ese pedido --
-- contradice la ayuda al usuario (fidelizacion-puntos-y-recompensas.md,
-- FAQ "¿Se pueden perder puntos ya ganados? Sí, por ejemplo si se anula
-- el pedido que los generó"), que promete una reversión que el código
-- nunca implementó.
--
-- Se llama desde el handler de cancelación en pedidos.js con la
-- service_role key (igual que canjear_recompensa). Si el cliente ya
-- gastó parte de esos puntos en un canje mientras tanto, se revierte
-- solo lo que quede disponible (no se puede descontar por debajo de 0).
CREATE OR REPLACE FUNCTION public.revertir_puntos_pedido_cancelado(
  p_pedido_id  uuid,
  p_empresa_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cliente_id     uuid;
  v_cantidad_orig  NUMERIC;
  v_saldo_actual   NUMERIC;
  v_a_revertir     NUMERIC;
  v_movimiento_id  uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  -- Idempotencia: si este pedido ya se revirtió, no duplicar (por si el
  -- handler se llama más de una vez o el pedido pasa por cancelación en
  -- dos requests).
  IF EXISTS (
    SELECT 1 FROM public.movimientos_puntos
     WHERE referencia_id = p_pedido_id
       AND empresa_id    = p_empresa_id
       AND tipo = 'ajuste'
  ) THEN
    RETURN json_build_object('ok', true, 'revertido', 0, 'motivo', 'ya_revertido');
  END IF;

  SELECT cliente_id, cantidad INTO v_cliente_id, v_cantidad_orig
    FROM public.movimientos_puntos
   WHERE referencia_id = p_pedido_id
     AND empresa_id    = p_empresa_id
     AND tipo = 'ganancia'
   LIMIT 1;

  IF NOT FOUND OR v_cantidad_orig IS NULL OR v_cantidad_orig <= 0 THEN
    RETURN json_build_object('ok', true, 'revertido', 0, 'motivo', 'sin_puntos_que_revertir');
  END IF;

  SELECT COALESCE(puntos_disponibles, 0) INTO v_saldo_actual
    FROM public.saldo_puntos
   WHERE cliente_id = v_cliente_id AND empresa_id = p_empresa_id
   FOR UPDATE;

  -- No se puede descontar más de lo que hay disponible -- puede que el
  -- cliente ya haya canjeado parte de esos puntos.
  v_a_revertir := LEAST(v_cantidad_orig, COALESCE(v_saldo_actual, 0));

  UPDATE public.saldo_puntos
     SET puntos_disponibles = GREATEST(COALESCE(puntos_disponibles, 0) - v_a_revertir, 0),
         puntos_totales     = COALESCE(puntos_totales, 0) - v_cantidad_orig,
         ultimo_movimiento  = now()
   WHERE cliente_id = v_cliente_id AND empresa_id = p_empresa_id;

  INSERT INTO public.movimientos_puntos
         (cliente_id, empresa_id, tipo, cantidad, motivo, referencia_id)
  VALUES (v_cliente_id, p_empresa_id, 'ajuste', -v_cantidad_orig,
          'Reversión por cancelación de pedido', p_pedido_id)
  RETURNING id INTO v_movimiento_id;

  RETURN json_build_object(
    'ok', true,
    'revertido', v_a_revertir,
    'ganancia_original', v_cantidad_orig,
    'movimiento_id', v_movimiento_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.revertir_puntos_pedido_cancelado(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revertir_puntos_pedido_cancelado(uuid, uuid) TO service_role;
