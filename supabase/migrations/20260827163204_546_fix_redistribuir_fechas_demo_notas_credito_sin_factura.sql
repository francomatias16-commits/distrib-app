-- ============================================================
-- 546 — Fix: fn_redistribuir_fechas_demo no corrige notas_credito
--        sin factura_id (quedan con la fecha original del seed,
--        incluso futura, porque su delta solo se calculaba vía
--        JOIN con la factura padre).
--
-- CONTEXTO:
-- Igual que cta_cte, notas_credito puede existir sin factura_id
-- (columna nullable). Pero a diferencia de cta_cte -- que sí tiene
-- una rama de respaldo con hash propio para el caso factura_id IS
-- NULL -- notas_credito no la tenía. Resultado: las 20 notas_credito
-- demo (todas con factura_id NULL) nunca entraban al corr_map y
-- quedaban con la fecha con la que fueron sembradas originalmente,
-- incluso en el futuro (2027).
--
-- FIX: agregar la misma rama de respaldo que ya existe para
-- cta_cte, calculando el delta con hash propio sobre notas_credito.id
-- cuando factura_id es NULL.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_redistribuir_fechas_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para redistribuir fechas';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  DROP TABLE IF EXISTS corr_map;
  CREATE TEMP TABLE corr_map (entity_id uuid PRIMARY KEY, correction_days integer) ON COMMIT DROP;

  INSERT INTO corr_map
  SELECT id,
    (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - fecha_pedido::date
  FROM pedidos WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id,
    (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - fecha_pedido::date
  FROM ordenes_compra WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT tc.id,
    (CURRENT_DATE - ((('x'||substr(md5(tc.id::text),1,8))::bit(32)::bigint % 216)::int)) - abierto_at::date
  FROM turnos_caja tc JOIN cajas_pos cp ON cp.id = tc.caja_id WHERE cp.empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id,
    (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - fecha::date
  FROM rutas WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id,
    (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - fecha_emision::date
  FROM facturas WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id,
    (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - fecha::date
  FROM cobros WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT vp.id, cm.correction_days
  FROM ventas_pos vp JOIN corr_map cm ON cm.entity_id = vp.turno_id
  WHERE vp.empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - created_at::date
  FROM whatsapp_conversaciones WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - creado_en::date
  FROM asistente_conversaciones WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - created_at::date
  FROM movimientos_puntos WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - created_at::date
  FROM scores_cliente WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - created_at::date
  FROM alertas_score WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - created_at::date
  FROM conciliacion_bancaria_lotes WHERE empresa_id = v_empresa_id;

  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - created_at::date
  FROM export_contable_log WHERE empresa_id = v_empresa_id;

  UPDATE pedidos p
  SET created_at     = created_at + (cm.correction_days || ' days')::interval,
      updated_at     = updated_at + (cm.correction_days || ' days')::interval,
      fecha_pedido   = fecha_pedido + (cm.correction_days || ' days')::interval,
      fecha_despacho = CASE WHEN fecha_despacho IS NOT NULL THEN fecha_despacho + (cm.correction_days || ' days')::interval END,
      entregado_at   = CASE WHEN entregado_at IS NOT NULL THEN entregado_at + (cm.correction_days || ' days')::interval END,
      fecha_entrega  = CASE WHEN fecha_entrega IS NOT NULL THEN (fecha_entrega + (cm.correction_days || ' days')::interval)::date END
  FROM corr_map cm WHERE p.id = cm.entity_id;

  UPDATE ordenes_compra o
  SET created_at             = created_at + (cm.correction_days || ' days')::interval,
      updated_at             = updated_at + (cm.correction_days || ' days')::interval,
      fecha_pedido           = fecha_pedido + (cm.correction_days || ' days')::interval,
      fecha_confirmacion_at  = CASE WHEN fecha_confirmacion_at IS NOT NULL THEN fecha_confirmacion_at + (cm.correction_days || ' days')::interval END,
      fecha_esperada         = CASE WHEN fecha_esperada IS NOT NULL THEN (fecha_esperada + (cm.correction_days || ' days')::interval)::date END,
      fecha_recepcion        = CASE WHEN fecha_recepcion IS NOT NULL THEN fecha_recepcion + (cm.correction_days || ' days')::interval END
  FROM corr_map cm WHERE o.id = cm.entity_id;

  UPDATE turnos_caja t
  SET abierto_at = abierto_at + (cm.correction_days || ' days')::interval,
      cerrado_at = CASE WHEN cerrado_at IS NOT NULL THEN cerrado_at + (cm.correction_days || ' days')::interval END
  FROM corr_map cm WHERE t.id = cm.entity_id;

  UPDATE rutas r
  SET created_at         = created_at + (cm.correction_days || ' days')::interval,
      fecha              = (fecha + (cm.correction_days || ' days')::interval)::date,
      chofer_actualizado = CASE WHEN chofer_actualizado IS NOT NULL THEN chofer_actualizado + (cm.correction_days || ' days')::interval END
  FROM corr_map cm WHERE r.id = cm.entity_id;

  UPDATE facturas f
  SET fecha_emision     = fecha_emision + (cm.correction_days || ' days')::interval,
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (fecha_vencimiento + (cm.correction_days||' days')::interval)::date END,
      vencimiento       = CASE WHEN vencimiento IS NOT NULL THEN (vencimiento + (cm.correction_days||' days')::interval)::date END,
      cae_vto           = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto + (cm.correction_days||' days')::interval)::date END
  FROM corr_map cm WHERE f.id = cm.entity_id;

  UPDATE cobros c
  SET fecha = fecha + (cm.correction_days || ' days')::interval
  FROM corr_map cm WHERE c.id = cm.entity_id;

  UPDATE ventas_pos v
  SET created_at = created_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm WHERE v.id = cm.entity_id;

  UPDATE whatsapp_conversaciones w
  SET created_at          = created_at + (cm.correction_days || ' days')::interval,
      tomada_en           = CASE WHEN tomada_en IS NOT NULL THEN tomada_en + (cm.correction_days || ' days')::interval END,
      turno_desde         = CASE WHEN turno_desde IS NOT NULL THEN turno_desde + (cm.correction_days || ' days')::interval END,
      ultima_interaccion  = CASE WHEN ultima_interaccion IS NOT NULL THEN ultima_interaccion + (cm.correction_days || ' days')::interval END
  FROM corr_map cm WHERE w.id = cm.entity_id;

  UPDATE asistente_conversaciones a
  SET creado_en      = creado_en + (cm.correction_days || ' days')::interval,
      actualizado_en = CASE WHEN actualizado_en IS NOT NULL THEN actualizado_en + (cm.correction_days || ' days')::interval END
  FROM corr_map cm WHERE a.id = cm.entity_id;

  UPDATE movimientos_puntos mp
  SET created_at = created_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm WHERE mp.id = cm.entity_id;

  UPDATE scores_cliente sc
  SET created_at = created_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm WHERE sc.id = cm.entity_id;

  UPDATE alertas_score als
  SET created_at = created_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm WHERE als.id = cm.entity_id;

  UPDATE conciliacion_bancaria_lotes cbl
  SET created_at = created_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm WHERE cbl.id = cm.entity_id;

  UPDATE export_contable_log ecl
  SET created_at  = created_at + (cm.correction_days || ' days')::interval,
      fecha_desde = CASE WHEN fecha_desde IS NOT NULL THEN (fecha_desde + (cm.correction_days||' days')::interval)::date END,
      fecha_hasta = CASE WHEN fecha_hasta IS NOT NULL THEN (fecha_hasta + (cm.correction_days||' days')::interval)::date END
  FROM corr_map cm WHERE ecl.id = cm.entity_id;

  INSERT INTO corr_map
  SELECT rm.id, cm.correction_days
  FROM recepciones_mercaderia rm JOIN corr_map cm ON cm.entity_id = rm.orden_id
  WHERE rm.empresa_id = v_empresa_id;

  UPDATE recepciones_mercaderia rm
  SET created_at    = created_at + (cm.correction_days || ' days')::interval,
      confirmada_at = CASE WHEN confirmada_at IS NOT NULL THEN confirmada_at + (cm.correction_days || ' days')::interval END
  FROM corr_map cm WHERE rm.id = cm.entity_id;

  INSERT INTO corr_map
  SELECT fp.id, cm.correction_days
  FROM facturas_proveedor fp JOIN corr_map cm ON cm.entity_id = fp.orden_id
  WHERE fp.empresa_id = v_empresa_id;

  UPDATE facturas_proveedor fp
  SET created_at        = created_at + (cm.correction_days || ' days')::interval,
      updated_at        = updated_at + (cm.correction_days || ' days')::interval,
      fecha_factura     = CASE WHEN fecha_factura IS NOT NULL THEN (fecha_factura + (cm.correction_days||' days')::interval)::date END,
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (fecha_vencimiento + (cm.correction_days||' days')::interval)::date END
  FROM corr_map cm WHERE fp.id = cm.entity_id;

  UPDATE cta_cte c
  SET fecha      = fecha + (cm.correction_days || ' days')::interval,
      updated_at = updated_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm
  WHERE c.empresa_id = v_empresa_id AND c.factura_id IS NOT NULL AND cm.entity_id = c.factura_id
    AND c.id NOT IN (SELECT entity_id FROM corr_map);

  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - fecha::date
  FROM cta_cte WHERE empresa_id = v_empresa_id AND factura_id IS NULL
    AND id NOT IN (SELECT entity_id FROM corr_map);

  UPDATE cta_cte c
  SET fecha      = fecha + (cm.correction_days || ' days')::interval,
      updated_at = updated_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm
  WHERE c.id = cm.entity_id AND c.empresa_id = v_empresa_id AND c.factura_id IS NULL;

  INSERT INTO corr_map
  SELECT nc.id, cm.correction_days
  FROM notas_credito nc JOIN corr_map cm ON cm.entity_id = nc.factura_id
  WHERE nc.empresa_id = v_empresa_id AND nc.id NOT IN (SELECT entity_id FROM corr_map);

  -- NUEVO (546): respaldo con hash propio para notas_credito sin
  -- factura_id, igual que ya existía para cta_cte. Sin esto, las
  -- notas de crédito standalone nunca se corrigen y quedan con la
  -- fecha original del seed (incluso en el futuro).
  INSERT INTO corr_map
  SELECT id, (CURRENT_DATE - ((('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::int)) - fecha_emision::date
  FROM notas_credito WHERE empresa_id = v_empresa_id AND factura_id IS NULL
    AND id NOT IN (SELECT entity_id FROM corr_map);

  UPDATE notas_credito nc
  SET fecha_emision = fecha_emision + (cm.correction_days || ' days')::interval,
      cae_vto       = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto + (cm.correction_days||' days')::interval)::date END,
      updated_at    = updated_at + (cm.correction_days || ' days')::interval,
      created_at    = created_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm WHERE nc.id = cm.entity_id;

  UPDATE pagos_proveedor pp
  SET created_at = pp.created_at + (cm.correction_days || ' days')::interval,
      fecha_pago = CASE WHEN pp.fecha_pago IS NOT NULL THEN (pp.fecha_pago + (cm.correction_days||' days')::interval)::date END
  FROM facturas_proveedor fpv, corr_map cm
  WHERE pp.factura_id = fpv.id AND cm.entity_id = fpv.orden_id AND pp.empresa_id = v_empresa_id;

  UPDATE notas_debito_proveedor nd
  SET created_at = nd.created_at + (cm.correction_days || ' days')::interval,
      updated_at = nd.updated_at + (cm.correction_days || ' days')::interval
  FROM facturas_proveedor fpv, corr_map cm
  WHERE nd.factura_id = fpv.id AND cm.entity_id = fpv.orden_id AND nd.empresa_id = v_empresa_id;

  UPDATE entregas e
  SET fecha_confirmacion = CASE WHEN e.fecha_confirmacion IS NOT NULL THEN e.fecha_confirmacion + (cm.correction_days || ' days')::interval END
  FROM rutas ru, corr_map cm
  WHERE e.ruta_id = ru.id AND ru.empresa_id = v_empresa_id AND cm.entity_id = e.pedido_id;

  UPDATE devoluciones dv
  SET created_at = created_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm
  WHERE dv.empresa_id = v_empresa_id AND cm.entity_id = dv.pedido_id;

  UPDATE devoluciones_pos dp
  SET created_at = created_at + (cm.correction_days || ' days')::interval
  FROM corr_map cm
  WHERE dp.empresa_id = v_empresa_id AND cm.entity_id = dp.venta_pos_id;

  UPDATE whatsapp_mensajes m
  SET created_at = m.created_at + (cm.correction_days || ' days')::interval
  FROM whatsapp_conversaciones wc, corr_map cm
  WHERE m.conversacion_id = wc.id AND wc.empresa_id = v_empresa_id AND cm.entity_id = wc.id;

  UPDATE asistente_mensajes am
  SET creado_en = am.creado_en + (cm.correction_days || ' days')::interval
  FROM asistente_conversaciones ac, corr_map cm
  WHERE am.conversacion_id = ac.id AND ac.empresa_id = v_empresa_id AND cm.entity_id = ac.id;

  INSERT INTO corr_map
  SELECT ms2.id, (CURRENT_DATE - ((('x'||substr(md5(ms2.id::text),1,8))::bit(32)::bigint % 216)::int)) - ms2.created_at::date
  FROM movimientos_stock ms2
  JOIN productos p ON p.id = ms2.producto_id
  WHERE p.empresa_id = v_empresa_id
    AND ms2.referencia_id IS NULL
    AND ms2.id NOT IN (SELECT entity_id FROM corr_map);

  UPDATE movimientos_stock ms
  SET created_at = ms.created_at + (cm.correction_days || ' days')::interval
  FROM productos p, corr_map cm
  WHERE ms.producto_id = p.id AND p.empresa_id = v_empresa_id
    AND cm.entity_id = COALESCE(ms.referencia_id, ms.id);

END;
$function$;
