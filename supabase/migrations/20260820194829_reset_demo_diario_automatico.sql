-- ============================================================
-- 514 — Reset + redistribución de fechas del demo, automático y diario
-- ============================================================
--
-- CONTEXTO:
-- El demo público se mantenía a mano: `fn_reset_demo_cron()` ya existía
-- (v492) pero nunca se agendó en pg_cron, y `scripts/redistribuir-fechas-
-- demo.sql` (v610) se corría manualmente porque NO es idempotente —
-- correrlo dos veces sobre el mismo dataset vuelve a restar delta sobre
-- fechas ya corridas.
--
-- SOLUCIÓN:
-- El script de redistribución solo es no-idempotente porque asume que
-- arranca siempre desde el mismo estado base (las fechas originales de
-- carga). Esa condición es EXACTAMENTE lo que garantiza un reset previo
-- desde `demo_snapshots` (fn_reset_demo_v2). Entonces:
--
--   1. fn_redistribuir_fechas_demo(): misma lógica de v610, pero
--      convertida a función parametrizada por empresa_id (ya no hardcodea
--      el uuid) y pensada para correr SIEMPRE inmediatamente después de
--      un reset — nunca sobre datos que ya fueron redistribuidos antes.
--   2. fn_reset_demo_cron() ahora encadena: reset desde snapshot →
--      redistribuir fechas. Cada corrida parte de la misma foto fija,
--      así que el resultado de "hoy" no depende del de "ayer" — es
--      idempotente en la práctica aunque la función interna, tomada de
--      forma aislada, no lo sea.
--   3. Se agenda con pg_cron a las 05:00 (horario de bajo tráfico).
--
-- Se preserva toda la lógica de precedencia entre documentos relacionados
-- del script original (cta_cte/cobros/notas de crédito toman el delta de
-- su factura, entregas el de su pedido, etc.) — ver comentarios inline.

-- ------------------------------------------------------------
-- 1. fn_redistribuir_fechas_demo(p_empresa_id)
-- ------------------------------------------------------------
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

  -- Guard de seguridad: nunca tocar una empresa que no sea demo (mismo
  -- criterio que fn_reset_demo_v2).
  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  -- ============================================================
  -- BATCH 1: entidades raíz con delta propio (hash sobre su id)
  -- ============================================================
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

  -- ============================================================
  -- BATCH 2: facturas (delta propio); ventas_pos (delta del turno);
  -- recepciones/facturas_proveedor (delta de su orden de compra)
  -- ============================================================
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

  -- ============================================================
  -- BATCH 3: cta_cte y notas_credito (delta de su factura);
  -- pagos/ND a proveedor (delta de la OC vía su factura_proveedor);
  -- entregas (delta del pedido); devoluciones (delta del pedido /
  -- de la venta POS vía turno)
  --
  -- Nota: cta_cte.fecha_date es columna generada (GENERATED ALWAYS AS
  -- ... STORED) — no se puede escribir directo, se recalcula sola a
  -- partir de `fecha`.
  -- ============================================================
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

  -- ============================================================
  -- BATCH 4: cobranzas (delta propio)
  -- ============================================================
  UPDATE cobros c
  SET fecha = fecha - (d.delta || ' days')::interval
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM cobros WHERE empresa_id = v_empresa_id) d
  WHERE c.id = d.id;

  -- ============================================================
  -- BATCH 5: WhatsApp, asistente IA, puntos/fidelización, scoring,
  -- conciliación bancaria, export contable, push log (todas con
  -- delta propio, sin dependencia de otro documento)
  -- ============================================================
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

  -- ============================================================
  -- BATCH 6: movimientos_stock (delta de su documento de origen vía
  -- referencia_id — pedido, OC o venta POS; si no tiene referencia,
  -- delta propio). No tiene empresa_id directo, se llega vía producto.
  -- ============================================================
  UPDATE movimientos_stock ms
  SET created_at = created_at - (d.delta || ' days')::interval
  FROM (
    SELECT ms2.id, (('x'||substr(md5(COALESCE(ms2.referencia_id, ms2.id)::text),1,8))::bit(32)::bigint % 216) AS delta
    FROM movimientos_stock ms2
    JOIN productos p ON p.id = ms2.producto_id
    WHERE p.empresa_id = v_empresa_id
  ) d
  WHERE ms.id = d.id;

END;
$function$;

COMMENT ON FUNCTION public.fn_redistribuir_fechas_demo(uuid) IS
  'Redistribuye fechas de la empresa demo (delta 0-215 días, determinístico '
  'por hash de id, preserva precedencia entre documentos relacionados). '
  'IMPORTANTE: solo es idempotente si se corre inmediatamente después de '
  'restaurar desde demo_snapshots (fn_reset_demo_v2) — nunca sola, nunca '
  'dos veces seguidas sobre el mismo dataset. Ver fn_reset_demo_cron().';

-- ------------------------------------------------------------
-- 2. fn_reset_demo_cron(): ahora encadena reset → redistribución
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_reset_demo_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  v_empresa_id := (SELECT id FROM public.empresas WHERE es_demo = true LIMIT 1);
  IF v_empresa_id IS NULL THEN
    RAISE NOTICE 'fn_reset_demo_cron: no hay ninguna empresa demo — nada que resetear';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.demo_snapshots WHERE empresa_id = v_empresa_id) THEN
    -- Primera corrida: todavía no hay foto guardada. Se toma tal cual
    -- está ahora mismo (que ya debería tener fechas redistribuidas si se
    -- corrió v610 manualmente antes de esta migración) y queda como base
    -- fija para todas las corridas futuras.
    PERFORM public.fn_snapshot_demo_v2(v_empresa_id);
    RETURN;
  END IF;

  PERFORM public.fn_reset_demo_v2(v_empresa_id);
  PERFORM public.fn_redistribuir_fechas_demo(v_empresa_id);
END;
$function$;

COMMENT ON FUNCTION public.fn_reset_demo_cron() IS
  'Job diario del demo público: restaura desde demo_snapshots y redistribuye '
  'fechas (0/1/2026 con hasta hoy) para que gráficos y reportes no muestren '
  'todo apilado en el día de hoy. Agendado en pg_cron, ver más abajo.';

-- ------------------------------------------------------------
-- 3. Agendar en pg_cron (idempotente: solo si la extensión está
--    habilitada y el job no existe todavía — mismo patrón que 453).
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reset-demo-diario') THEN
      PERFORM cron.schedule(
        'reset-demo-diario',
        '0 5 * * *',
        'SELECT public.fn_reset_demo_cron()'
      );
    END IF;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Grants: mismo criterio que el resto de funciones de mantenimiento
--    del demo (492/290) — solo accesibles vía SECURITY DEFINER interno,
--    nunca desde anon/authenticated.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_redistribuir_fechas_demo(uuid) FROM PUBLIC, anon, authenticated;
