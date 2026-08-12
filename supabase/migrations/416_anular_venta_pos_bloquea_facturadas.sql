-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 416: anular_venta_pos bloquea ventas ya facturadas + exige motivo
--
-- BUG: anular_venta_pos repone stock y marca estado='anulada' sin chequear
-- ventas_pos.factura_id. Si la venta ya tenía una factura con CAE emitida
-- ante AFIP/ARCA, quedaba "anulada" en el panel pero la factura fiscal
-- seguía viva sin la venta que la respalda — inconsistencia contable real,
-- no solo de UX. Tampoco exigía p_motivo (quedaba sin rastro de por qué).
--
-- El bloqueo ya se agregó en el handler (lib/handlers/pos.js) para dar un
-- error claro antes de llegar a la RPC. Esto es defensa en profundidad: si
-- algo llama anular_venta_pos directo (otra ruta, script, acceso directo a
-- la DB), la RPC igual lo frena.
-- ═══════════════════════════════════════════════════════════════════════════════

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

  IF v_venta.factura_id IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Esta venta ya tiene una factura con CAE emitida. Para anularla, emití antes una Nota de Crédito.');
  END IF;

  SELECT cp.deposito_id INTO v_deposito_id
  FROM ventas_pos vp
  JOIN cajas_pos cp ON cp.id = vp.caja_id
  WHERE vp.id = p_venta_pos_id;

  FOR v_item IN
    SELECT producto_id, cantidad FROM venta_pos_items WHERE venta_pos_id = p_venta_pos_id
  LOOP
    UPDATE stock
       SET cantidad = cantidad + v_item.cantidad,
           cantidad_disponible = cantidad_disponible + v_item.cantidad
     WHERE producto_id = v_item.producto_id
       AND deposito_id = v_deposito_id;

    INSERT INTO movimientos_stock (
      producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id, notas
    ) VALUES (
      v_item.producto_id, v_deposito_id, 'ingreso', v_item.cantidad,
      v_venta.id, 'Anulación venta POS ' || v_venta.numero, p_usuario_id, p_motivo
    );
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

  UPDATE ventas_pos SET estado = 'anulada' WHERE id = p_venta_pos_id;

  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $function$;
