-- Fix POS-AUDIT-01: rpc_registrar_devolucion_pos actualizaba `stock`
-- directamente sin dejar rastro en `movimientos_stock` (el kardex que
-- usan reportes y el historial de stock). Es el mismo patrón que ya se
-- había corregido para ajustes de lote (fn_lotes_ajustar_cantidad,
-- migración 470): cualquier cambio de cantidad en `stock` debe tener su
-- movimiento correspondiente. Se agrega el INSERT en movimientos_stock
-- (tipo 'ingreso') y su detalle en movimientos_stock_lotes, ligado al
-- mismo lote que ya se crea para la devolución.
--
-- Reconstruida en la etapa 6 de la auditoría funcional (v775) leyendo
-- supabase_migrations.schema_migrations de la base real — el archivo
-- original nunca se había commiteado al repo (ver
-- CHANGELOGS_INTEGRACION/CHANGELOG_v775_...md). Contenido idéntico al
-- que efectivamente se aplicó en producción el 2026-08-16.
--
-- NOTA: esta versión todavía tiene el bug de `direccion = 'ingreso'`
-- (valor inválido para movimientos_stock_lotes_direccion_check, que solo
-- acepta 'consumo'/'alta') — corregido más tarde el mismo día por la
-- migración 484. Se preserva tal cual se aplicó, sin "arreglarla en el
-- camino", para que el historial de migraciones refleje la realidad.

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
  v_devolucion_id         UUID;
  v_item                  JSONB;
  v_vpi                   RECORD;
  v_ya_devuelto           NUMERIC;
  v_monto                 NUMERIC;
  v_monto_total           NUMERIC := 0;
  v_cant_dev              NUMERIC;
  v_cliente_id            UUID;
  v_venta_total           NUMERIC;
  v_monto_cta_cte_pagado  NUMERIC := 0;
  v_credito_cta_cte       NUMERIC := 0;
  v_lote_id               UUID;
  v_mov_id                UUID;
  v_venta_numero          TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  SELECT empresa_id, caja_id, cliente_id, total, numero
    INTO v_empresa_id, v_caja_id, v_cliente_id, v_venta_total, v_venta_numero
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

      -- FIX POS-AUDIT-01: dejar rastro en el kardex, igual que cualquier
      -- otro movimiento del sistema (venta, ajuste de lote, etc).
      INSERT INTO movimientos_stock
        (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
      VALUES
        (v_vpi.producto_id, v_deposito_id, 'ingreso', v_cant_dev,
         v_devolucion_id, 'Devolución POS ' || COALESCE(v_venta_numero, p_venta_pos_id::text), p_usuario_id)
      RETURNING id INTO v_mov_id;

      INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
      VALUES (v_mov_id, v_lote_id, v_cant_dev, 'ingreso');
    END IF;
  END LOOP;

  -- fix POS-002: si la venta original tuvo pago por cuenta corriente,
  -- acreditar la parte proporcional de la devolución al saldo del cliente.
  -- El pago en POS no está atado a ítems específicos, por eso se prorratea:
  -- si el cliente pagó, por ejemplo, 60% en cta_cte y 40% en efectivo, se
  -- asume que cada ítem devuelto se pagó en esa misma proporción.
  IF v_cliente_id IS NOT NULL THEN
    SELECT COALESCE(SUM(monto), 0) INTO v_monto_cta_cte_pagado
      FROM venta_pos_pagos
     WHERE venta_pos_id = p_venta_pos_id AND medio = 'cuenta_corriente';

    IF v_monto_cta_cte_pagado > 0 AND v_venta_total > 0 THEN
      v_credito_cta_cte := ROUND(v_monto_total * (v_monto_cta_cte_pagado / v_venta_total), 2);

      IF v_credito_cta_cte > 0 THEN
        INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
        VALUES (v_empresa_id, v_cliente_id, 'credito', v_credito_cta_cte,
                'Devolución POS venta ' || p_venta_pos_id::text, now());
      END IF;
    END IF;
  END IF;

  UPDATE devoluciones_pos
     SET monto_total = v_monto_total,
         monto_acreditado_cta_cte = v_credito_cta_cte
   WHERE id = v_devolucion_id;

  RETURN v_devolucion_id;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$function$;
