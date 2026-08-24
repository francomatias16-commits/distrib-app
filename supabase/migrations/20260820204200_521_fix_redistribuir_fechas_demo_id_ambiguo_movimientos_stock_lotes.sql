-- ============================================================
-- 521 — Fix: fn_redistribuir_fechas_demo falla por columna "id" ambigua
--        en el UPDATE de movimientos_stock_lotes
-- ============================================================
--
-- CONTEXTO:
-- Al probar en vivo el pipeline completo tras 519/520,
-- fn_redistribuir_fechas_demo() falló:
--
--   ERROR: 42702: column reference "id" is ambiguous
--
-- El subquery de delta para movimientos_stock_lotes hace
-- "SELECT id, ..." sin calificar, pero el FROM une tres tablas
-- (msl2, ms, p) que tienen todas columna id — bug de tipeo introducido
-- en 519 (el resto de subqueries similares en este archivo sí calificaban
-- msl2.id correctamente en el UPDATE principal, pero no en este delta).
--
-- FIX: calificar como msl2.id.

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

  UPDATE pedidos p
  SET created_at     = created_at - (d.delta || ' days')::interval,
      updated_at     = updated_at - (d.delta || ' days')::interval,
      fecha_pedido   = fecha_pedido - (d.delta || ' days')::interval,
      fecha_despacho = CASE WHEN fecha_despacho IS NOT NULL THEN fecha_despacho - (d.delta || ' days')::interval END,
      entregado_at   = CASE WHEN entregado_at IS NOT NULL THEN entregado_at - (d.delta || ' days')::interval END,
      fecha_entrega  = CASE WHEN fecha_entrega IS NOT NULL THEN (fecha_entrega - (d.delta || ' days')::interval)::date END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM pedidos WHERE empresa_id = v_empresa_id) d
  WHERE p.id = d.id;

  UPDATE ordenes_compra o
  SET created_at             = created_at - (d.delta || ' days')::interval,
      updated_at             = updated_at - (d.delta || ' days')::interval,
      fecha_pedido           = fecha_pedido - (d.delta || ' days')::interval,
      fecha_confirmacion_at  = CASE WHEN fecha_confirmacion_at IS NOT NULL THEN fecha_confirmacion_at - (d.delta || ' days')::interval END,
      fecha_esperada         = CASE WHEN fecha_esperada IS NOT NULL THEN (fecha_esperada - (d.delta || ' days')::interval)::date END,
      fecha_recepcion        = CASE WHEN fecha_recepcion IS NOT NULL THEN fecha_recepcion - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM ordenes_compra WHERE empresa_id = v_empresa_id) d
  WHERE o.id = d.id;

  UPDATE turnos_caja t
  SET abierto_at = abierto_at - (d.delta || ' days')::interval,
      cerrado_at = CASE WHEN cerrado_at IS NOT NULL THEN cerrado_at - (d.delta || ' days')::interval END
  FROM (SELECT tc.id, (('x'||substr(md5(tc.id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM turnos_caja tc JOIN cajas_pos cp ON cp.id = tc.caja_id WHERE cp.empresa_id = v_empresa_id) d
  WHERE t.id = d.id;

  UPDATE rutas r
  SET created_at         = created_at - (d.delta || ' days')::interval,
      fecha              = (fecha - (d.delta || ' days')::interval)::date,
      chofer_actualizado = CASE WHEN chofer_actualizado IS NOT NULL THEN chofer_actualizado - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM rutas WHERE empresa_id = v_empresa_id) d
  WHERE r.id = d.id;

  UPDATE facturas f
  SET fecha_emision     = fecha_emision - (d.delta || ' days')::interval,
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (fecha_vencimiento - (d.delta||' days')::interval)::date END,
      vencimiento       = CASE WHEN vencimiento IS NOT NULL THEN (vencimiento - (d.delta||' days')::interval)::date END,
      cae_vto           = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto - (d.delta||' days')::interval)::date END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM facturas WHERE empresa_id = v_empresa_id) d
  WHERE f.id = d.id;

  UPDATE ventas_pos v
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT vp.id, (('x'||substr(md5(vp.turno_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM ventas_pos vp WHERE vp.empresa_id = v_empresa_id) d
  WHERE v.id = d.id;

  UPDATE recepciones_mercaderia rm
  SET created_at    = created_at - (d.delta || ' days')::interval,
      confirmada_at = CASE WHEN confirmada_at IS NOT NULL THEN confirmada_at - (d.delta || ' days')::interval END
  FROM (SELECT r.id, (('x'||substr(md5(r.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM recepciones_mercaderia r WHERE r.empresa_id = v_empresa_id) d
  WHERE rm.id = d.id;

  UPDATE facturas_proveedor fp
  SET created_at        = created_at - (d.delta || ' days')::interval,
      updated_at        = updated_at - (d.delta || ' days')::interval,
      fecha_factura      = CASE WHEN fecha_factura IS NOT NULL THEN (fecha_factura - (d.delta||' days')::interval)::date END,
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (fecha_vencimiento - (d.delta||' days')::interval)::date END
  FROM (SELECT f2.id, (('x'||substr(md5(f2.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM facturas_proveedor f2 WHERE f2.empresa_id = v_empresa_id) d
  WHERE fp.id = d.id;

  UPDATE cta_cte c
  SET fecha      = fecha - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval
  FROM (SELECT c2.id,
               COALESCE((('x'||substr(md5(c2.factura_id::text),1,8))::bit(32)::bigint % 216),
                        (('x'||substr(md5(c2.id::text),1,8))::bit(32)::bigint % 216)) AS delta
        FROM cta_cte c2 WHERE c2.empresa_id = v_empresa_id) d
  WHERE c.id = d.id;

  UPDATE notas_credito nc
  SET fecha_emision = fecha_emision - (d.delta || ' days')::interval,
      cae_vto       = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto - (d.delta||' days')::interval)::date END,
      updated_at    = updated_at - (d.delta || ' days')::interval,
      created_at    = created_at - (d.delta || ' days')::interval
  FROM (SELECT n2.id, (('x'||substr(md5(n2.factura_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM notas_credito n2 WHERE n2.empresa_id = v_empresa_id) d
  WHERE nc.id = d.id;

  UPDATE pagos_proveedor pp
  SET created_at = created_at - (d.delta || ' days')::interval,
      fecha_pago = CASE WHEN fecha_pago IS NOT NULL THEN (fecha_pago - (d.delta||' days')::interval)::date END
  FROM (SELECT p2.id, (('x'||substr(md5(fp.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM pagos_proveedor p2 JOIN facturas_proveedor fp ON fp.id = p2.factura_id WHERE p2.empresa_id = v_empresa_id) d
  WHERE pp.id = d.id;

  UPDATE notas_debito_proveedor nd
  SET created_at = created_at - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval
  FROM (SELECT n2.id, (('x'||substr(md5(fp.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM notas_debito_proveedor n2 JOIN facturas_proveedor fp ON fp.id = n2.factura_id WHERE n2.empresa_id = v_empresa_id) d
  WHERE nd.id = d.id;

  UPDATE entregas e
  SET fecha_confirmacion = CASE WHEN fecha_confirmacion IS NOT NULL THEN fecha_confirmacion - (d.delta || ' days')::interval END
  FROM (SELECT e2.id, (('x'||substr(md5(e2.pedido_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM entregas e2 JOIN rutas ru ON ru.id = e2.ruta_id WHERE ru.empresa_id = v_empresa_id) d
  WHERE e.id = d.id;

  UPDATE devoluciones dv
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(pedido_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM devoluciones WHERE empresa_id = v_empresa_id) d
  WHERE dv.id = d.id;

  UPDATE devoluciones_pos dp
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT d2.id, (('x'||substr(md5(vp.turno_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM devoluciones_pos d2 JOIN ventas_pos vp ON vp.id = d2.venta_pos_id WHERE d2.empresa_id = v_empresa_id) d
  WHERE dp.id = d.id;

  UPDATE cobros c
  SET fecha = fecha - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM cobros WHERE empresa_id = v_empresa_id) d
  WHERE c.id = d.id;

  UPDATE cobro_facturas_aplicadas cfa
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT c2.id,
               COALESCE((('x'||substr(md5(c2.factura_id::text),1,8))::bit(32)::bigint % 216),
                        (('x'||substr(md5(c2.id::text),1,8))::bit(32)::bigint % 216)) AS delta
        FROM cobro_facturas_aplicadas c2 WHERE c2.empresa_id = v_empresa_id) d
  WHERE cfa.id = d.id;

  UPDATE whatsapp_conversaciones w
  SET created_at          = created_at - (d.delta || ' days')::interval,
      tomada_en           = CASE WHEN tomada_en IS NOT NULL THEN tomada_en - (d.delta || ' days')::interval END,
      turno_desde         = CASE WHEN turno_desde IS NOT NULL THEN turno_desde - (d.delta || ' days')::interval END,
      ultima_interaccion  = CASE WHEN ultima_interaccion IS NOT NULL THEN ultima_interaccion - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM whatsapp_conversaciones WHERE empresa_id = v_empresa_id) d
  WHERE w.id = d.id;

  UPDATE whatsapp_mensajes m
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT m2.id, (('x'||substr(md5(m2.conversacion_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM whatsapp_mensajes m2 JOIN whatsapp_conversaciones wc ON wc.id = m2.conversacion_id WHERE wc.empresa_id = v_empresa_id) d
  WHERE m.id = d.id;

  UPDATE asistente_conversaciones a
  SET creado_en      = creado_en - (d.delta || ' days')::interval,
      actualizado_en = CASE WHEN actualizado_en IS NOT NULL THEN actualizado_en - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM asistente_conversaciones WHERE empresa_id = v_empresa_id) d
  WHERE a.id = d.id;

  UPDATE asistente_mensajes am
  SET creado_en = creado_en - (d.delta || ' days')::interval
  FROM (SELECT m2.id, (('x'||substr(md5(m2.conversacion_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM asistente_mensajes m2 JOIN asistente_conversaciones ac ON ac.id = m2.conversacion_id WHERE ac.empresa_id = v_empresa_id) d
  WHERE am.id = d.id;

  UPDATE movimientos_puntos mp
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM movimientos_puntos WHERE empresa_id = v_empresa_id) d
  WHERE mp.id = d.id;

  UPDATE scores_cliente sc
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM scores_cliente WHERE empresa_id = v_empresa_id) d
  WHERE sc.id = d.id;

  UPDATE alertas_score als
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM alertas_score WHERE empresa_id = v_empresa_id) d
  WHERE als.id = d.id;

  UPDATE conciliacion_bancaria_lotes cbl
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM conciliacion_bancaria_lotes WHERE empresa_id = v_empresa_id) d
  WHERE cbl.id = d.id;

  UPDATE export_contable_log ecl
  SET created_at  = created_at - (d.delta || ' days')::interval,
      fecha_desde = CASE WHEN fecha_desde IS NOT NULL THEN (fecha_desde - (d.delta||' days')::interval)::date END,
      fecha_hasta = CASE WHEN fecha_hasta IS NOT NULL THEN (fecha_hasta - (d.delta||' days')::interval)::date END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM export_contable_log WHERE empresa_id = v_empresa_id) d
  WHERE ecl.id = d.id;

  UPDATE push_log pl
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT pl2.id, (('x'||substr(md5(pl2.id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM push_log pl2 JOIN usuarios u ON u.id = pl2.usuario_id WHERE u.empresa_id = v_empresa_id) d
  WHERE pl.id = d.id;

  UPDATE movimientos_stock ms
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (
    SELECT ms2.id, (('x'||substr(md5(COALESCE(ms2.referencia_id, ms2.id)::text),1,8))::bit(32)::bigint % 216) AS delta
    FROM movimientos_stock ms2
    JOIN productos p ON p.id = ms2.producto_id
    WHERE p.empresa_id = v_empresa_id
  ) d
  WHERE ms.id = d.id;

  -- Nuevas: tablas agregadas al ciclo de snapshot en esta migración que
  -- tienen columnas de fecha propias.
  UPDATE saldo_puntos sp
  SET created_at = created_at - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval,
      ultimo_movimiento = CASE WHEN ultimo_movimiento IS NOT NULL THEN ultimo_movimiento - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM saldo_puntos WHERE empresa_id = v_empresa_id) d
  WHERE sp.id = d.id;

  UPDATE reglas_precio rp
  SET created_at  = created_at - (d.delta || ' days')::interval,
      updated_at  = updated_at - (d.delta || ' days')::interval,
      fecha_desde = CASE WHEN fecha_desde IS NOT NULL THEN (fecha_desde - (d.delta||' days')::interval)::date END,
      fecha_hasta = CASE WHEN fecha_hasta IS NOT NULL THEN (fecha_hasta - (d.delta||' days')::interval)::date END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM reglas_precio WHERE empresa_id = v_empresa_id) d
  WHERE rp.id = d.id;

  UPDATE conteos_stock cs
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM conteos_stock WHERE empresa_id = v_empresa_id) d
  WHERE cs.id = d.id;

  UPDATE proveedor_portal_tokens ppt
  SET creado_at     = creado_at - (d.delta || ' days')::interval,
      expira_at     = CASE WHEN expira_at IS NOT NULL THEN expira_at - (d.delta || ' days')::interval END,
      revocado_at   = CASE WHEN revocado_at IS NOT NULL THEN revocado_at - (d.delta || ' days')::interval END,
      ultimo_uso_at = CASE WHEN ultimo_uso_at IS NOT NULL THEN ultimo_uso_at - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM proveedor_portal_tokens WHERE empresa_id = v_empresa_id) d
  WHERE ppt.id = d.id;

  UPDATE producto_insumos pi
  SET created_at = created_at - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM producto_insumos WHERE empresa_id = v_empresa_id) d
  WHERE pi.id = d.id;

  UPDATE whatsapp_reset_codigos wrc
  SET created_at = created_at - (d.delta || ' days')::interval,
      expira_at  = CASE WHEN expira_at IS NOT NULL THEN expira_at - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM whatsapp_reset_codigos WHERE empresa_id = v_empresa_id) d
  WHERE wrc.id = d.id;

  UPDATE alertas_stock als2
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM alertas_stock WHERE empresa_id = v_empresa_id) d
  WHERE als2.id = d.id;

  UPDATE canjes_recompensas cr
  SET created_at  = created_at - (d.delta || ' days')::interval,
      aplicado_at = CASE WHEN aplicado_at IS NOT NULL THEN aplicado_at - (d.delta || ' days')::interval END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM canjes_recompensas WHERE empresa_id = v_empresa_id) d
  WHERE cr.id = d.id;

  UPDATE transacciones_pago tp
  SET created_at = created_at - (d.delta || ' days')::interval,
      updated_at = updated_at - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM transacciones_pago WHERE empresa_id = v_empresa_id) d
  WHERE tp.id = d.id;

  UPDATE movimientos_stock_lotes msl
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (SELECT msl2.id, (('x'||substr(md5(msl2.movimiento_stock_id::text),1,8))::bit(32)::bigint % 216) AS delta
        FROM movimientos_stock_lotes msl2
        JOIN movimientos_stock ms ON ms.id = msl2.movimiento_stock_id
        JOIN productos p ON p.id = ms.producto_id
        WHERE p.empresa_id = v_empresa_id) d
  WHERE msl.id = d.id;

END;
$function$;
