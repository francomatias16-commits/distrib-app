-- scripts/redistribuir-fechas-demo.sql
--
-- Redistribuye las fechas de todos los registros de la empresa demo
-- (empresa_id = '4462586e-e11a-4d34-a405-17103bb9cf9f', es_demo = true)
-- entre el 1/1/2026 y la fecha de ejecución, para que los gráficos y
-- reportes (ventas por mes, evolución de cta cte, etc.) muestren una
-- distribución realista en lugar de tener todo apilado en el día de hoy.
--
-- Se corrió manualmente contra el proyecto de Supabase (no es una
-- migración de esquema, no se registra en supabase_migrations). Se deja
-- documentado acá para poder repetirlo cuando se recargue el dataset
-- demo o se agreguen nuevas entidades a la semilla.
--
-- Estrategia: a cada fila se le resta un delta de 0 a 215 días, calculado
-- de forma determinística con hash MD5 sobre el id de la entidad "raíz"
-- del documento (pedido, orden de compra, factura, etc.). Las tablas
-- relacionadas (cta_cte, cobros, notas de crédito, entregas, recepciones,
-- movimientos de stock, devoluciones...) reusan el delta de su documento
-- padre (factura_id, pedido_id, orden_id, referencia_id, etc.) en vez de
-- calcular uno propio, así se preserva la precedencia entre documentos
-- (un cobro nunca puede quedar fechado antes que su factura).
--
-- Idempotente NO es -- correrlo dos veces vuelve a restar delta sobre las
-- fechas ya corridas. Pensado para ejecutarse una sola vez por carga de
-- datos demo (ver lib/demo-mode.js para el criterio de qué empresas son
-- demo).

\set empresa_demo '4462586e-e11a-4d34-a405-17103bb9cf9f'

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
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM pedidos WHERE empresa_id = :'empresa_demo') d
WHERE p.id = d.id;

UPDATE ordenes_compra o
SET created_at             = created_at - (d.delta || ' days')::interval,
    updated_at             = updated_at - (d.delta || ' days')::interval,
    fecha_pedido           = fecha_pedido - (d.delta || ' days')::interval,
    fecha_confirmacion_at  = CASE WHEN fecha_confirmacion_at IS NOT NULL THEN fecha_confirmacion_at - (d.delta || ' days')::interval END,
    fecha_esperada         = CASE WHEN fecha_esperada IS NOT NULL THEN (fecha_esperada - (d.delta || ' days')::interval)::date END,
    fecha_recepcion        = CASE WHEN fecha_recepcion IS NOT NULL THEN fecha_recepcion - (d.delta || ' days')::interval END
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM ordenes_compra WHERE empresa_id = :'empresa_demo') d
WHERE o.id = d.id;

UPDATE turnos_caja t
SET abierto_at = abierto_at - (d.delta || ' days')::interval,
    cerrado_at = CASE WHEN cerrado_at IS NOT NULL THEN cerrado_at - (d.delta || ' days')::interval END
FROM (SELECT tc.id, (('x'||substr(md5(tc.id::text),1,8))::bit(32)::bigint % 216) AS delta
      FROM turnos_caja tc JOIN cajas_pos cp ON cp.id = tc.caja_id WHERE cp.empresa_id = :'empresa_demo') d
WHERE t.id = d.id;

UPDATE rutas r
SET created_at         = created_at - (d.delta || ' days')::interval,
    fecha              = (fecha - (d.delta || ' days')::interval)::date,
    chofer_actualizado = CASE WHEN chofer_actualizado IS NOT NULL THEN chofer_actualizado - (d.delta || ' days')::interval END
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM rutas WHERE empresa_id = :'empresa_demo') d
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
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM facturas WHERE empresa_id = :'empresa_demo') d
WHERE f.id = d.id;

UPDATE ventas_pos v
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT vp.id, (('x'||substr(md5(vp.turno_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM ventas_pos vp WHERE vp.empresa_id = :'empresa_demo') d
WHERE v.id = d.id;

UPDATE recepciones_mercaderia rm
SET created_at    = created_at - (d.delta || ' days')::interval,
    confirmada_at = CASE WHEN confirmada_at IS NOT NULL THEN confirmada_at - (d.delta || ' days')::interval END
FROM (SELECT r.id, (('x'||substr(md5(r.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM recepciones_mercaderia r WHERE r.empresa_id = :'empresa_demo') d
WHERE rm.id = d.id;

UPDATE facturas_proveedor fp
SET created_at        = created_at - (d.delta || ' days')::interval,
    updated_at        = updated_at - (d.delta || ' days')::interval,
    fecha_factura      = CASE WHEN fecha_factura IS NOT NULL THEN (fecha_factura - (d.delta||' days')::interval)::date END,
    fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (fecha_vencimiento - (d.delta||' days')::interval)::date END
FROM (SELECT f2.id, (('x'||substr(md5(f2.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM facturas_proveedor f2 WHERE f2.empresa_id = :'empresa_demo') d
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
      FROM cta_cte c2 WHERE c2.empresa_id = :'empresa_demo') d
WHERE c.id = d.id;

UPDATE notas_credito nc
SET fecha_emision = fecha_emision - (d.delta || ' days')::interval,
    cae_vto       = CASE WHEN cae_vto IS NOT NULL THEN (cae_vto - (d.delta||' days')::interval)::date END,
    updated_at    = updated_at - (d.delta || ' days')::interval,
    created_at    = created_at - (d.delta || ' days')::interval
FROM (SELECT n2.id, (('x'||substr(md5(n2.factura_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM notas_credito n2 WHERE n2.empresa_id = :'empresa_demo') d
WHERE nc.id = d.id;

UPDATE pagos_proveedor pp
SET created_at = created_at - (d.delta || ' days')::interval,
    fecha_pago = CASE WHEN fecha_pago IS NOT NULL THEN (fecha_pago - (d.delta||' days')::interval)::date END
FROM (SELECT p2.id, (('x'||substr(md5(fp.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta
      FROM pagos_proveedor p2 JOIN facturas_proveedor fp ON fp.id = p2.factura_id WHERE p2.empresa_id = :'empresa_demo') d
WHERE pp.id = d.id;

UPDATE notas_debito_proveedor nd
SET created_at = created_at - (d.delta || ' days')::interval,
    updated_at = updated_at - (d.delta || ' days')::interval
FROM (SELECT n2.id, (('x'||substr(md5(fp.orden_id::text),1,8))::bit(32)::bigint % 216) AS delta
      FROM notas_debito_proveedor n2 JOIN facturas_proveedor fp ON fp.id = n2.factura_id WHERE n2.empresa_id = :'empresa_demo') d
WHERE nd.id = d.id;

UPDATE entregas e
SET fecha_confirmacion = CASE WHEN fecha_confirmacion IS NOT NULL THEN fecha_confirmacion - (d.delta || ' days')::interval END
FROM (SELECT e2.id, (('x'||substr(md5(e2.pedido_id::text),1,8))::bit(32)::bigint % 216) AS delta
      FROM entregas e2 JOIN rutas ru ON ru.id = e2.ruta_id WHERE ru.empresa_id = :'empresa_demo') d
WHERE e.id = d.id;

UPDATE devoluciones dv
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT id, (('x'||substr(md5(pedido_id::text),1,8))::bit(32)::bigint % 216) AS delta FROM devoluciones WHERE empresa_id = :'empresa_demo') d
WHERE dv.id = d.id;

UPDATE devoluciones_pos dp
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT d2.id, (('x'||substr(md5(vp.turno_id::text),1,8))::bit(32)::bigint % 216) AS delta
      FROM devoluciones_pos d2 JOIN ventas_pos vp ON vp.id = d2.venta_pos_id WHERE d2.empresa_id = :'empresa_demo') d
WHERE dp.id = d.id;

-- ============================================================
-- BATCH 4: cobranzas (delta propio)
-- ============================================================
UPDATE cobros c
SET fecha = fecha - (d.delta || ' days')::interval
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM cobros WHERE empresa_id = :'empresa_demo') d
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
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM whatsapp_conversaciones WHERE empresa_id = :'empresa_demo') d
WHERE w.id = d.id;

UPDATE whatsapp_mensajes m
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT m2.id, (('x'||substr(md5(m2.conversacion_id::text),1,8))::bit(32)::bigint % 216) AS delta
      FROM whatsapp_mensajes m2 JOIN whatsapp_conversaciones wc ON wc.id = m2.conversacion_id WHERE wc.empresa_id = :'empresa_demo') d
WHERE m.id = d.id;

UPDATE asistente_conversaciones a
SET creado_en      = creado_en - (d.delta || ' days')::interval,
    actualizado_en = CASE WHEN actualizado_en IS NOT NULL THEN actualizado_en - (d.delta || ' days')::interval END
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM asistente_conversaciones WHERE empresa_id = :'empresa_demo') d
WHERE a.id = d.id;

UPDATE asistente_mensajes am
SET creado_en = creado_en - (d.delta || ' days')::interval
FROM (SELECT m2.id, (('x'||substr(md5(m2.conversacion_id::text),1,8))::bit(32)::bigint % 216) AS delta
      FROM asistente_mensajes m2 JOIN asistente_conversaciones ac ON ac.id = m2.conversacion_id WHERE ac.empresa_id = :'empresa_demo') d
WHERE am.id = d.id;

UPDATE movimientos_puntos mp
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM movimientos_puntos WHERE empresa_id = :'empresa_demo') d
WHERE mp.id = d.id;

UPDATE scores_cliente sc
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM scores_cliente WHERE empresa_id = :'empresa_demo') d
WHERE sc.id = d.id;

UPDATE alertas_score als
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM alertas_score WHERE empresa_id = :'empresa_demo') d
WHERE als.id = d.id;

UPDATE conciliacion_bancaria_lotes cbl
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM conciliacion_bancaria_lotes WHERE empresa_id = :'empresa_demo') d
WHERE cbl.id = d.id;

UPDATE export_contable_log ecl
SET created_at  = created_at - (d.delta || ' days')::interval,
    fecha_desde = CASE WHEN fecha_desde IS NOT NULL THEN (fecha_desde - (d.delta||' days')::interval)::date END,
    fecha_hasta = CASE WHEN fecha_hasta IS NOT NULL THEN (fecha_hasta - (d.delta||' days')::interval)::date END
FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216) AS delta FROM export_contable_log WHERE empresa_id = :'empresa_demo') d
WHERE ecl.id = d.id;

UPDATE push_log pl
SET created_at = created_at - (d.delta || ' days')::interval
FROM (SELECT pl2.id, (('x'||substr(md5(pl2.id::text),1,8))::bit(32)::bigint % 216) AS delta
      FROM push_log pl2 JOIN usuarios u ON u.id = pl2.usuario_id WHERE u.empresa_id = :'empresa_demo') d
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
  WHERE p.empresa_id = :'empresa_demo'
) d
WHERE ms.id = d.id;

-- ============================================================
-- Chequeo de integridad post-corrida: no debería haber cobros
-- fechados antes que su factura.
-- ============================================================
-- select count(*) FROM cta_cte c JOIN facturas f ON f.id = c.factura_id
-- WHERE c.empresa_id = :'empresa_demo' AND c.fecha < f.fecha_emision;
-- (debe dar 0)
