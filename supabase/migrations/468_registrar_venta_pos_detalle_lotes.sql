-- ═══════════════════════════════════════════════════════════════════════════
-- 468_registrar_venta_pos_detalle_lotes.sql [reconstruida, ver 462]
--
-- registrar_venta_pos(): por cada ítem vendido, además de descontar el
-- agregado de `stock`, consume los lotes por FEFO vía fn_lotes_consumir_fefo
-- (463) y deja el detalle en movimientos_stock_lotes. Resto de la lógica
-- (idempotencia por offline_local_id, validación de pagos, cuenta
-- corriente/límite de crédito, turno de caja abierto) idéntica a la versión
-- previa.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.registrar_venta_pos(
  p_empresa_id            uuid,
  p_caja_id               uuid,
  p_turno_id              uuid,
  p_vendedor_id           uuid,
  p_cliente_id            uuid,
  p_deposito_id           uuid,
  p_items                 jsonb,
  p_pagos                 jsonb,
  p_subtotal              numeric,
  p_iva_total             numeric,
  p_total                 numeric,
  p_descuento_global_pct  numeric DEFAULT 0,
  p_offline_local_id      text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_venta_id      UUID;
  v_numero        TEXT;
  v_item          JSONB;
  v_pago          JSONB;
  v_producto_id   UUID;
  v_cantidad      NUMERIC;
  v_disponible    NUMERIC;
  v_suma_pagos    NUMERIC := 0;
  v_limite        NUMERIC;
  v_saldo_actual  NUMERIC;
  v_monto_cta_cte NUMERIC := 0;
  v_existente_id  UUID;
  v_existente_num TEXT;
  v_mov_id        UUID;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'tipo', 'no_autorizado', 'error', 'No autorizado');
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id, numero INTO v_existente_id, v_existente_num
      FROM public.ventas_pos
     WHERE empresa_id = p_empresa_id AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      RETURN json_build_object(
        'ok', true, 'venta_id', v_existente_id, 'numero', v_existente_num, 'ya_existia', true
      );
    END IF;
  END IF;

  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_suma_pagos
    FROM jsonb_array_elements(p_pagos) p;

  IF ABS(v_suma_pagos - p_total) > 1 THEN
    RETURN json_build_object('ok', false, 'tipo', 'pagos_no_coinciden',
      'error', 'La suma de los pagos no coincide con el total de la venta');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.turnos_caja
     WHERE id = p_turno_id AND caja_id = p_caja_id AND estado = 'abierto'
  ) THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_cerrado',
      'error', 'No hay un turno abierto para esta caja');
  END IF;

  SELECT COALESCE(SUM((p->>'monto')::NUMERIC), 0) INTO v_monto_cta_cte
    FROM jsonb_array_elements(p_pagos) p WHERE p->>'medio' = 'cuenta_corriente';

  IF v_monto_cta_cte > 0 THEN
    IF p_cliente_id IS NULL THEN
      RETURN json_build_object('ok', false, 'tipo', 'cliente_requerido',
        'error', 'No se puede imputar a cuenta corriente sin un cliente seleccionado');
    END IF;

    SELECT limite_credito, COALESCE(saldo_deuda, 0) INTO v_limite, v_saldo_actual
      FROM public.clientes WHERE id = p_cliente_id;

    IF v_limite > 0 THEN
      IF v_saldo_actual + v_monto_cta_cte > v_limite THEN
        RETURN json_build_object('ok', false, 'tipo', 'limite_credito',
          'error', 'Supera el límite de crédito del cliente');
      END IF;
    END IF;
  END IF;

  SELECT 'POS-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' ||
         LPAD(nextval('public.seq_ventas_pos')::TEXT, 5, '0')
    INTO v_numero;

  INSERT INTO public.ventas_pos (
    empresa_id, caja_id, turno_id, cliente_id, vendedor_id, numero,
    subtotal, iva_total, total, estado, descuento_global_pct,
    offline_local_id, es_offline
  ) VALUES (
    p_empresa_id, p_caja_id, p_turno_id, p_cliente_id, p_vendedor_id, v_numero,
    ROUND(p_subtotal, 2), ROUND(p_iva_total, 2), ROUND(p_total, 2),
    'completada',
    COALESCE(p_descuento_global_pct, 0),
    p_offline_local_id, (p_offline_local_id IS NOT NULL)
  ) RETURNING id INTO v_venta_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_producto_id := (v_item->>'producto_id')::UUID;
    v_cantidad    := (v_item->>'cantidad')::NUMERIC;

    INSERT INTO public.venta_pos_items (
      venta_pos_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal
    ) VALUES (
      v_venta_id, v_producto_id, v_cantidad,
      (v_item->>'precio_unitario')::NUMERIC,
      COALESCE((v_item->>'descuento_pct')::NUMERIC, 0),
      ROUND((v_item->>'subtotal')::NUMERIC, 2)
    );

    SELECT cantidad INTO v_disponible
      FROM public.stock
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id
       FOR UPDATE;

    IF NOT FOUND OR v_disponible < v_cantidad THEN
      RAISE EXCEPTION 'stock_insuficiente:% disponible:%',
        v_producto_id::TEXT, COALESCE(v_disponible, 0)::TEXT;
    END IF;

    UPDATE public.stock
       SET cantidad            = cantidad - v_cantidad,
           updated_at          = NOW()
     WHERE producto_id = v_producto_id AND deposito_id = p_deposito_id;

    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
    VALUES
      (v_producto_id, p_deposito_id, 'egreso', v_cantidad,
       v_venta_id, 'Venta POS ' || v_numero, p_vendedor_id)
    RETURNING id INTO v_mov_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    SELECT v_mov_id, f.lote_id, f.cantidad_consumida, 'consumo'
      FROM fn_lotes_consumir_fefo(v_producto_id, p_deposito_id, v_cantidad, 'Venta POS ' || v_numero, p_vendedor_id) f;
  END LOOP;

  FOR v_pago IN SELECT * FROM jsonb_array_elements(p_pagos) LOOP
    INSERT INTO public.venta_pos_pagos (venta_pos_id, medio, monto, referencia)
    VALUES (v_venta_id, v_pago->>'medio', (v_pago->>'monto')::NUMERIC, v_pago->>'referencia');
  END LOOP;

  IF v_monto_cta_cte > 0 THEN
    INSERT INTO public.cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
    VALUES (p_empresa_id, p_cliente_id, 'debito', v_monto_cta_cte,
            'Venta POS ' || v_numero, NOW());
  END IF;

  RETURN json_build_object(
    'ok',       true,
    'venta_id', v_venta_id,
    'numero',   v_numero,
    'total',    p_total
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id, numero INTO v_existente_id, v_existente_num
        FROM public.ventas_pos
       WHERE empresa_id = p_empresa_id AND offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        RETURN json_build_object(
          'ok', true, 'venta_id', v_existente_id, 'numero', v_existente_num, 'ya_existia', true
        );
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
  WHEN OTHERS THEN
    IF SQLERRM LIKE 'stock_insuficiente:%' THEN
      RETURN json_build_object('ok', false, 'tipo', 'stock_insuficiente', 'error', SQLERRM);
    END IF;
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.registrar_venta_pos TO authenticated, service_role;

COMMENT ON FUNCTION public.registrar_venta_pos IS
  'Registra una venta POS; por cada ítem consume lotes por FEFO real y deja '
  'el detalle en movimientos_stock_lotes (mig. 462).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '468_registrar_venta_pos_detalle_lotes.sql', '468', 'claude-session',
  'Reconstrucción retroactiva: registrar_venta_pos ya vigente en producción — consume lotes por FEFO en cada ítem vendido y deja el detalle en movimientos_stock_lotes.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
