-- =============================================================================
-- 201_ajustar_stock_atomico_sin_clamp.sql
--
-- La versión en producción (aplicada fuera del repo de migraciones locales,
-- ya incluye sync de lotes/FEFO que el zip local no tenía registrado) sigue
-- teniendo el problema original:
--
--   INSERT ... VALUES (..., GREATEST(0, p_delta))
--   ON CONFLICT ... DO UPDATE SET cantidad = GREATEST(0, stock.cantidad + p_delta)
--
-- Si un egreso pedido es mayor al stock disponible, la función NO rechaza la
-- operación: clampea a 0 y devuelve ok:true. Como la validación de
-- "cantidad > stock" vive solo en el cliente (stock.js), es bypasseable desde
-- devtools. Además, el registro en movimientos_stock lo hacía el cliente por
-- un INSERT directo separado, con la cantidad "pedida" (no la realmente
-- aplicada), y esa tabla solo tiene RLS de aislamiento por empresa — no valida
-- coherencia con ningún ajuste real. Eso permite historial desincronizado del
-- stock real, o directamente movimientos "fantasma" insertados sin pasar por
-- la RPC.
--
-- Fix, preservando intacta la lógica de lotes/FEFO ya existente:
--   1) Lockea la fila de stock (FOR UPDATE) y calcula el resultado ANTES de
--      escribir nada.
--   2) Si el resultado sería negativo, devuelve ok:false y no toca stock,
--      lotes, ni movimientos_stock (en vez de clampear a 0 silenciosamente).
--   3) Inserta ella misma el registro en movimientos_stock (con tipo/motivo/
--      notas reales pasados por parámetro), transaccional junto con el
--      update de stock y el sync de lotes. El cliente deja de insertar
--      directo a esa tabla.
-- =============================================================================

-- La firma anterior (uuid, uuid, numeric, text) queda reemplazada por una con
-- tipos distintos en el 4to parámetro (tipo_movimiento en vez de text). Postgres
-- crearía una función sobrecargada en paralelo si no se dropea la vieja.
DROP FUNCTION IF EXISTS public.ajustar_stock(uuid, uuid, numeric, text);

CREATE OR REPLACE FUNCTION public.ajustar_stock(
  p_producto_id uuid,
  p_deposito_id uuid,
  p_delta       numeric,
  p_tipo        tipo_movimiento DEFAULT NULL,
  p_motivo      text DEFAULT 'ajuste_manual',
  p_notas       text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_empresa_id   UUID;
  v_stock_actual NUMERIC;
  v_stock_nuevo  NUMERIC;
  v_tipo         tipo_movimiento;
BEGIN
  SELECT empresa_id INTO v_empresa_id
    FROM public.depositos
   WHERE id = p_deposito_id;

  IF v_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  v_tipo := COALESCE(p_tipo, CASE WHEN p_delta >= 0 THEN 'ingreso' ELSE 'egreso' END::tipo_movimiento);

  -- Asegurar que exista la fila de stock, para poder lockearla
  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  SELECT cantidad INTO v_stock_actual
    FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id
   FOR UPDATE;

  v_stock_nuevo := COALESCE(v_stock_actual, 0) + p_delta;

  IF v_stock_nuevo < 0 THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'Stock insuficiente: la operación dejaría el stock en negativo',
      'stock_disponible', COALESCE(v_stock_actual, 0)
    );
  END IF;

  UPDATE public.stock
     SET cantidad = v_stock_nuevo, updated_at = NOW()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;

  -- ── Sync de lotes según dirección del ajuste (sin cambios de lógica) ──────
  IF p_delta > 0 THEN
    INSERT INTO lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_id,
      'AJUSTE-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      p_delta, p_delta,
      'activo'
    );
  ELSIF p_delta < 0 THEN
    PERFORM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, ABS(p_delta), p_motivo, auth.uid());
  END IF;
  -- ───────────────────────────────────────────────────────────────────────

  -- Registrar el movimiento con el delta REALMENTE aplicado (antes lo hacía
  -- el cliente con un insert directo y separado, ver stock.js)
  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES
    (p_producto_id, p_deposito_id, v_tipo, ABS(p_delta), p_motivo, auth.uid(), p_notas);

  RETURN json_build_object(
    'ok',          true,
    'stock_nuevo', v_stock_nuevo,
    'delta',       p_delta
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ajustar_stock(uuid, uuid, numeric, tipo_movimiento, text, text) TO authenticated;

COMMENT ON FUNCTION public.ajustar_stock IS
  'Ajuste atómico de stock. Lockea la fila (FOR UPDATE), rechaza (ok:false) si el '
  'resultado sería negativo en vez de clampear, sincroniza lotes/FEFO y registra '
  'ella misma el movimiento en movimientos_stock con tipo/motivo/notas reales. '
  'El cliente (stock.js) ya no debe insertar directo en movimientos_stock.';
