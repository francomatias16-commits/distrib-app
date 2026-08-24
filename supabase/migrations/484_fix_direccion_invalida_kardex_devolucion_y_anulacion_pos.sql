-- Fix urgente: las migraciones 482 (devolución POS) y 483 (anulación POS)
-- insertaban movimientos_stock_lotes.direccion = 'ingreso', valor que NO
-- existe en el constraint real (movimientos_stock_lotes_direccion_check
-- solo permite 'consumo' o 'alta'). La 482 se aplicó sin error visible
-- porque CREATE OR REPLACE FUNCTION no ejecuta el cuerpo — el error recién
-- iba a aparecer en producción la primera vez que alguien hiciera una
-- devolución o anulación con depósito asignado. Se corrige acá antes de
-- que eso pase. Valor correcto para stock que entra: 'alta' (mismo que usa
-- fn_lotes_crear_sincroniza_stock para altas de stock).
--
-- Reconstruida en la etapa 6 de la auditoría funcional (v775) leyendo
-- supabase_migrations.schema_migrations de la base real — el archivo
-- original nunca se había commiteado al repo. Contenido idéntico al que
-- efectivamente se aplicó en producción.
--
-- NOTA sobre la migración 483: el CHANGELOG_v769 la documenta como la que
-- creó `anular_venta_pos` con el fix de depósito real (tomarlo del
-- movimiento de egreso original en vez de `cajas_pos.deposito_id`), pero
-- 483 nunca quedó registrada como migración separada en
-- schema_migrations — probablemente se aplicó a mano desde el editor SQL
-- de Supabase sin pasar por la CLI de migraciones. Esta migración (484) la
-- recrea por completo con `CREATE OR REPLACE FUNCTION`, así que el cuerpo
-- de 483 queda 100% contenido acá (con el fix de dirección ya corregido de
-- entrada) — no hace falta ni es posible reconstruir un archivo 483 por
-- separado sin inventar contenido: cualquier intento de recuperar la
-- versión intermedia (con el bug de dirección todavía sin corregir) sería
-- pura conjetura, y no aporta nada — la función que importa es la que
-- terminó viva, capturada acá.

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

      INSERT INTO movimientos_stock
        (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
      VALUES
        (v_vpi.producto_id, v_deposito_id, 'ingreso', v_cant_dev,
         v_devolucion_id, 'Devolución POS ' || COALESCE(v_venta_numero, p_venta_pos_id::text), p_usuario_id)
      RETURNING id INTO v_mov_id;

      -- FIX: 'alta', no 'ingreso' (ver nota de migración arriba)
      INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
      VALUES (v_mov_id, v_lote_id, v_cant_dev, 'alta');
    END IF;
  END LOOP;

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

CREATE OR REPLACE FUNCTION public.anular_venta_pos(p_venta_pos_id uuid, p_usuario_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_venta       record;
  v_item        record;
  v_deposito_id uuid;
  v_pago        record;
  v_factura     record;
  v_lote_id     uuid;
  v_mov_id      uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RETURN json_build_object('ok', false, 'error', 'El motivo de la anulación es obligatorio');
  END IF;

  SELECT id, empresa_id, estado, cliente_id, numero, total, factura_id
    INTO v_venta
    FROM ventas_pos
   WHERE id = p_venta_pos_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Venta no encontrada');
  END IF;

  IF auth.role() <> 'service_role' AND v_venta.empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF v_venta.estado = 'anulada' THEN
    RETURN json_build_object('ok', true, 'skip', 'ya_anulada');
  END IF;

  SELECT id, estado, cae, total, total_cobrado
    INTO v_factura
    FROM facturas
   WHERE (id = v_venta.factura_id OR venta_pos_id = p_venta_pos_id)
     AND estado <> 'anulada'
   ORDER BY (id = v_venta.factura_id) DESC
   LIMIT 1;

  IF FOUND AND v_factura.cae IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Esta venta ya tiene una factura con CAE emitida. Para anularla, emití antes una Nota de Crédito.');
  END IF;

  FOR v_item IN
    SELECT vpi.producto_id, vpi.cantidad,
           COALESCE(
             (SELECT ms.deposito_id FROM movimientos_stock ms
               WHERE ms.referencia_id = v_venta.id AND ms.tipo = 'egreso'
               LIMIT 1),
             (SELECT cp.deposito_id FROM cajas_pos cp
               JOIN ventas_pos vp ON vp.caja_id = cp.id WHERE vp.id = v_venta.id)
           ) AS deposito_real
      FROM venta_pos_items vpi WHERE vpi.venta_pos_id = p_venta_pos_id
  LOOP
    v_deposito_id := v_item.deposito_real;

    IF v_deposito_id IS NOT NULL THEN
      UPDATE stock
         SET cantidad = cantidad + v_item.cantidad
       WHERE producto_id = v_item.producto_id
         AND deposito_id = v_deposito_id;

      INSERT INTO movimientos_stock (
        producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id, notas
      ) VALUES (
        v_item.producto_id, v_deposito_id, 'ingreso', v_item.cantidad,
        v_venta.id, 'Anulación venta POS ' || v_venta.numero, p_usuario_id, p_motivo
      ) RETURNING id INTO v_mov_id;

      INSERT INTO lotes (
        empresa_id, producto_id, deposito_id,
        numero_lote, cantidad, cantidad_disponible, estado
      ) VALUES (
        v_venta.empresa_id, v_item.producto_id, v_deposito_id,
        'ANUL-' || LEFT(v_venta.id::TEXT, 8) || '-' || TO_CHAR(now(), 'YYYYMMDD'),
        v_item.cantidad, v_item.cantidad, 'activo'
      ) RETURNING id INTO v_lote_id;

      -- FIX: 'alta', no 'ingreso'
      INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
      VALUES (v_mov_id, v_lote_id, v_item.cantidad, 'alta');
    END IF;
  END LOOP;

  SELECT medio, monto INTO v_pago
  FROM venta_pos_pagos
  WHERE venta_pos_id = p_venta_pos_id AND medio = 'cuenta_corriente'
  LIMIT 1;

  IF FOUND AND v_venta.cliente_id IS NOT NULL THEN
    INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, descripcion, fecha)
    VALUES (v_venta.empresa_id, v_venta.cliente_id, 'credito', v_pago.monto,
            'Anulación venta POS ' || v_venta.numero, now());
  END IF;

  IF v_factura.id IS NOT NULL AND v_factura.cae IS NULL THEN
    UPDATE facturas
       SET estado = 'anulada'
     WHERE id = v_factura.id;
  END IF;

  UPDATE ventas_pos SET estado = 'anulada' WHERE id = p_venta_pos_id;

  RETURN json_build_object('ok', true, 'factura_anulada', v_factura.id);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

-- Backfill: detalle de lote faltante para las 2 anulaciones ya existentes.
DO $$
DECLARE
  r RECORD;
  v_lote_id uuid;
BEGIN
  FOR r IN
    SELECT m.id AS mov_id, m.producto_id, m.deposito_id, m.cantidad,
           v.id AS venta_id, v.empresa_id
      FROM movimientos_stock m
      JOIN ventas_pos v ON v.id = m.referencia_id
     WHERE m.referencia LIKE 'Anulación venta POS%'
       AND NOT EXISTS (SELECT 1 FROM movimientos_stock_lotes msl WHERE msl.movimiento_stock_id = m.id)
  LOOP
    INSERT INTO lotes (empresa_id, producto_id, deposito_id, numero_lote, cantidad, cantidad_disponible, estado)
    VALUES (r.empresa_id, r.producto_id, r.deposito_id,
            'ANUL-BACKFILL-' || LEFT(r.venta_id::TEXT, 8), r.cantidad, r.cantidad, 'activo')
    RETURNING id INTO v_lote_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (r.mov_id, v_lote_id, r.cantidad, 'alta');
  END LOOP;
END $$;
