-- 429_fix_anular_venta_pos_anula_factura_vinculada.sql
-- Documenta en el repo el fix ya aplicado en producción (auditoría Cobranzas/POS, v532).
--
-- Bug: la migración 416 dejaba comentado que se bloqueaba la anulación de
-- ventas ya facturadas, pero el cuerpo real de la función seguía sin
-- implementarlo: dependía de ventas_pos.factura_id, columna que queda NULL
-- aunque la venta tenga factura (la relación confiable es
-- facturas.venta_pos_id). Consecuencia verificada en producción: se
-- anulaban ventas con factura ya emitida sin pasar por Nota de Crédito, y
-- la factura vinculada quedaba "pendiente" para siempre — visible en
-- Cobranzas como deuda real de un cliente, aunque el crédito compensatorio
-- en cta_cte ya la hubiera saldado.
-- Caso real corregido a mano: 41a96ee7-b08d-4b8b-8c2b-bf63ea499873 ($7.106,33).
--
-- Fix: busca la factura por ambos lados de la relación y, si no tiene CAE,
-- la marca anulada junto con la venta.

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

  -- FIX: antes esto sólo confiaba en ventas_pos.factura_id, columna que se
  -- descubrió desincronizada (queda NULL aunque la venta ya tenga factura
  -- emitida — la relación confiable es facturas.venta_pos_id). Ahora se
  -- busca la factura vinculada por ambos lados, para no dejar pasar una
  -- venta ya facturada con CAE.
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

  -- FIX (bug reportado): antes esto nunca tocaba `facturas`, así que la
  -- factura vinculada a una venta anulada quedaba "pendiente" para siempre
  -- y seguía apareciendo como deuda a cobrar en Cobranzas, aunque el
  -- crédito de arriba ya la hubiera compensado en cta_cte.
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
