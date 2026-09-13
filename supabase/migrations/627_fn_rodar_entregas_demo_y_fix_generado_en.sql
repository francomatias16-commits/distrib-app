-- =============================================================
-- 627_fn_rodar_entregas_demo_y_fix_generado_en
-- (versión consolidada -- incluye el fix 627b sobre la unicidad
-- de pedido_id en estado activo, aplicado en el mismo día)
--
-- Reporta el usuario: en "Reporte de ruta" el mapa dice "Sin
-- ubicaciones GPS registradas" y "Detalle de entregas" dice "Sin
-- entregas registradas", a pesar de que las tarjetas KPI de arriba
-- (60%, 3 entregadas, 1 no entregada, 5 paradas...) sí muestran
-- números reales. El botón "Ver" del historial parece no hacer
-- nada.
--
-- Causa raíz (verificada en vivo contra la empresa demo): las
-- tarjetas KPI se leen de `reportes_ruta` (un resumen ya
-- calculado), pero el mapa y el detalle de entregas leen en vivo
-- la tabla `entregas` filtrando por ruta_id. De 111 rutas
-- "completada" con su resumen en `reportes_ruta`, solo 6 tenían
-- filas reales en `entregas` (25 en total) -- el resto del
-- historial de demo se sembró únicamente como agregados, sin el
-- detalle por parada. El botón "Ver" sí funciona -- selecciona la
-- ruta y recarga el detalle -- pero como el resultado (vacío) es
-- igual para casi cualquier ruta que se elija, da la sensación de
-- que no reacciona.
--
-- Fix 1 (fn_rodar_entregas_demo, nueva): para toda ruta con
-- reporte pero sin ninguna fila en `entregas`, siembra una fila
-- por parada (total_paradas), repartiendo los estados
-- entregado/no_entregado/pendiente según los contadores que ya
-- tiene guardados ese mismo reporte -- no se inventan números
-- nuevos, se completa el detalle que falta para los que ya existen.
-- Cada fila referencia un pedido real de la empresa (para que
-- cliente/dirección/coordenadas salgan de datos reales y no de
-- NULLs) -- aceptado que un mismo pedido pueda aparecer en más de
-- una ruta histórica, mismo trade-off de aproximación ya usado en
-- 605/606/607/625/626.
--
-- Fix de unicidad (incorporado -- ver 627b en el historial real de
-- aplicación): existe idx_entregas_pedido_activo_unico, un índice
-- único parcial sobre entregas(pedido_id) WHERE estado IN
-- ('pendiente','en_camino') -- un mismo pedido no puede tener dos
-- entregas "activas" a la vez. Con 150 paradas 'pendiente'
-- necesarias contra un pool de 96 pedidos válidos en esta empresa
-- demo, elegir pedido_id al azar CON reposición para 'pendiente'
-- revienta ese índice. Se arma un pool aparte para 'pendiente':
-- solo pedidos sin entrega activa existente, mezclado una sola vez
-- y consumido SIN reposición. Si se agota (como pasa hoy: 150
-- necesarias vs 96 libres), el excedente se siembra como
-- 'no_entregado' en su lugar (ese estado no tiene restricción de
-- unicidad) -- aceptado que el conteo de 'no_entregadas' del
-- detalle pueda quedar por encima de reportes_ruta.no_entregadas
-- para las rutas afectadas por el excedente, mismo criterio de
-- trade-off que el resto de estas funciones demo.
--
-- Fix 2 (fn_redistribuir_fechas_demo, agregado al final): sincroniza
-- `reportes_ruta.generado_en` con la `rutas.fecha` recién
-- actualizada de esa misma corrida. Antes quedaba clavado en la
-- fecha del snapshot original (ej. 2026-08-19) mientras `rutas.fecha`
-- se seguía actualizando cada 6h -- no es la causa del bug
-- reportado, pero es un drift real en la misma pantalla que iba a
-- confundir el filtro por fecha de "Reporte de ruta" más adelante.
--
-- Wiring: fn_rodar_entregas_demo se engancha en fn_reset_demo_cron
-- después de fn_redistribuir_fechas_demo (para partir de fechas de
-- ruta ya frescas) y antes de fn_rodar_pedidos_ciclos_demo (no hay
-- dependencia real entre ambas, pero mantiene el orden de "arreglar
-- fechas primero, sembrar detalle después" consistente con el
-- resto del cron).
--
-- Idempotente entre corridas: fn_reset_demo_v2 borra y restaura
-- `entregas` desde el snapshot (que solo trae las 25 filas
-- originales) antes de que esta función corra dentro del reset de
-- 6h -- cada ciclo parte de la misma base y no se acumulan filas de
-- más.
--
-- Verificado en vivo contra la empresa demo (Distribuidora del
-- Litoral): tras correr fn_rodar_entregas_demo() y
-- fn_redistribuir_fechas_demo(), las 108 rutas que no tenían
-- detalle pasaron a tenerlo (485 entregas totales, 118 rutas con
-- detalle, 0 rutas completadas sin él), sin violar el índice único,
-- y las 109 filas de reportes_ruta quedaron con generado_en
-- coincidiendo con la fecha de su ruta.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_rodar_entregas_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id      uuid;
  v_rec             RECORD;
  v_pedidos_pool    uuid[];
  v_pool_size       int;
  v_libres_pool     uuid[];
  v_libres_size     int;
  v_libres_idx      int := 1;
  v_pedido_id       uuid;
  v_estado_entrega  text;
  v_hora            timestamptz;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para rodar entregas';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  -- Pool general (con reposición): para 'entregado'/'no_entregado',
  -- que no tienen restricción de unicidad.
  SELECT ARRAY_AGG(id) INTO v_pedidos_pool
  FROM pedidos
  WHERE empresa_id = v_empresa_id
    AND estado IN ('entregado', 'confirmado', 'despachado');
  v_pool_size := COALESCE(array_length(v_pedidos_pool, 1), 0);
  IF v_pool_size = 0 THEN
    RETURN;
  END IF;

  -- Pool exclusivo (sin reposición) para 'pendiente': solo pedidos
  -- que hoy no tienen ya una entrega activa (pendiente/en_camino),
  -- mezclado una sola vez y consumido en orden -- ver cabecera.
  SELECT ARRAY_AGG(id) INTO v_libres_pool
  FROM (
    SELECT p.id
    FROM pedidos p
    WHERE p.empresa_id = v_empresa_id
      AND p.estado IN ('entregado', 'confirmado', 'despachado')
      AND NOT EXISTS (
        SELECT 1 FROM entregas e
        WHERE e.pedido_id = p.id AND e.estado IN ('pendiente', 'en_camino')
      )
    ORDER BY random()
  ) sub;
  v_libres_size := COALESCE(array_length(v_libres_pool, 1), 0);

  FOR v_rec IN
    SELECT
      r.id AS ruta_id,
      r.fecha,
      COALESCE(rr.total_paradas, 0)   AS total_paradas,
      COALESCE(rr.entregadas, 0)      AS entregadas,
      COALESCE(rr.no_entregadas, 0)   AS no_entregadas
    FROM rutas r
    JOIN reportes_ruta rr ON rr.ruta_id = r.id
    WHERE r.empresa_id = v_empresa_id
      AND COALESCE(rr.total_paradas, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM entregas e WHERE e.ruta_id = r.id)
  LOOP
    FOR i IN 1..v_rec.total_paradas LOOP
      v_estado_entrega := CASE
        WHEN i <= v_rec.entregadas                          THEN 'entregado'
        WHEN i <= v_rec.entregadas + v_rec.no_entregadas     THEN 'no_entregado'
        ELSE 'pendiente'
      END;

      IF v_estado_entrega = 'pendiente' THEN
        IF v_libres_idx <= v_libres_size THEN
          v_pedido_id := v_libres_pool[v_libres_idx];
          v_libres_idx := v_libres_idx + 1;
        ELSE
          -- Pool de libres agotado: no hay con qué mantener otra
          -- 'pendiente' sin violar la unicidad -- se siembra como
          -- 'no_entregado' en su lugar (ver cabecera).
          v_estado_entrega := 'no_entregado';
          v_pedido_id := v_pedidos_pool[1 + floor(random() * v_pool_size)::int];
        END IF;
      ELSE
        v_pedido_id := v_pedidos_pool[1 + floor(random() * v_pool_size)::int];
      END IF;

      -- Horario de la parada dentro de una jornada de reparto
      -- (arranca 9:00, ~25 min entre paradas).
      v_hora := v_rec.fecha::timestamptz + interval '9 hours' + ((i - 1) * interval '25 minutes');

      INSERT INTO entregas (ruta_id, pedido_id, orden, estado, fecha_confirmacion)
      VALUES (
        v_rec.ruta_id,
        v_pedido_id,
        i,
        v_estado_entrega,
        CASE WHEN v_estado_entrega IN ('entregado', 'no_entregado') THEN v_hora ELSE NULL END
      );
    END LOOP;
  END LOOP;
END;
$function$;

-- =============================================================
-- fn_redistribuir_fechas_demo: agrega sincronización de
-- reportes_ruta.generado_en al final (fix 2, ver cabecera). El
-- resto de la función queda idéntico a la versión vigente.
-- =============================================================
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
  SET created_at     = (now() - (d.delta || ' days')::interval),
      updated_at     = (now() - (GREATEST(d.delta - 2, 0) || ' days')::interval),
      fecha_pedido   = (now() - (d.delta || ' days')::interval),
      fecha_despacho = CASE WHEN fecha_despacho IS NOT NULL THEN (now() - (GREATEST(d.delta - 1, 0) || ' days')::interval) END,
      entregado_at   = CASE WHEN entregado_at IS NOT NULL THEN (now() - (GREATEST(d.delta - 2, 0) || ' days')::interval) END,
      fecha_entrega  = CASE WHEN fecha_entrega IS NOT NULL THEN (CURRENT_DATE - GREATEST(d.delta - 2, 0)) END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM pedidos WHERE empresa_id = v_empresa_id) d
  WHERE p.id = d.id;

  UPDATE ordenes_compra o
  SET created_at             = (now() - (d.delta || ' days')::interval),
      updated_at             = (now() - (GREATEST(d.delta - 2, 0) || ' days')::interval),
      fecha_pedido           = (now() - (d.delta || ' days')::interval),
      fecha_confirmacion_at  = CASE WHEN fecha_confirmacion_at IS NOT NULL THEN (now() - (GREATEST(d.delta - 1, 0) || ' days')::interval) END,
      fecha_esperada         = CASE WHEN fecha_esperada IS NOT NULL THEN (CURRENT_DATE - GREATEST(d.delta - 3, 0)) END,
      fecha_recepcion        = CASE WHEN fecha_recepcion IS NOT NULL THEN (now() - (GREATEST(d.delta - 3, 0) || ' days')::interval) END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM ordenes_compra WHERE empresa_id = v_empresa_id) d
  WHERE o.id = d.id;

  UPDATE turnos_caja t
  SET abierto_at = (now() - (d.delta || ' days')::interval),
      cerrado_at = CASE WHEN cerrado_at IS NOT NULL THEN (now() - (d.delta || ' days')::interval) + interval '9 hours' END
  FROM (SELECT tc.id, (('x'||substr(md5(tc.id::text),1,8))::bit(32)::bigint % 216)::integer AS delta
        FROM turnos_caja tc JOIN cajas_pos cp ON cp.id = tc.caja_id WHERE cp.empresa_id = v_empresa_id) d
  WHERE t.id = d.id;

  UPDATE rutas r
  SET created_at         = (now() - (d.delta || ' days')::interval),
      fecha              = (CURRENT_DATE - d.delta),
      chofer_actualizado = CASE WHEN chofer_actualizado IS NOT NULL THEN (now() - (d.delta || ' days')::interval) END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM rutas WHERE empresa_id = v_empresa_id) d
  WHERE r.id = d.id;

  UPDATE facturas f
  SET fecha_emision     = (now() - (d.delta || ' days')::interval),
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (CURRENT_DATE - d.delta + 30) END,
      vencimiento       = CASE WHEN vencimiento IS NOT NULL THEN (CURRENT_DATE - d.delta + 30) END,
      cae_vto           = CASE WHEN cae_vto IS NOT NULL THEN (CURRENT_DATE - d.delta + 10) END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM facturas WHERE empresa_id = v_empresa_id) d
  WHERE f.id = d.id;

  UPDATE ventas_pos v
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT vp.id, (('x'||substr(md5(vp.turno_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM ventas_pos vp WHERE vp.empresa_id = v_empresa_id) d
  WHERE v.id = d.id;

  UPDATE recepciones_mercaderia rm
  SET created_at    = (now() - (d.delta || ' days')::interval),
      confirmada_at = CASE WHEN confirmada_at IS NOT NULL THEN (now() - (d.delta || ' days')::interval) END
  FROM (SELECT r.id, (('x'||substr(md5(COALESCE(r.orden_id, r.id)::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM recepciones_mercaderia r WHERE r.empresa_id = v_empresa_id) d
  WHERE rm.id = d.id;

  UPDATE facturas_proveedor fp
  SET created_at        = (now() - (d.delta || ' days')::interval),
      updated_at        = (now() - (d.delta || ' days')::interval),
      fecha_factura      = CASE WHEN fecha_factura IS NOT NULL THEN (CURRENT_DATE - d.delta) END,
      fecha_vencimiento = CASE WHEN fecha_vencimiento IS NOT NULL THEN (CURRENT_DATE - d.delta) END
  FROM (SELECT f2.id, (('x'||substr(md5(f2.orden_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM facturas_proveedor f2 WHERE f2.empresa_id = v_empresa_id) d
  WHERE fp.id = d.id;

  UPDATE cta_cte c
  SET fecha      = (now() - (d.delta || ' days')::interval),
      updated_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT c2.id,
               COALESCE((('x'||substr(md5(c2.factura_id::text),1,8))::bit(32)::bigint % 216),
                        (('x'||substr(md5(c2.id::text),1,8))::bit(32)::bigint % 216))::integer AS delta
        FROM cta_cte c2 WHERE c2.empresa_id = v_empresa_id) d
  WHERE c.id = d.id;

  UPDATE notas_credito nc
  SET fecha_emision = (now() - (d.delta || ' days')::interval),
      cae_vto       = CASE WHEN cae_vto IS NOT NULL THEN (CURRENT_DATE - d.delta + 10) END,
      updated_at    = (now() - (d.delta || ' days')::interval),
      created_at    = (now() - (d.delta || ' days')::interval)
  FROM (SELECT n2.id,
               COALESCE((('x'||substr(md5(n2.factura_id::text),1,8))::bit(32)::bigint % 216),
                        (('x'||substr(md5(n2.id::text),1,8))::bit(32)::bigint % 216))::integer AS delta
        FROM notas_credito n2 WHERE n2.empresa_id = v_empresa_id) d
  WHERE nc.id = d.id;

  UPDATE pagos_proveedor pp
  SET created_at = (now() - (d.delta || ' days')::interval),
      fecha_pago = CASE WHEN fecha_pago IS NOT NULL THEN (CURRENT_DATE - d.delta) END
  FROM (SELECT p2.id, (('x'||substr(md5(fp.orden_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta
        FROM pagos_proveedor p2 JOIN facturas_proveedor fp ON fp.id = p2.factura_id WHERE p2.empresa_id = v_empresa_id) d
  WHERE pp.id = d.id;

  UPDATE notas_debito_proveedor nd
  SET created_at = (now() - (d.delta || ' days')::interval),
      updated_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT n2.id, (('x'||substr(md5(fp.orden_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta
        FROM notas_debito_proveedor n2 JOIN facturas_proveedor fp ON fp.id = n2.factura_id WHERE n2.empresa_id = v_empresa_id) d
  WHERE nd.id = d.id;

  UPDATE entregas e
  SET fecha_confirmacion = CASE WHEN fecha_confirmacion IS NOT NULL THEN (now() - (d.delta || ' days')::interval) END
  FROM (SELECT e2.id, (('x'||substr(md5(e2.pedido_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta
        FROM entregas e2 JOIN rutas ru ON ru.id = e2.ruta_id WHERE ru.empresa_id = v_empresa_id) d
  WHERE e.id = d.id;

  UPDATE devoluciones dv
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT id, (('x'||substr(md5(pedido_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM devoluciones WHERE empresa_id = v_empresa_id) d
  WHERE dv.id = d.id;

  UPDATE devoluciones_pos dp
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT d2.id, (('x'||substr(md5(vp.turno_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta
        FROM devoluciones_pos d2 JOIN ventas_pos vp ON vp.id = d2.venta_pos_id WHERE d2.empresa_id = v_empresa_id) d
  WHERE dp.id = d.id;

  UPDATE cobros c
  SET fecha = (now() - (d.delta || ' days')::interval)
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM cobros WHERE empresa_id = v_empresa_id) d
  WHERE c.id = d.id;

  UPDATE whatsapp_conversaciones w
  SET created_at          = (now() - (d.delta || ' days')::interval),
      tomada_en           = CASE WHEN tomada_en IS NOT NULL THEN (now() - (d.delta || ' days')::interval) END,
      turno_desde         = CASE WHEN turno_desde IS NOT NULL THEN (now() - (d.delta || ' days')::interval) END,
      ultima_interaccion  = CASE WHEN ultima_interaccion IS NOT NULL THEN (now() - (d.delta || ' days')::interval) END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM whatsapp_conversaciones WHERE empresa_id = v_empresa_id) d
  WHERE w.id = d.id;

  UPDATE whatsapp_mensajes m
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT m2.id, (('x'||substr(md5(m2.conversacion_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta
        FROM whatsapp_mensajes m2 JOIN whatsapp_conversaciones wc ON wc.id = m2.conversacion_id WHERE wc.empresa_id = v_empresa_id) d
  WHERE m.id = d.id;

  UPDATE asistente_conversaciones a
  SET creado_en      = (now() - (d.delta || ' days')::interval),
      actualizado_en = CASE WHEN actualizado_en IS NOT NULL THEN (now() - (d.delta || ' days')::interval) END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM asistente_conversaciones WHERE empresa_id = v_empresa_id) d
  WHERE a.id = d.id;

  UPDATE asistente_mensajes am
  SET creado_en = (now() - (d.delta || ' days')::interval)
  FROM (SELECT m2.id, (('x'||substr(md5(m2.conversacion_id::text),1,8))::bit(32)::bigint % 216)::integer AS delta
        FROM asistente_mensajes m2 JOIN asistente_conversaciones ac ON ac.id = m2.conversacion_id WHERE ac.empresa_id = v_empresa_id) d
  WHERE am.id = d.id;

  UPDATE movimientos_puntos mp
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM movimientos_puntos WHERE empresa_id = v_empresa_id) d
  WHERE mp.id = d.id;

  UPDATE scores_cliente sc
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM scores_cliente WHERE empresa_id = v_empresa_id) d
  WHERE sc.id = d.id;

  UPDATE alertas_score als
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM alertas_score WHERE empresa_id = v_empresa_id) d
  WHERE als.id = d.id;

  UPDATE conciliacion_bancaria_lotes cbl
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM conciliacion_bancaria_lotes WHERE empresa_id = v_empresa_id) d
  WHERE cbl.id = d.id;

  UPDATE export_contable_log ecl
  SET created_at  = (now() - (d.delta || ' days')::interval),
      fecha_desde = CASE WHEN fecha_desde IS NOT NULL THEN (CURRENT_DATE - d.delta) END,
      fecha_hasta = CASE WHEN fecha_hasta IS NOT NULL THEN (CURRENT_DATE - d.delta) END
  FROM (SELECT id, (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 216)::integer AS delta FROM export_contable_log WHERE empresa_id = v_empresa_id) d
  WHERE ecl.id = d.id;

  UPDATE push_log pl
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (SELECT pl2.id, (('x'||substr(md5(pl2.id::text),1,8))::bit(32)::bigint % 216)::integer AS delta
        FROM push_log pl2 JOIN usuarios u ON u.id = pl2.usuario_id WHERE u.empresa_id = v_empresa_id) d
  WHERE pl.id = d.id;

  UPDATE movimientos_stock ms
  SET created_at = (now() - (d.delta || ' days')::interval)
  FROM (
    SELECT ms2.id, (('x'||substr(md5(COALESCE(ms2.referencia_id, ms2.id)::text),1,8))::bit(32)::bigint % 216)::integer AS delta
    FROM movimientos_stock ms2
    JOIN productos p ON p.id = ms2.producto_id
    WHERE p.empresa_id = v_empresa_id
  ) d
  WHERE ms.id = d.id;

  UPDATE eventos_negocio en
  SET creado_en    = now() - (d.delta_dias || ' days')::interval - (d.delta_horas || ' hours')::interval,
      procesado_en = CASE WHEN en.procesado_en IS NOT NULL
                       THEN now() - (d.delta_dias || ' days')::interval - (d.delta_horas || ' hours')::interval + interval '3 minutes'
                       ELSE NULL END
  FROM (
    SELECT id,
      (CASE
        WHEN estado = 'error'      THEN (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 5) + 1
        WHEN estado = 'procesando' THEN 0
        ELSE (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 7)
      END)::integer AS delta_dias,
      (CASE
        WHEN estado = 'procesando' THEN (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 4)
        ELSE (('x'||substr(md5(id::text),1,8))::bit(32)::bigint % 20)
      END)::integer AS delta_horas
    FROM eventos_negocio WHERE empresa_id = v_empresa_id
  ) d
  WHERE en.id = d.id;

  -- ---------------------------------------------------------
  -- FIX 627: reportes_ruta.generado_en no se movía junto con
  -- rutas.fecha (quedaba clavado en la fecha del snapshot). Se
  -- sincroniza acá, al final, ya con rutas.fecha recién
  -- actualizada por el UPDATE de más arriba en esta misma función.
  -- Ancla al final del día de la ruta (20hs) para que quede
  -- después de cualquier fecha_confirmacion de esa misma jornada.
  -- ---------------------------------------------------------
  UPDATE reportes_ruta rr
  SET generado_en = r.fecha::timestamptz + interval '20 hours'
  FROM rutas r
  WHERE rr.ruta_id = r.id
    AND r.empresa_id = v_empresa_id;

END;
$function$;

-- Enganchar fn_rodar_entregas_demo en el reset periódico existente
-- (mismo cron demo_reset_periodico, cada 6h -- no se crea ningún
-- cron nuevo), después de fn_redistribuir_fechas_demo.
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
    PERFORM public.fn_snapshot_demo_v2(v_empresa_id);
    RETURN;
  END IF;

  PERFORM public.fn_reset_demo_v2(v_empresa_id);
  PERFORM public.fn_redistribuir_fechas_demo(v_empresa_id);
  -- FIX 627: entregas por parada para las rutas que solo tenían el
  -- resumen agregado en reportes_ruta — ver comentario arriba.
  PERFORM public.fn_rodar_entregas_demo(v_empresa_id);
  PERFORM public.fn_rodar_pedidos_ciclos_demo(v_empresa_id);
  PERFORM public.fn_generar_alertas_stock_autonomo(v_empresa_id);
  PERFORM public.fn_rodar_lotes_trigger_demo(v_empresa_id);
  PERFORM public.fn_rodar_cheques_demo(v_empresa_id);
  PERFORM public.fn_rodar_presupuestos_demo(v_empresa_id);
  PERFORM public.fn_rodar_reglas_precio_demo(v_empresa_id);
END;
$function$;
