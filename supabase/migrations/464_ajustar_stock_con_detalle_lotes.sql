-- ═══════════════════════════════════════════════════════════════════════════
-- 464_ajustar_stock_con_detalle_lotes.sql [reconstruida, ver 462]
--
-- ajustar_stock() (443) deja rastro en movimientos_stock_lotes:
--   - Alta (p_delta > 0): crea el lote "AJUSTE-<fecha>" (igual que antes) y
--     lo linkea al movimiento con direccion='alta'.
--   - Baja (p_delta < 0): inserta un registro en movimientos_stock_lotes por
--     cada lote consumido, usando el detalle que ahora devuelve
--     fn_lotes_consumir_fefo (463).
-- Resto de la lógica (lock, rechazo si negativo, idempotencia offline)
-- idéntica a 443.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.ajustar_stock(
  p_producto_id       UUID,
  p_deposito_id       UUID,
  p_delta             NUMERIC,
  p_tipo              tipo_movimiento DEFAULT NULL,
  p_motivo            TEXT DEFAULT 'ajuste_manual',
  p_notas             TEXT DEFAULT NULL,
  p_usuario_id        UUID DEFAULT NULL,
  p_offline_local_id  TEXT DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_empresa_id   UUID;
  v_stock_actual NUMERIC;
  v_stock_nuevo  NUMERIC;
  v_tipo         tipo_movimiento;
  v_existente_id UUID;
  v_mov_id       UUID;
  v_lote_id      UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.movimientos_stock
     WHERE offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      SELECT cantidad INTO v_stock_nuevo
        FROM public.stock
       WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;
      RETURN json_build_object('ok', true, 'stock_nuevo', COALESCE(v_stock_nuevo, 0), 'delta', p_delta, 'ya_existia', true);
    END IF;
  END IF;

  SELECT empresa_id INTO v_empresa_id
    FROM public.depositos
   WHERE id = p_deposito_id;

  IF v_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado en esta empresa');
  END IF;

  v_tipo := COALESCE(p_tipo, CASE WHEN p_delta >= 0 THEN 'ingreso' ELSE 'egreso' END::tipo_movimiento);

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

  -- El movimiento se inserta ANTES de tocar lotes para poder linkear el
  -- detalle (movimientos_stock_lotes) contra un id ya existente.
  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas, offline_local_id)
  VALUES
    (p_producto_id, p_deposito_id, v_tipo, ABS(p_delta), p_motivo, p_usuario_id, p_notas, p_offline_local_id)
  RETURNING id INTO v_mov_id;

  IF p_delta > 0 THEN
    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_id,
      'AJUSTE-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      p_delta, p_delta,
      'activo'
    ) RETURNING id INTO v_lote_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_id, v_lote_id, p_delta, 'alta');

  ELSIF p_delta < 0 THEN
    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    SELECT v_mov_id, f.lote_id, f.cantidad_consumida, 'consumo'
      FROM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, ABS(p_delta), p_motivo, p_usuario_id) f;
  END IF;

  RETURN json_build_object(
    'ok',          true,
    'stock_nuevo', v_stock_nuevo,
    'delta',       p_delta
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id INTO v_existente_id
        FROM public.movimientos_stock
       WHERE offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        SELECT cantidad INTO v_stock_nuevo
          FROM public.stock
         WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;
        RETURN json_build_object('ok', true, 'stock_nuevo', COALESCE(v_stock_nuevo, 0), 'delta', p_delta, 'ya_existia', true);
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.ajustar_stock FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ajustar_stock TO authenticated, service_role;

COMMENT ON FUNCTION public.ajustar_stock IS
  'Aplica un delta a stock.cantidad de forma atómica, registra el movimiento, '
  'sincroniza lotes/FEFO y deja el detalle en movimientos_stock_lotes (mig. 462) '
  'de qué lote(s) participaron.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '464_ajustar_stock_con_detalle_lotes.sql', '464', 'claude-session',
  'Reconstrucción retroactiva: ajustar_stock() inserta detalle de lote en movimientos_stock_lotes (alta o consumo) usando fn_lotes_consumir_fefo con retorno de detalle (mig. 463).')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
