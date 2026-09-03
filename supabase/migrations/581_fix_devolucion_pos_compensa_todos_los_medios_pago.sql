-- 581_fix_devolucion_pos_compensa_todos_los_medios_pago
--
-- Bug: rpc_registrar_devolucion_pos solo revertía plata para devoluciones
-- pagadas en cuenta_corriente. Para efectivo/tarjeta/qr/transferencia no
-- generaba ningún movimiento compensatorio:
--   - Efectivo: cerrar_turno_caja seguía contando el efectivo original como
--     si siguiera en la caja (no había INSERT en movimientos_caja), lo que
--     mostraba un faltante falso al cerrar turno.
--   - Tarjeta/QR/transferencia: no quedaba ningún registro de que esa plata
--     salió de algún lado.
--
-- Decisión de negocio (Cristian, 2026-09-02):
--   - Efectivo -> sangría automática en movimientos_caja al registrar la
--     devolución.
--   - Tarjeta/QR/transferencia -> se acredita como crédito en cuenta
--     corriente del cliente, igual que ya hacía cuenta_corriente (mientras
--     no exista reversa real contra Mercado Pago).

ALTER TABLE devoluciones_pos
  ADD COLUMN IF NOT EXISTS aviso_compensacion TEXT NULL;

COMMENT ON COLUMN devoluciones_pos.aviso_compensacion IS
  'Nota visible cuando la devolución no pudo compensarse automáticamente '
  '(ej. venta sin cliente asociado pagada con tarjeta/QR/transferencia, '
  'o devolución en efectivo sin turno de caja abierto). Requiere ajuste manual.';

CREATE OR REPLACE FUNCTION public.rpc_registrar_devolucion_pos(p_venta_pos_id uuid, p_items jsonb, p_motivo text, p_usuario_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id            UUID;
  v_caja_id               UUID;
  v_deposito_id           UUID;
  v_venta_turno_id        UUID;
  v_devolucion_id         UUID;
  v_item                  JSONB;
  v_vpi                   RECORD;
  v_ya_devuelto           NUMERIC;
  v_monto                 NUMERIC;
  v_monto_total           NUMERIC := 0;
  v_cant_dev              NUMERIC;
  v_cliente_id            UUID;
  v_venta_total           NUMERIC;
  v_monto_no_efectivo_pagado NUMERIC := 0;
  v_monto_efectivo_pagado NUMERIC := 0;
  v_credito_cta_cte       NUMERIC := 0;
  v_monto_efectivo_dev    NUMERIC := 0;
  v_turno_sangria_id      UUID;
  v_avisos                TEXT[] := ARRAY[]::TEXT[];
  v_lote_id               UUID;
  v_mov_id                UUID;
  v_venta_numero          TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  SELECT empresa_id, caja_id, cliente_id, total, numero, turno_id
    INTO v_empresa_id, v_caja_id, v_cliente_id, v_venta_total, v_venta_numero, v_venta_turno_id
    FROM ventas_pos
   WHERE id = p_venta_pos_id;

  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  IF auth.role() <> 'service_role' AND v_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  SELECT deposito_id INTO v_deposito_id FROM cajas_pos WHERE id = v_caja_id;

  INSERT INTO devoluciones_pos (empresa_id, venta_pos_id, usuario_id, motivo, monto_total)
  VALUES (v_empresa_id, p_venta_pos_id, p_usuario_id, p_motivo, 0)
  RETURNING id INTO v_devolucion_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_vpi FROM venta_pos_items WHERE id = (v_item->>'venta_pos_item_id')::uuid AND venta_pos_id = p_venta_pos_id;
    IF v_vpi IS NULL THEN
      RAISE EXCEPTION 'Ítem de venta no encontrado en esta venta';
    END IF;

    SELECT COALESCE(SUM(cantidad_devuelta), 0) INTO v_ya_devuelto
      FROM devoluciones_pos_items WHERE venta_pos_item_id = v_vpi.id;

    v_cant_dev := (v_item->>'cantidad_devuelta')::NUMERIC;

    IF v_ya_devuelto + v_cant_dev > v_vpi.cantidad THEN
      RAISE EXCEPTION 'No se puede devolver más cantidad de la vendida para "%"', v_vpi.producto_id;
    END IF;

    v_monto := v_cant_dev * v_vpi.precio_unitario * (1 - COALESCE(v_vpi.descuento_pct, 0) / 100);
    v_monto_total := v_monto_total + v_monto;

    INSERT INTO devoluciones_pos_items (devolucion_id, venta_pos_item_id, producto_id, cantidad_devuelta, monto)
    VALUES (v_devolucion_id, v_vpi.id, v_vpi.producto_id, v_cant_dev, v_monto);

    IF v_deposito_id IS NOT NULL THEN
      UPDATE stock
         SET cantidad = cantidad + v_cant_dev
       WHERE producto_id = v_vpi.producto_id AND deposito_id = v_deposito_id;

      INSERT INTO lotes (
        empresa_id, producto_id, deposito_id,
        numero_lote, cantidad, cantidad_disponible,
        estado
      ) VALUES (
        v_empresa_id, v_vpi.producto_id, v_deposito_id,
        'DEV-' || LEFT(p_venta_pos_id::TEXT, 8) || '-' || TO_CHAR(now(), 'YYYYMMDD'),
        v_cant_dev, v_cant_dev,
        'activo'
      ) RETURNING id INTO v_lote_id;

      INSERT INTO movimientos_stock
        (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
      VALUES
        (v_vpi.producto_id, v_deposito_id, 'ingreso', v_cant_dev,
         v_devolucion_id, 'Devolución POS ' || COALESCE(v_venta_numero, p_venta_pos_id::text), p_usuario_id)
      RETURNING id INTO v_mov_id;

      INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
      VALUES (v_mov_id, v_lote_id, v_cant_dev, 'alta');
    END IF;
  END LOOP;

  -- ── Compensación de plata devuelta, por medio de pago original ──────────

  -- Cuenta corriente + tarjeta + QR + transferencia: se acreditan todas
  -- igual, como crédito en cta-cte del cliente (decisión de negocio:
  -- mientras no haya reversa real contra Mercado Pago para tarjeta/QR).
  SELECT COALESCE(SUM(monto), 0) INTO v_monto_no_efectivo_pagado
    FROM venta_pos_pagos
   WHERE venta_pos_id = p_venta_pos_id
     AND medio IN ('cuenta_corriente', 'tarjeta', 'qr', 'transferencia');

  IF v_monto_no_efectivo_pagado > 0 AND v_venta_total > 0 THEN
    IF v_cliente_id IS NOT NULL THEN
      v_credito_cta_cte := ROUND(v_monto_total * (v_monto_no_efectivo_pagado / v_venta_total), 2);

      IF v_credito_cta_cte > 0 THEN
        INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
        VALUES (v_empresa_id, v_cliente_id, 'credito', v_credito_cta_cte,
                'Devolución POS venta ' || COALESCE(v_venta_numero, p_venta_pos_id::text), now());
      END IF;
    ELSE
      -- Venta sin cliente asociado (mostrador anónimo) pagada con
      -- tarjeta/QR/transferencia: no hay cta-cte a la cual acreditar.
      v_avisos := array_append(v_avisos,
        'No se pudo acreditar cta-cte: la venta no tiene cliente asociado. Compensar manualmente.');
    END IF;
  END IF;

  -- Efectivo: sangría automática en movimientos_caja, sobre el turno
  -- actualmente abierto de esa caja (preferimos el turno original de la
  -- venta si sigue abierto; si no, cualquier turno abierto de la caja).
  SELECT COALESCE(SUM(monto), 0) INTO v_monto_efectivo_pagado
    FROM venta_pos_pagos
   WHERE venta_pos_id = p_venta_pos_id
     AND medio = 'efectivo';

  IF v_monto_efectivo_pagado > 0 AND v_venta_total > 0 THEN
    v_monto_efectivo_dev := ROUND(v_monto_total * (v_monto_efectivo_pagado / v_venta_total), 2);

    IF v_monto_efectivo_dev > 0 THEN
      SELECT id INTO v_turno_sangria_id
        FROM turnos_caja
       WHERE id = v_venta_turno_id AND estado = 'abierto';

      IF v_turno_sangria_id IS NULL AND v_caja_id IS NOT NULL THEN
        SELECT id INTO v_turno_sangria_id
          FROM turnos_caja
         WHERE caja_id = v_caja_id AND estado = 'abierto'
         ORDER BY abierto_at DESC
         LIMIT 1;
      END IF;

      IF v_turno_sangria_id IS NOT NULL THEN
        INSERT INTO movimientos_caja (empresa_id, turno_id, tipo, monto, concepto, usuario_id)
        VALUES (v_empresa_id, v_turno_sangria_id, 'sangria', v_monto_efectivo_dev,
                'Devolución POS venta ' || COALESCE(v_venta_numero, p_venta_pos_id::text) || ' (automática)',
                p_usuario_id);
      ELSE
        v_avisos := array_append(v_avisos,
          'No hay turno de caja abierto: no se generó la sangría de $' ||
          v_monto_efectivo_dev::text || ' en efectivo. Ajustar manualmente al abrir turno.');
      END IF;
    END IF;
  END IF;

  UPDATE devoluciones_pos
     SET monto_total = v_monto_total,
         monto_acreditado_cta_cte = v_credito_cta_cte,
         aviso_compensacion = NULLIF(array_to_string(v_avisos, ' / '), '')
   WHERE id = v_devolucion_id;

  RETURN v_devolucion_id;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$function$;
