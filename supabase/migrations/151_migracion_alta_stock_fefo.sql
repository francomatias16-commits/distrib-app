-- migracion_alta_stock: integra la importación masiva de stock con el sistema de lotes/FEFO.
-- Reemplaza el upsert directo a `stock` que hacía el wizard de migración (lib/handlers/migracion.js).
-- Calcula el delta contra el stock actual, mueve `stock` al valor importado, y según el signo
-- del delta crea un lote nuevo ("alta por migración") o consume FEFO, además de dejar
-- un movimiento auditado en movimientos_stock.
CREATE OR REPLACE FUNCTION public.migracion_alta_stock(
  p_producto_id  UUID,
  p_deposito_id  UUID,
  p_empresa_id   UUID,
  p_cantidad     NUMERIC,
  p_sesion_id    UUID,
  p_usuario_id   UUID DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stock_actual NUMERIC;
  v_delta        NUMERIC;
  v_numero_lote  TEXT;
  v_referencia   TEXT;
BEGIN
  IF p_cantidad IS NULL OR p_cantidad < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cantidad inválida');
  END IF;

  v_referencia := 'MIGRACION:' || p_sesion_id;

  SELECT cantidad INTO v_stock_actual
    FROM stock
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id
     FOR UPDATE;

  IF NOT FOUND THEN
    v_stock_actual := 0;
  END IF;

  v_delta := p_cantidad - v_stock_actual;

  INSERT INTO stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, p_cantidad)
  ON CONFLICT (producto_id, deposito_id)
  DO UPDATE SET cantidad = p_cantidad, updated_at = now();

  IF v_delta > 0 THEN
    v_numero_lote := 'MIGRACION-' || LEFT(p_sesion_id::TEXT, 8) || '-' || TO_CHAR(now(), 'YYYYMMDD');

    INSERT INTO lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      estado
    ) VALUES (
      p_empresa_id, p_producto_id, p_deposito_id,
      v_numero_lote, v_delta, v_delta,
      'activo'
    );

    INSERT INTO movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, created_at)
    VALUES
      (p_producto_id, p_deposito_id, 'ingreso', v_delta, v_referencia, p_usuario_id, now());

  ELSIF v_delta < 0 THEN
    PERFORM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, ABS(v_delta), v_referencia, p_usuario_id);

    INSERT INTO movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, created_at)
    VALUES
      (p_producto_id, p_deposito_id, 'ajuste', v_delta, v_referencia, p_usuario_id, now());
  END IF;
  -- v_delta = 0: stock importado igual al existente, no se toca lotes/movimientos.

  RETURN jsonb_build_object('ok', true, 'stock_nuevo', p_cantidad, 'delta', v_delta);
END;
$function$;
