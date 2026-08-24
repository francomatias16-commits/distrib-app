-- ═══════════════════════════════════════════════════════════════════════════
-- 471_fn_lotes_dar_de_baja_transferir_entre_depositos_detalle.sql [reconstruida, ver 462]
--
-- [Reconstrucción retroactiva — funciones ya vigentes en producción, leídas
--  directamente desde pg_proc. No-op funcional sobre la base actual. Cierra
--  el gap de numeración 462-472.]
--
-- fn_lotes_dar_de_baja(): da de baja (cantidad → 0) un lote completo,
-- descuenta el equivalente de `stock` (si el lote tiene depósito), registra
-- el egreso y deja el detalle en movimientos_stock_lotes.
--
-- transferir_stock_entre_depositos(): variante histórica de transferencia
-- (distinta de transferir_stock() de la mig. 465, usada por otro flujo del
-- POS/pantalla de depósitos) que también reparte por FEFO real, clonando
-- cada lote consumido en origen hacia el depósito destino y dejando el
-- detalle en movimientos_stock_lotes para ambos movimientos.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_lotes_dar_de_baja(
  p_lote_id     uuid,
  p_motivo      text DEFAULT 'Baja de lote vencido'::text,
  p_usuario_id  uuid DEFAULT NULL::uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lote          RECORD;
  v_empresa_id    uuid;
  v_stock_actual  numeric;
  v_stock_nuevo   numeric;
  v_mov_id        uuid;
BEGIN
  SELECT l.id, l.empresa_id, l.producto_id, l.deposito_id, l.numero_lote,
         l.cantidad, l.costo_unitario
    INTO v_lote
    FROM public.lotes l
   WHERE l.id = p_lote_id
   FOR UPDATE;

  IF v_lote.id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Lote no encontrado');
  END IF;

  v_empresa_id := v_lote.empresa_id;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF v_lote.cantidad <= 0 THEN
    RETURN json_build_object('ok', true, 'ya_estaba_en_cero', true, 'cantidad_dada_de_baja', 0);
  END IF;

  IF v_lote.deposito_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error',
      'El lote no tiene depósito asignado — asignale uno desde "Editar" antes de darlo de baja.');
  END IF;

  SELECT cantidad INTO v_stock_actual
    FROM public.stock
   WHERE producto_id = v_lote.producto_id AND deposito_id = v_lote.deposito_id
   FOR UPDATE;

  v_stock_nuevo := GREATEST(0, COALESCE(v_stock_actual, 0) - v_lote.cantidad);

  UPDATE public.stock
     SET cantidad = v_stock_nuevo, updated_at = now()
   WHERE producto_id = v_lote.producto_id AND deposito_id = v_lote.deposito_id;

  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas, costo_unitario)
  VALUES
    (v_lote.producto_id, v_lote.deposito_id, 'egreso', v_lote.cantidad, p_motivo, v_lote.id,
     p_usuario_id, 'Baja de lote ' || COALESCE(v_lote.numero_lote, v_lote.id::text), v_lote.costo_unitario)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
  VALUES (v_mov_id, v_lote.id, v_lote.cantidad, 'consumo');

  UPDATE public.lotes
     SET cantidad = 0, cantidad_disponible = 0, updated_at = now()
   WHERE id = p_lote_id;

  RETURN json_build_object(
    'ok', true,
    'cantidad_dada_de_baja', v_lote.cantidad,
    'stock_anterior', COALESCE(v_stock_actual, 0),
    'stock_nuevo', v_stock_nuevo
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_lotes_dar_de_baja TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_lotes_dar_de_baja IS
  'Da de baja un lote completo, descuenta el equivalente de stock y deja el '
  'detalle en movimientos_stock_lotes (mig. 462).';

-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transferir_stock_entre_depositos(
  p_producto_id       uuid,
  p_deposito_origen   uuid,
  p_deposito_destino  uuid,
  p_cantidad          numeric,
  p_usuario_id        uuid,
  p_notas             text DEFAULT NULL::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_disponible_origen NUMERIC;
  v_costo_promedio    NUMERIC;
  v_empresa_id        UUID;
  v_lote              RECORD;
  v_restante          NUMERIC;
  v_consumir          NUMERIC;
  v_mov_origen_id      UUID;
  v_mov_destino_id     UUID;
  v_lote_destino_id    UUID;
BEGIN
  IF p_deposito_origen = p_deposito_destino THEN
    RETURN json_build_object('ok', false, 'tipo', 'depositos_iguales',
      'error', 'El depósito de origen y destino no pueden ser el mismo');
  END IF;

  IF p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'tipo', 'cantidad_invalida',
      'error', 'La cantidad a transferir debe ser mayor a cero');
  END IF;

  SELECT empresa_id INTO v_empresa_id FROM depositos WHERE id = p_deposito_origen;

  SELECT cantidad, costo_promedio
    INTO v_disponible_origen, v_costo_promedio
    FROM stock
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_origen
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'tipo', 'sin_stock_origen',
      'error', 'No existe stock de este producto en el depósito de origen');
  END IF;

  IF v_disponible_origen < p_cantidad THEN
    RETURN json_build_object('ok', false, 'tipo', 'stock_insuficiente',
      'error', 'Stock insuficiente en origen. Disponible: ' || v_disponible_origen::TEXT);
  END IF;

  UPDATE stock
     SET cantidad            = cantidad - p_cantidad,
         updated_at          = NOW()
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_origen;

  INSERT INTO stock (producto_id, deposito_id, cantidad, costo_promedio)
  VALUES (p_producto_id, p_deposito_destino, p_cantidad, COALESCE(v_costo_promedio, 0))
  ON CONFLICT (producto_id, deposito_id) DO UPDATE
    SET cantidad            = stock.cantidad + EXCLUDED.cantidad,
        updated_at          = NOW();

  INSERT INTO movimientos_stock (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES (p_producto_id, p_deposito_origen, 'transferencia', -p_cantidad,
          'Transferencia a depósito ' || p_deposito_destino::TEXT, p_usuario_id, p_notas)
  RETURNING id INTO v_mov_origen_id;

  INSERT INTO movimientos_stock (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES (p_producto_id, p_deposito_destino, 'transferencia', p_cantidad,
          'Transferencia desde depósito ' || p_deposito_origen::TEXT, p_usuario_id, p_notas)
  RETURNING id INTO v_mov_destino_id;

  v_restante := p_cantidad;

  FOR v_lote IN
    SELECT id, cantidad_disponible, costo_unitario, fecha_vencimiento, numero_lote, fecha_fabricacion
      FROM lotes
     WHERE producto_id = p_producto_id
       AND deposito_id = p_deposito_origen
       AND estado      = 'activo'
       AND cantidad_disponible > 0
     ORDER BY fecha_vencimiento ASC NULLS LAST, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_restante <= 0;

    v_consumir := LEAST(v_lote.cantidad_disponible, v_restante);

    UPDATE lotes
       SET cantidad            = GREATEST(0, cantidad - v_consumir),
           cantidad_disponible = GREATEST(0, cantidad_disponible - v_consumir),
           updated_at          = NOW()
     WHERE id = v_lote.id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_origen_id, v_lote.id, v_consumir, 'consumo');

    INSERT INTO lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      costo_unitario, fecha_fabricacion, fecha_vencimiento, estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_destino,
      COALESCE(v_lote.numero_lote, 'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD')),
      v_consumir, v_consumir,
      v_lote.costo_unitario, v_lote.fecha_fabricacion, v_lote.fecha_vencimiento,
      'activo'
    ) RETURNING id INTO v_lote_destino_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_destino_id, v_lote_destino_id, v_consumir, 'alta');

    v_restante := v_restante - v_consumir;
  END LOOP;

  RETURN json_build_object('ok', true,
    'producto_id', p_producto_id,
    'cantidad', p_cantidad,
    'origen', p_deposito_origen,
    'destino', p_deposito_destino);

EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.transferir_stock_entre_depositos TO authenticated, service_role;

COMMENT ON FUNCTION public.transferir_stock_entre_depositos IS
  'Transferencia entre depósitos (variante histórica) repartiendo por FEFO '
  'real: consume lotes de origen por vencimiento y los clona al destino, '
  'dejando el detalle en movimientos_stock_lotes (mig. 462).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '471_fn_lotes_dar_de_baja_transferir_entre_depositos_detalle.sql', '471', 'claude-session',
  'Reconstrucción retroactiva: fn_lotes_dar_de_baja y transferir_stock_entre_depositos, ambas ya vigentes en producción con detalle en movimientos_stock_lotes. Cierra el gap de numeración 462-472.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
