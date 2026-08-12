-- ============================================================
-- 443_offline_dedup_ajuste_stock.sql
--
-- Plan offline — Etapa 3, ítem 2: ajuste manual de stock / conteos.
-- (ver comentario extendido en el changelog v646)
-- ============================================================

BEGIN;

-- ── ajustar_stock: idempotencia por delta ──────────────────────────────

ALTER TABLE movimientos_stock
  ADD COLUMN IF NOT EXISTS offline_local_id TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_stock_offline_local_id
  ON movimientos_stock (offline_local_id)
  WHERE offline_local_id IS NOT NULL;

COMMENT ON COLUMN movimientos_stock.offline_local_id IS
  'ID generado en el dispositivo (crypto.randomUUID()) cuando el movimiento '
  '(ingreso/egreso manual) se originó en una acción encolada offline. Evita '
  'duplicar el movimiento si el outbox reintenta la misma acción.';

DROP FUNCTION IF EXISTS public.ajustar_stock(uuid, uuid, numeric, tipo_movimiento, text, text, uuid);

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
    PERFORM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, ABS(p_delta), p_motivo, p_usuario_id);
  END IF;

  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas, offline_local_id)
  VALUES
    (p_producto_id, p_deposito_id, v_tipo, ABS(p_delta), p_motivo, p_usuario_id, p_notas, p_offline_local_id);

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
  'Aplica un delta a stock.cantidad de forma atómica (lock FOR UPDATE), registra el movimiento y opcionalmente (p_offline_local_id) es idempotente ante reintentos del outbox offline — devuelve el stock ya actualizado en vez de aplicar el delta dos veces.';

-- ── registrar_conteo_stock: idempotencia + guarda de staleness ─────────

ALTER TABLE conteos_stock
  ADD COLUMN IF NOT EXISTS offline_local_id TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conteos_stock_offline_local_id
  ON conteos_stock (offline_local_id)
  WHERE offline_local_id IS NOT NULL;

COMMENT ON COLUMN conteos_stock.offline_local_id IS
  'ID generado en el dispositivo (crypto.randomUUID()) cuando el conteo se '
  'originó en una acción encolada offline. Evita duplicar el conteo si el '
  'outbox reintenta la misma acción.';

DROP FUNCTION IF EXISTS public.registrar_conteo_stock(uuid, uuid, numeric, text, text, uuid);

CREATE OR REPLACE FUNCTION public.registrar_conteo_stock(
  p_producto_id             UUID,
  p_deposito_id             UUID,
  p_cantidad_contada        NUMERIC,
  p_motivo                  TEXT DEFAULT 'conteo_fisico',
  p_notas                   TEXT DEFAULT NULL,
  p_usuario_id              UUID DEFAULT NULL,
  p_offline_local_id        TEXT DEFAULT NULL,
  p_stock_sistema_esperado  NUMERIC DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_empresa_id     UUID;
  v_stock_sistema  NUMERIC;
  v_diferencia     NUMERIC;
  v_conteo_id      UUID;
  v_existente_id   UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.conteos_stock
     WHERE offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      SELECT cantidad_sistema, cantidad_contada, diferencia
        INTO v_stock_sistema, p_cantidad_contada, v_diferencia
        FROM public.conteos_stock WHERE id = v_existente_id;
      RETURN json_build_object(
        'ok', true, 'stock_nuevo', p_cantidad_contada,
        'cantidad_sistema', v_stock_sistema, 'diferencia', v_diferencia,
        'conteo_id', v_existente_id, 'ya_existia', true
      );
    END IF;
  END IF;

  IF p_cantidad_contada IS NULL OR p_cantidad_contada < 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad contada debe ser un número mayor o igual a cero');
  END IF;

  SELECT empresa_id INTO v_empresa_id FROM public.depositos WHERE id = p_deposito_id;
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

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  SELECT cantidad INTO v_stock_sistema
    FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id
   FOR UPDATE;

  v_stock_sistema := COALESCE(v_stock_sistema, 0);

  IF p_stock_sistema_esperado IS NOT NULL AND p_stock_sistema_esperado IS DISTINCT FROM v_stock_sistema THEN
    RETURN json_build_object(
      'ok', false,
      'tipo', 'conflicto_stock_cambio',
      'error', 'El stock cambió en el servidor mientras el conteo estaba sin enviar',
      'stock_sistema_esperado', p_stock_sistema_esperado,
      'stock_sistema_actual', v_stock_sistema
    );
  END IF;

  v_diferencia := p_cantidad_contada - v_stock_sistema;

  UPDATE public.stock SET cantidad = p_cantidad_contada, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;

  IF v_diferencia > 0 THEN
    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_id,
      'CONTEO-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      v_diferencia, v_diferencia,
      'activo'
    );
  ELSIF v_diferencia < 0 THEN
    PERFORM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, ABS(v_diferencia), p_motivo, p_usuario_id);
  END IF;

  INSERT INTO public.conteos_stock
    (empresa_id, producto_id, deposito_id, cantidad_sistema, cantidad_contada, diferencia, motivo, notas, usuario_id, offline_local_id)
  VALUES
    (v_empresa_id, p_producto_id, p_deposito_id, v_stock_sistema, p_cantidad_contada, v_diferencia, p_motivo, p_notas, p_usuario_id, p_offline_local_id)
  RETURNING id INTO v_conteo_id;

  IF v_diferencia <> 0 THEN
    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
    VALUES
      (p_producto_id, p_deposito_id, 'ajuste', v_diferencia, p_motivo, v_conteo_id, p_usuario_id, p_notas);
  END IF;

  RETURN json_build_object(
    'ok',               true,
    'stock_nuevo',      p_cantidad_contada,
    'cantidad_sistema', v_stock_sistema,
    'diferencia',       v_diferencia,
    'conteo_id',        v_conteo_id
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id INTO v_existente_id
        FROM public.conteos_stock
       WHERE offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        SELECT cantidad_sistema, cantidad_contada, diferencia
          INTO v_stock_sistema, p_cantidad_contada, v_diferencia
          FROM public.conteos_stock WHERE id = v_existente_id;
        RETURN json_build_object(
          'ok', true, 'stock_nuevo', p_cantidad_contada,
          'cantidad_sistema', v_stock_sistema, 'diferencia', v_diferencia,
          'conteo_id', v_existente_id, 'ya_existia', true
        );
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_conteo_stock FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_conteo_stock TO authenticated, service_role;

COMMENT ON FUNCTION public.registrar_conteo_stock IS
  'Fija stock.cantidad a un valor absoluto contado físicamente, deja snapshot en conteos_stock. Opcionalmente (p_offline_local_id) es idempotente ante reintentos del outbox offline. Opcionalmente (p_stock_sistema_esperado) rechaza el conteo con tipo:conflicto_stock_cambio si el stock real ya no coincide con el que el dispositivo tenía al contar offline, en vez de pisarlo en silencio.';

COMMIT;
