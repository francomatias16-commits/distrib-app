-- 492_track_funciones_fantasma_etapa5.sql
--
-- ETAPA 5 del plan de auditoría (pase manual): además de correr los checks
-- estáticos que ya tiene el repo (check-api-wiring, check-handler-dispatch,
-- check-asset-wiring, check-migraciones-registro, smoke-test-frontend —
-- todos OK), se corrió audit-funciones-fantasma.js contra la base real
-- (vía audit_funciones_vivas(), migración 249) comparando contra los
-- CREATE FUNCTION de supabase/migrations/.
--
-- Resultado: 34 funciones fantasma — viven en public pero NINGÚN archivo de
-- migración las crea. Si algún día se hace `supabase db reset` o se
-- reconstruye el proyecto desde los migrations del repo, estas 34 NO
-- volverían a existir. Mismo caso que forzar_cierre_turno_caja (mencionada
-- en la migración 249 como "trackeada recién en la 241") — pero esa
-- migración 241 tampoco existe en este repo (salto real: ...240, 242...,
-- sin 241 ni 250/251). O sea, la referencia a "trackeada en 241" quedó
-- desactualizada/rota; forzar_cierre_turno_caja seguía siendo fantasma
-- hasta esta migración.
--
-- Esta migración NO cambia ningún comportamiento — es CREATE OR REPLACE
-- con la definición EXACTA que hoy vive en producción (capturada con
-- pg_get_functiondef). Es puramente de trazabilidad.
--
-- Dos de las 34 (conciliar_lote_bancario, conciliar_movimiento_manual)
-- parecen ser una implementación vieja del motor de conciliación bancaria,
-- superseded por conciliacion_auto_matchear_lote / conciliacion_confirmar_match
-- (etapa 3 de esta auditoría) — ningún handler ni repo del código actual
-- las llama. Se trackean igual (sin decidir un DROP unilateral).

CREATE OR REPLACE FUNCTION public.analizar_stock_predictivo(p_empresa_id uuid)
 RETURNS TABLE(producto_id uuid, nombre text, stock_actual numeric, cantidad_reservada numeric, stock_disponible numeric, demanda_comprometida numeric, oferta_en_camino numeric, fecha_prox_oc date, stock_neto numeric, velocidad_dia numeric, dias_hasta_quiebre numeric, punto_pedido_clasico numeric, punto_pedido_pred numeric, necesita_reponer boolean, urgencia text, cantidad_sugerida numeric, lead_time integer, proveedor_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  RETURN QUERY
  WITH
  ventas_30d AS (
    SELECT
      pi2.producto_id,
      SUM(pi2.cantidad) / 30.0 AS vel_dia
    FROM pedido_items pi2
    JOIN pedidos ped ON ped.id = pi2.pedido_id
    WHERE ped.empresa_id = p_empresa_id
      AND ped.estado IN ('entregado', 'despachado')
      AND ped.fecha_pedido >= now() - INTERVAL '30 days'
    GROUP BY pi2.producto_id
  ),
  stock_fisico AS (
    SELECT
      s.producto_id,
      SUM(s.cantidad)::numeric                                     AS cantidad_total,
      SUM(COALESCE(s.cantidad_reservada, 0))::numeric               AS reservada_total,
      SUM(s.cantidad - COALESCE(s.cantidad_reservada, 0))::numeric  AS disponible_total
    FROM stock s
    JOIN depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
    GROUP BY s.producto_id
  ),
  demanda_activa AS (
    SELECT
      pi2.producto_id,
      SUM(pi2.cantidad - COALESCE(pi2.cantidad_entregada, 0))::numeric AS comprometido
    FROM pedido_items pi2
    JOIN pedidos ped ON ped.id = pi2.pedido_id
    WHERE ped.empresa_id = p_empresa_id
      AND ped.estado IN ('confirmado', 'preparando')
    GROUP BY pi2.producto_id
  ),
  oc_en_camino AS (
    SELECT
      oci.producto_id,
      SUM(oci.cantidad - COALESCE(oci.cantidad_recibida, 0))::numeric AS en_camino,
      MIN(oc.fecha_esperada)                                          AS prox_fecha_oc
    FROM ordenes_compra_items oci
    JOIN ordenes_compra oc ON oc.id = oci.orden_id
    WHERE oc.empresa_id = p_empresa_id
      AND oc.estado IN ('enviada', 'confirmada')
      AND (oci.cantidad - COALESCE(oci.cantidad_recibida, 0)) > 0
    GROUP BY oci.producto_id
  )
  SELECT
    p.id                                                      AS producto_id,
    p.nombre                                                  AS nombre,
    COALESCE(sf.cantidad_total, 0)                            AS stock_actual,
    COALESCE(sf.reservada_total, 0)                           AS cantidad_reservada,
    COALESCE(sf.disponible_total, 0)                          AS stock_disponible,
    COALESCE(da.comprometido, 0)                              AS demanda_comprometida,
    COALESCE(oc.en_camino, 0)                                 AS oferta_en_camino,
    oc.prox_fecha_oc                                          AS fecha_prox_oc,
    GREATEST(0,
      COALESCE(sf.disponible_total, 0)
      - COALESCE(da.comprometido, 0)
      + COALESCE(oc.en_camino, 0)
    )                                                         AS stock_neto,
    COALESCE(v.vel_dia, 0)                                    AS velocidad_dia,
    CASE
      WHEN COALESCE(v.vel_dia, 0) > 0
        THEN GREATEST(0,
               (COALESCE(sf.disponible_total, 0)
                - COALESCE(da.comprometido, 0)
                + COALESCE(oc.en_camino, 0))
               / v.vel_dia
             )
      ELSE 999
    END                                                       AS dias_hasta_quiebre,
    ROUND(COALESCE(v.vel_dia, 0) * COALESCE(p.lead_time_dias, 7), 2)
                                                              AS punto_pedido_clasico,
    ROUND(COALESCE(v.vel_dia, 0) * (COALESCE(p.lead_time_dias, 7) + 7), 2)
                                                              AS punto_pedido_pred,
    (
      GREATEST(0,
        COALESCE(sf.disponible_total, 0)
        - COALESCE(da.comprometido, 0)
        + COALESCE(oc.en_camino, 0)
      )
      <= ROUND(COALESCE(v.vel_dia, 0) * (COALESCE(p.lead_time_dias, 7) + 7), 2)
    )                                                         AS necesita_reponer,
    CASE
      WHEN COALESCE(v.vel_dia, 0) = 0 THEN 'ok'
      WHEN (
          GREATEST(0,
            COALESCE(sf.disponible_total, 0)
            - COALESCE(da.comprometido, 0)
            + COALESCE(oc.en_camino, 0)
          ) / NULLIF(v.vel_dia, 0)
        ) <= COALESCE(p.lead_time_dias, 7)
        THEN 'critico'
      WHEN (
          GREATEST(0,
            COALESCE(sf.disponible_total, 0)
            - COALESCE(da.comprometido, 0)
            + COALESCE(oc.en_camino, 0)
          ) / NULLIF(v.vel_dia, 0)
        ) <= (COALESCE(p.lead_time_dias, 7) + 7)
        THEN 'urgente'
      WHEN (
          GREATEST(0,
            COALESCE(sf.disponible_total, 0)
            - COALESCE(da.comprometido, 0)
            + COALESCE(oc.en_camino, 0)
          ) / NULLIF(v.vel_dia, 0)
        ) <= (COALESCE(p.lead_time_dias, 7) + 14)
        THEN 'planificar'
      ELSE 'ok'
    END                                                       AS urgencia,
    GREATEST(0,
      COALESCE(p.stock_objetivo,
        COALESCE(v.vel_dia, 0) * 30, 0)
      - GREATEST(0,
          COALESCE(sf.disponible_total, 0)
          - COALESCE(da.comprometido, 0)
          + COALESCE(oc.en_camino, 0)
        )
    )                                                         AS cantidad_sugerida,
    COALESCE(p.lead_time_dias, 7)                             AS lead_time,
    p.proveedor_id_default                                    AS proveedor_id
  FROM productos p
  LEFT JOIN stock_fisico   sf ON sf.producto_id = p.id
  LEFT JOIN ventas_30d      v  ON v.producto_id  = p.id
  LEFT JOIN demanda_activa  da ON da.producto_id = p.id
  LEFT JOIN oc_en_camino    oc ON oc.producto_id = p.id
  WHERE p.empresa_id = p_empresa_id
    AND p.activo = true
  ORDER BY
    CASE
      WHEN COALESCE(v.vel_dia, 0) = 0 THEN 999
      ELSE GREATEST(0,
             COALESCE(sf.disponible_total, 0)
             - COALESCE(da.comprometido, 0)
             + COALESCE(oc.en_camino, 0)
           ) / NULLIF(v.vel_dia, 0)
    END ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.asentar_movimiento_cta_cte_factura(p_factura_id uuid, p_tipo text, p_monto numeric, p_descripcion text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_factura record;
BEGIN
  IF p_tipo NOT IN ('debito','credito') THEN
    RETURN json_build_object('ok', false, 'error', 'Tipo inválido, debe ser debito o credito');
  END IF;

  SELECT id, empresa_id, cliente_id INTO v_factura
  FROM facturas WHERE id = p_factura_id;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Factura no encontrada');
  END IF;

  IF v_factura.cliente_id IS NULL THEN
    RETURN json_build_object('ok', true, 'skip', 'sin_cliente');
  END IF;

  IF auth.role() <> 'service_role' AND v_factura.empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF EXISTS (SELECT 1 FROM cta_cte WHERE factura_id = p_factura_id AND tipo = p_tipo) THEN
    RETURN json_build_object('ok', true, 'skip', 'ya_registrado');
  END IF;

  INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, factura_id, descripcion, fecha)
  VALUES (v_factura.empresa_id, v_factura.cliente_id, p_tipo, p_monto, p_factura_id, p_descripcion, now());

  RETURN json_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END; $function$;

CREATE OR REPLACE FUNCTION public.chofer_clientes_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT p.cliente_id
  FROM pedidos p
  JOIN ruta_items ri ON ri.pedido_id = p.id
  JOIN rutas r ON r.id = ri.ruta_id
  WHERE r.chofer_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.conciliar_lote_bancario(p_lote_id uuid)
 RETURNS TABLE(movimientos_procesados integer, conciliados_automatico integer, sin_match integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_mov record;
  v_match record;
  v_total integer := 0;
  v_ok integer := 0;
  v_sin integer := 0;
BEGIN
  SELECT empresa_id INTO v_empresa_id FROM conciliacion_bancaria_lotes WHERE id = p_lote_id;
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'Lote % no existe', p_lote_id;
  END IF;

  FOR v_mov IN
    SELECT * FROM conciliacion_bancaria_movimientos
    WHERE lote_id = p_lote_id AND estado = 'pendiente'
    ORDER BY fecha
  LOOP
    v_total := v_total + 1;

    IF v_mov.tipo = 'credito' THEN
      SELECT c.id, c.fecha INTO v_match
      FROM cobros c
      WHERE c.empresa_id = v_empresa_id
        AND c.medio IN ('transferencia', 'cheque')
        AND c.conciliado_bancario = false
        AND c.monto = v_mov.monto
        AND ABS(c.fecha::date - v_mov.fecha) <= 3
      ORDER BY ABS(c.fecha::date - v_mov.fecha)
      LIMIT 1;

      IF v_match.id IS NOT NULL THEN
        UPDATE conciliacion_bancaria_movimientos
        SET estado = 'conciliado', cobro_id = v_match.id, conciliado_en = now(), updated_at = now()
        WHERE id = v_mov.id;
        UPDATE cobros SET conciliado_bancario = true WHERE id = v_match.id;
        v_ok := v_ok + 1;
      ELSE
        UPDATE conciliacion_bancaria_movimientos SET estado = 'sin_match', updated_at = now() WHERE id = v_mov.id;
        v_sin := v_sin + 1;
      END IF;
    ELSE
      UPDATE conciliacion_bancaria_movimientos SET estado = 'sin_match', updated_at = now() WHERE id = v_mov.id;
      v_sin := v_sin + 1;
    END IF;
  END LOOP;

  UPDATE conciliacion_bancaria_lotes
  SET cantidad_conciliados = (SELECT COUNT(*) FROM conciliacion_bancaria_movimientos WHERE lote_id = p_lote_id AND estado = 'conciliado')
  WHERE id = p_lote_id;

  RETURN QUERY SELECT v_total, v_ok, v_sin;
END;
$function$;

CREATE OR REPLACE FUNCTION public.conciliar_movimiento_manual(p_movimiento_id uuid, p_cobro_id uuid, p_usuario_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE conciliacion_bancaria_movimientos
  SET estado = 'conciliado_manual',
      cobro_id = p_cobro_id,
      conciliado_en = now(),
      conciliado_por = p_usuario_id,
      updated_at = now()
  WHERE id = p_movimiento_id;

  UPDATE cobros SET conciliado_bancario = true WHERE id = p_cobro_id;

  UPDATE conciliacion_bancaria_lotes l
  SET cantidad_conciliados = (
    SELECT COUNT(*) FROM conciliacion_bancaria_movimientos m
    WHERE m.lote_id = l.id AND m.estado IN ('conciliado', 'conciliado_manual')
  )
  WHERE l.id = (SELECT lote_id FROM conciliacion_bancaria_movimientos WHERE id = p_movimiento_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.crear_notif_prefs_auto_default()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.notif_prefs_auto (empresa_id)
  VALUES (NEW.id)
  ON CONFLICT (empresa_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.desactivar_oferta_liquidacion(p_empresa_id uuid, p_oferta_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  UPDATE ofertas_liquidacion SET
    activa = false,
    desactivada_at = NOW(),
    razon_desactivacion = 'desactivacion_manual'
  WHERE id = p_oferta_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Oferta no encontrada');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.exportar_contable(p_empresa_id uuid, p_tipo text, p_desde date, p_hasta date, p_usuario_id uuid, p_proveedor text DEFAULT 'generico_csv'::text)
 RETURNS TABLE(fecha date, comprobante text, cuenta text, descripcion text, debe numeric, haber numeric, origen_tipo text, origen_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  IF p_tipo NOT IN ('ventas','compras','cobranzas') THEN
    RAISE EXCEPTION 'tipo inválido: % (debe ser ventas, compras o cobranzas)', p_tipo;
  END IF;

  CREATE TEMP TABLE _export_tmp ON COMMIT DROP AS
  SELECT * FROM (
    SELECT * FROM generar_asientos_ventas(p_empresa_id, p_desde, p_hasta) WHERE p_tipo = 'ventas'
    UNION ALL
    SELECT * FROM generar_asientos_compras(p_empresa_id, p_desde, p_hasta) WHERE p_tipo = 'compras'
    UNION ALL
    SELECT * FROM generar_asientos_cobranzas(p_empresa_id, p_desde, p_hasta) WHERE p_tipo = 'cobranzas'
  ) x;

  SELECT COUNT(*) INTO v_count FROM _export_tmp;

  INSERT INTO export_contable_log (id, empresa_id, proveedor, tipo, fecha_desde, fecha_hasta, cantidad_registros, usuario_id, archivo_nombre)
  VALUES (gen_random_uuid(), p_empresa_id, p_proveedor, p_tipo, p_desde, p_hasta, v_count, p_usuario_id,
          'export_contable_' || p_tipo || '_' || p_desde || '_' || p_hasta || '.csv');

  RETURN QUERY SELECT * FROM _export_tmp;
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_audit_generic()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.registrar_auditoria(
      TG_TABLE_NAME, 'INSERT', NEW.id::UUID, NULL, to_jsonb(NEW)
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
      PERFORM public.registrar_auditoria(
        TG_TABLE_NAME, 'UPDATE', NEW.id::UUID, to_jsonb(OLD), to_jsonb(NEW)
      );
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.registrar_auditoria(
      TG_TABLE_NAME, 'DELETE', OLD.id::UUID, to_jsonb(OLD), NULL
    );
  END IF;
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_caja_deposito_requerido()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.deposito_id IS NULL THEN
    RAISE EXCEPTION
      'No se puede guardar la caja "%" sin un depósito asignado.', NEW.nombre;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_rate_limit_check(p_clave text, p_max integer, p_ventana_ms integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ahora     timestamptz := clock_timestamp();
  v_contador  integer;
BEGIN
  IF p_clave IS NULL OR p_max IS NULL OR p_ventana_ms IS NULL THEN
    RETURN true;
  END IF;

  INSERT INTO public.api_rate_limits AS t (clave, contador, ventana_inicio)
  VALUES (p_clave, 1, v_ahora)
  ON CONFLICT (clave) DO UPDATE SET
    contador = CASE
      WHEN t.ventana_inicio + make_interval(secs => p_ventana_ms / 1000.0) <= v_ahora
        THEN 1
      ELSE t.contador + 1
    END,
    ventana_inicio = CASE
      WHEN t.ventana_inicio + make_interval(secs => p_ventana_ms / 1000.0) <= v_ahora
        THEN v_ahora
      ELSE t.ventana_inicio
    END
  RETURNING contador INTO v_contador;

  IF random() < 0.01 THEN
    DELETE FROM public.api_rate_limits
    WHERE ventana_inicio < v_ahora - interval '1 hour';
  END IF;

  RETURN v_contador <= p_max;
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_reset_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_datos jsonb;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para resetear';
  END IF;

  SELECT datos INTO v_datos FROM demo_snapshots WHERE empresa_id = v_empresa_id;
  IF v_datos IS NULL THEN
    RAISE EXCEPTION 'No existe snapshot para la empresa %. Corré fn_snapshot_demo() primero.', v_empresa_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  UPDATE pedidos SET factura_id = NULL WHERE empresa_id = v_empresa_id;

  DELETE FROM cta_cte WHERE empresa_id = v_empresa_id;
  DELETE FROM cheques WHERE empresa_id = v_empresa_id;
  DELETE FROM pedido_items WHERE pedido_id IN (SELECT id FROM pedidos WHERE empresa_id = v_empresa_id);
  DELETE FROM facturas WHERE empresa_id = v_empresa_id;
  DELETE FROM pedidos WHERE empresa_id = v_empresa_id;
  DELETE FROM stock WHERE producto_id IN (SELECT id FROM productos WHERE empresa_id = v_empresa_id);
  DELETE FROM productos WHERE empresa_id = v_empresa_id;
  DELETE FROM clientes WHERE empresa_id = v_empresa_id;
  DELETE FROM categorias WHERE empresa_id = v_empresa_id;
  DELETE FROM depositos WHERE empresa_id = v_empresa_id;
  DELETE FROM zonas WHERE empresa_id = v_empresa_id;
  DELETE FROM facturacion_config WHERE empresa_id = v_empresa_id;

  INSERT INTO facturacion_config SELECT * FROM jsonb_populate_recordset(NULL::facturacion_config, v_datos->'facturacion_config');
  INSERT INTO zonas               SELECT * FROM jsonb_populate_recordset(NULL::zonas, v_datos->'zonas');
  INSERT INTO depositos           SELECT * FROM jsonb_populate_recordset(NULL::depositos, v_datos->'depositos');
  INSERT INTO categorias          SELECT * FROM jsonb_populate_recordset(NULL::categorias, v_datos->'categorias');
  INSERT INTO productos           SELECT * FROM jsonb_populate_recordset(NULL::productos, v_datos->'productos');
  INSERT INTO stock                SELECT * FROM jsonb_populate_recordset(NULL::stock, v_datos->'stock');

  INSERT INTO clientes (
    id, empresa_id, razon_social, nombre_fantasia, cuit, condicion_iva, domicilio, localidad,
    zona_id, telefono, email, lista_precio_id, limite_credito, dias_credito, activo, notas,
    created_at, score_actual, score_categoria, lat, lng, score_actualizado, saldo_deuda,
    usuario_id, bloqueado, bloqueado_motivo, saldo_cuenta_corriente, updated_at, vendedor_id_default
  )
  SELECT
    id, empresa_id, razon_social, nombre_fantasia, cuit, condicion_iva, domicilio, localidad,
    zona_id, telefono, email, lista_precio_id, limite_credito, dias_credito, activo, notas,
    created_at, score_actual, score_categoria, lat, lng, score_actualizado, saldo_deuda,
    usuario_id, bloqueado, bloqueado_motivo, saldo_cuenta_corriente, updated_at, vendedor_id_default
  FROM jsonb_populate_recordset(NULL::clientes, v_datos->'clientes');

  INSERT INTO pedidos
  SELECT * FROM jsonb_populate_recordset(
    NULL::pedidos,
    (SELECT jsonb_agg(elem - 'factura_id') FROM jsonb_array_elements(v_datos->'pedidos') elem)
  );

  INSERT INTO pedido_items SELECT * FROM jsonb_populate_recordset(NULL::pedido_items, v_datos->'pedido_items');

  INSERT INTO facturas
  SELECT * FROM jsonb_populate_recordset(
    NULL::facturas,
    (SELECT jsonb_agg(elem - 'factura_origen_id') FROM jsonb_array_elements(v_datos->'facturas') elem)
  );

  UPDATE pedidos p SET factura_id = (elem->>'factura_id')::uuid
  FROM jsonb_array_elements(v_datos->'pedidos') elem
  WHERE p.id = (elem->>'id')::uuid AND elem->>'factura_id' IS NOT NULL;

  UPDATE facturas f SET factura_origen_id = (elem->>'factura_origen_id')::uuid
  FROM jsonb_array_elements(v_datos->'facturas') elem
  WHERE f.id = (elem->>'id')::uuid AND elem->>'factura_origen_id' IS NOT NULL;

  INSERT INTO cheques SELECT * FROM jsonb_populate_recordset(NULL::cheques, v_datos->'cheques');

  INSERT INTO cta_cte (
    id, cliente_id, tipo, monto, factura_id, cobro_id, saldo, fecha, descripcion,
    empresa_id, limite_credito, updated_at, importe, nro_comprobante, medio_pago
  )
  SELECT
    id, cliente_id, tipo, monto, factura_id, cobro_id, saldo, fecha, descripcion,
    empresa_id, limite_credito, updated_at, importe, nro_comprobante, medio_pago
  FROM jsonb_populate_recordset(NULL::cta_cte, v_datos->'cta_cte');

  UPDATE empresas e SET
    nombre = (v_datos->'empresa'->>'nombre'),
    activa = (v_datos->'empresa'->>'activa')::boolean,
    setup_completado = (v_datos->'empresa'->>'setup_completado')::boolean
  WHERE e.id = v_empresa_id;

END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_reset_demo_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  v_empresa_id := (SELECT id FROM empresas WHERE es_demo = true LIMIT 1);
  IF v_empresa_id IS NULL THEN
    RAISE NOTICE 'fn_reset_demo_cron: no hay ninguna empresa demo — nada que resetear';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM demo_snapshots WHERE empresa_id = v_empresa_id) THEN
    PERFORM public.fn_snapshot_demo_v2(v_empresa_id);
    RETURN;
  END IF;

  PERFORM public.fn_reset_demo_v2(v_empresa_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_reset_demo_v2(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_datos jsonb;
  v_cfg record;
  v_cols text;
  v_sql text;
  v_data_tabla jsonb;
  v_defaults jsonb;
  v_def_rec record;
  v_def_val jsonb;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para resetear';
  END IF;

  SELECT datos INTO v_datos FROM demo_snapshots WHERE empresa_id = v_empresa_id;
  IF v_datos IS NULL THEN
    RAISE EXCEPTION 'No existe snapshot para la empresa %. Corré fn_snapshot_demo_v2() primero.', v_empresa_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  UPDATE pedidos    SET factura_id = NULL, presupuesto_id = NULL WHERE empresa_id = v_empresa_id;
  UPDATE ventas_pos SET factura_id = NULL                        WHERE empresa_id = v_empresa_id;
  UPDATE facturas   SET factura_origen_id = NULL                 WHERE empresa_id = v_empresa_id;

  FOR v_cfg IN
    SELECT * FROM (VALUES
      (1,'facturacion_config',false,NULL::text,NULL::text),(2,'zonas',false,NULL,NULL),(3,'depositos',false,NULL,NULL),
      (4,'categorias',false,NULL,NULL),(5,'proveedores',false,NULL,NULL),(6,'listas_precios',false,NULL,NULL),
      (7,'rutas',false,NULL,NULL),(8,'reglas_liquidacion',false,NULL,NULL),(9,'productos',false,NULL,NULL),
      (10,'cajas_pos',false,NULL,NULL),(11,'clientes',false,NULL,NULL),(12,'stock',true,'productos','producto_id'),
      (13,'lotes',false,NULL,NULL),(14,'promociones',false,NULL,NULL),(15,'pos_favoritos',false,NULL,NULL),
      (16,'cliente_direcciones',false,NULL,NULL),(17,'bloqueos_cliente',false,NULL,NULL),(18,'precios_clientes',false,NULL,NULL),
      (19,'carrito_items',false,NULL,NULL),(20,'ciclos_compra',false,NULL,NULL),(21,'ordenes_compra',false,NULL,NULL),
      (22,'cobros',false,NULL,NULL),(23,'comprobantes_historicos',false,NULL,NULL),(24,'turnos_caja',true,'cajas_pos','caja_id'),
      (25,'precios_items',true,'listas_precios','lista_id'),(26,'ofertas_liquidacion',false,NULL,NULL),(27,'movimientos_caja',false,NULL,NULL),
      (28,'ventas_pos',false,NULL,NULL),(29,'ordenes_compra_items',true,'ordenes_compra','orden_id'),(30,'recepciones_mercaderia',false,NULL,NULL),
      (31,'reportes_ruta',false,NULL,NULL),(32,'pedidos',false,NULL,NULL),(33,'cheques',false,NULL,NULL),
      (34,'venta_pos_items',true,'ventas_pos','venta_pos_id'),(35,'venta_pos_pagos',true,'ventas_pos','venta_pos_id'),(36,'devoluciones_pos',false,NULL,NULL),
      (37,'facturas_proveedor',false,NULL,NULL),(38,'ruta_items',false,NULL,NULL),(39,'pedido_items',true,'pedidos','pedido_id'),
      (40,'sugerencias_pedido',false,NULL,NULL),(41,'presupuestos',false,NULL,NULL),(42,'facturas',false,NULL,NULL),
      (43,'devoluciones',false,NULL,NULL),(44,'notas_credito',false,NULL,NULL),(45,'presupuesto_items',true,'presupuestos','presupuesto_id'),
      (46,'devolucion_items',true,'devoluciones','devolucion_id'),(47,'facturas_proveedor_items',true,'facturas_proveedor','factura_id'),(48,'pagos_proveedor',false,NULL,NULL),
      (49,'notas_debito_proveedor',false,NULL,NULL),(50,'cta_cte',false,NULL,NULL),(51,'notas_credito_items',true,'notas_credito','nota_credito_id'),
      (52,'movimientos_puntos',false,NULL,NULL),(53,'movimientos_stock',true,'depositos','deposito_id'),
      (54,'entregas',true,'rutas','ruta_id'),(55,'audit_log',false,NULL,NULL)
    ) AS t(ord, tabla, es_hija, tabla_padre, fk_col)
    ORDER BY ord DESC
  LOOP
    IF v_cfg.es_hija THEN
      EXECUTE format('DELETE FROM %I WHERE %I IN (SELECT id FROM %I WHERE empresa_id = $1)', v_cfg.tabla, v_cfg.fk_col, v_cfg.tabla_padre) USING v_empresa_id;
    ELSE
      EXECUTE format('DELETE FROM %I WHERE empresa_id = $1', v_cfg.tabla) USING v_empresa_id;
    END IF;
  END LOOP;

  FOR v_cfg IN
    SELECT * FROM (VALUES
      (1,'facturacion_config'),(2,'zonas'),(3,'depositos'),(4,'categorias'),(5,'proveedores'),(6,'listas_precios'),
      (7,'rutas'),(8,'reglas_liquidacion'),(9,'productos'),(10,'cajas_pos'),(11,'clientes'),(12,'stock'),
      (13,'lotes'),(14,'promociones'),(15,'pos_favoritos'),(16,'cliente_direcciones'),(17,'bloqueos_cliente'),(18,'precios_clientes'),
      (19,'carrito_items'),(20,'ciclos_compra'),(21,'ordenes_compra'),(22,'cobros'),(23,'comprobantes_historicos'),(24,'turnos_caja'),
      (25,'precios_items'),(26,'ofertas_liquidacion'),(27,'movimientos_caja'),(28,'ventas_pos'),(29,'ordenes_compra_items'),(30,'recepciones_mercaderia'),
      (31,'reportes_ruta'),(32,'pedidos'),(33,'cheques'),(34,'venta_pos_items'),(35,'venta_pos_pagos'),(36,'devoluciones_pos'),
      (37,'facturas_proveedor'),(38,'ruta_items'),(39,'pedido_items'),(40,'sugerencias_pedido'),(41,'presupuestos'),(42,'facturas'),
      (43,'devoluciones'),(44,'notas_credito'),(45,'presupuesto_items'),(46,'devolucion_items'),(47,'facturas_proveedor_items'),(48,'pagos_proveedor'),
      (49,'notas_debito_proveedor'),(50,'cta_cte'),(51,'notas_credito_items'),
      (52,'movimientos_puntos'),(53,'movimientos_stock'),(54,'entregas'),(55,'audit_log')
    ) AS t(ord, tabla)
    ORDER BY ord
  LOOP
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = v_cfg.tabla AND is_generated <> 'ALWAYS';

    v_data_tabla := v_datos -> v_cfg.tabla;
    IF v_cfg.tabla = 'ventas_pos' THEN
      SELECT COALESCE(jsonb_agg(elem - 'factura_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    ELSIF v_cfg.tabla = 'pedidos' THEN
      SELECT COALESCE(jsonb_agg(elem - 'factura_id' - 'presupuesto_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    ELSIF v_cfg.tabla = 'facturas' THEN
      SELECT COALESCE(jsonb_agg(elem - 'factura_origen_id'), '[]'::jsonb) INTO v_data_tabla FROM jsonb_array_elements(v_data_tabla) elem;
    END IF;

    v_defaults := '{}'::jsonb;
    FOR v_def_rec IN
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_cfg.tabla
        AND column_default IS NOT NULL
        AND is_generated <> 'ALWAYS'
    LOOP
      BEGIN
        EXECUTE format('SELECT to_jsonb(%s)', v_def_rec.column_default) INTO v_def_val;
        v_defaults := jsonb_set(v_defaults, ARRAY[v_def_rec.column_name], v_def_val);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;

    IF v_defaults <> '{}'::jsonb THEN
      SELECT COALESCE(jsonb_agg(v_defaults || elem), '[]'::jsonb) INTO v_data_tabla
      FROM jsonb_array_elements(v_data_tabla) elem;
    END IF;

    v_sql := format('INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_recordset(NULL::%I, $1)', v_cfg.tabla, v_cols, v_cols, v_cfg.tabla);
    EXECUTE v_sql USING v_data_tabla;
  END LOOP;

  UPDATE ventas_pos v SET factura_id = (elem->>'factura_id')::uuid
  FROM jsonb_array_elements(v_datos->'ventas_pos') elem
  WHERE v.id = (elem->>'id')::uuid AND elem->>'factura_id' IS NOT NULL;

  UPDATE pedidos p SET factura_id = (elem->>'factura_id')::uuid
  FROM jsonb_array_elements(v_datos->'pedidos') elem
  WHERE p.id = (elem->>'id')::uuid AND elem->>'factura_id' IS NOT NULL;

  UPDATE pedidos p SET presupuesto_id = (elem->>'presupuesto_id')::uuid
  FROM jsonb_array_elements(v_datos->'pedidos') elem
  WHERE p.id = (elem->>'id')::uuid AND elem->>'presupuesto_id' IS NOT NULL;

  UPDATE facturas f SET factura_origen_id = (elem->>'factura_origen_id')::uuid
  FROM jsonb_array_elements(v_datos->'facturas') elem
  WHERE f.id = (elem->>'id')::uuid AND elem->>'factura_origen_id' IS NOT NULL;

  UPDATE empresas e SET
    nombre = (v_datos->'empresa'->>'nombre'),
    activa = (v_datos->'empresa'->>'activa')::boolean,
    setup_completado = (v_datos->'empresa'->>'setup_completado')::boolean
  WHERE e.id = v_empresa_id;

END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_snapshot_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_datos jsonb;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para snapshotear';
  END IF;

  SELECT jsonb_build_object(
    'empresa',             (SELECT to_jsonb(e) FROM empresas e WHERE e.id = v_empresa_id),
    'facturacion_config',  COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM facturacion_config t WHERE t.empresa_id = v_empresa_id), '[]'),
    'zonas',               COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM zonas t WHERE t.empresa_id = v_empresa_id), '[]'),
    'depositos',           COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM depositos t WHERE t.empresa_id = v_empresa_id), '[]'),
    'categorias',          COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM categorias t WHERE t.empresa_id = v_empresa_id), '[]'),
    'productos',           COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM productos t WHERE t.empresa_id = v_empresa_id), '[]'),
    'stock',               COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM stock s JOIN productos p ON p.id = s.producto_id WHERE p.empresa_id = v_empresa_id), '[]'),
    'clientes',            COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM clientes t WHERE t.empresa_id = v_empresa_id), '[]'),
    'pedidos',             COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM pedidos t WHERE t.empresa_id = v_empresa_id), '[]'),
    'pedido_items',        COALESCE((SELECT jsonb_agg(to_jsonb(pi)) FROM pedido_items pi JOIN pedidos p ON p.id = pi.pedido_id WHERE p.empresa_id = v_empresa_id), '[]'),
    'facturas',            COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM facturas t WHERE t.empresa_id = v_empresa_id), '[]'),
    'cheques',             COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM cheques t WHERE t.empresa_id = v_empresa_id), '[]'),
    'cta_cte',             COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM cta_cte t WHERE t.empresa_id = v_empresa_id), '[]')
  ) INTO v_datos;

  INSERT INTO demo_snapshots (empresa_id, datos)
  VALUES (v_empresa_id, v_datos)
  ON CONFLICT (empresa_id) DO UPDATE
    SET datos = EXCLUDED.datos, actualizado_at = now();

  RETURN v_empresa_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_snapshot_demo_v2(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_datos jsonb := '{}'::jsonb;
  v_cfg record;
  v_cols text;
  v_sql text;
  v_part jsonb;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para snapshotear';
  END IF;

  FOR v_cfg IN
    SELECT * FROM (VALUES
      (1,  'facturacion_config',      false, NULL::text,          NULL::text),
      (2,  'zonas',                   false, NULL,                 NULL),
      (3,  'depositos',               false, NULL,                 NULL),
      (4,  'categorias',              false, NULL,                 NULL),
      (5,  'proveedores',             false, NULL,                 NULL),
      (6,  'listas_precios',          false, NULL,                 NULL),
      (7,  'rutas',                   false, NULL,                 NULL),
      (8,  'reglas_liquidacion',      false, NULL,                 NULL),
      (9,  'productos',               false, NULL,                 NULL),
      (10, 'cajas_pos',                false, NULL,                 NULL),
      (11, 'clientes',                false, NULL,                 NULL),
      (12, 'stock',                   true,  'productos',          'producto_id'),
      (13, 'lotes',                   false, NULL,                 NULL),
      (14, 'promociones',             false, NULL,                 NULL),
      (15, 'pos_favoritos',           false, NULL,                 NULL),
      (16, 'cliente_direcciones',     false, NULL,                 NULL),
      (17, 'bloqueos_cliente',        false, NULL,                 NULL),
      (18, 'precios_clientes',        false, NULL,                 NULL),
      (19, 'carrito_items',           false, NULL,                 NULL),
      (20, 'ciclos_compra',           false, NULL,                 NULL),
      (21, 'ordenes_compra',          false, NULL,                 NULL),
      (22, 'cobros',                  false, NULL,                 NULL),
      (23, 'comprobantes_historicos', false, NULL,                 NULL),
      (24, 'turnos_caja',             true,  'cajas_pos',          'caja_id'),
      (25, 'precios_items',           true,  'listas_precios',     'lista_id'),
      (26, 'ofertas_liquidacion',     false, NULL,                 NULL),
      (27, 'movimientos_caja',       false, NULL,                 NULL),
      (28, 'ventas_pos',              false, NULL,                 NULL),
      (29, 'ordenes_compra_items',    true,  'ordenes_compra',     'orden_id'),
      (30, 'recepciones_mercaderia', false, NULL,                 NULL),
      (31, 'reportes_ruta',           false, NULL,                 NULL),
      (32, 'pedidos',                 false, NULL,                 NULL),
      (33, 'cheques',                 false, NULL,                 NULL),
      (34, 'venta_pos_items',         true,  'ventas_pos',         'venta_pos_id'),
      (35, 'venta_pos_pagos',         true,  'ventas_pos',         'venta_pos_id'),
      (36, 'devoluciones_pos',       false, NULL,                 NULL),
      (37, 'facturas_proveedor',      false, NULL,                 NULL),
      (38, 'ruta_items',              false, NULL,                 NULL),
      (39, 'pedido_items',            true,  'pedidos',            'pedido_id'),
      (40, 'sugerencias_pedido',      false, NULL,                 NULL),
      (41, 'presupuestos',            false, NULL,                 NULL),
      (42, 'facturas',                false, NULL,                 NULL),
      (43, 'devoluciones',            false, NULL,                 NULL),
      (44, 'notas_credito',           false, NULL,                 NULL),
      (45, 'presupuesto_items',       true,  'presupuestos',       'presupuesto_id'),
      (46, 'devolucion_items',        true,  'devoluciones',       'devolucion_id'),
      (47, 'facturas_proveedor_items',true,  'facturas_proveedor', 'factura_id'),
      (48, 'pagos_proveedor',        false, NULL,                 NULL),
      (49, 'notas_debito_proveedor', false, NULL,                 NULL),
      (50, 'cta_cte',                 false, NULL,                 NULL),
      (51, 'notas_credito_items',     true,  'notas_credito',      'nota_credito_id'),
      (52, 'movimientos_puntos',      false, NULL,                 NULL),
      (53, 'movimientos_stock',       true,  'depositos',          'deposito_id'),
      (54, 'entregas',                true,  'rutas',              'ruta_id'),
      (55, 'audit_log',               false, NULL,                 NULL)
    ) AS t(ord, tabla, es_hija, tabla_padre, fk_col)
    ORDER BY ord
  LOOP
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = v_cfg.tabla AND is_generated <> 'ALWAYS';

    IF v_cfg.es_hija THEN
      v_sql := format(
        'SELECT COALESCE(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM (SELECT %s FROM %I WHERE %I IN (SELECT id FROM %I WHERE empresa_id = $1)) x',
        v_cols, v_cfg.tabla, v_cfg.fk_col, v_cfg.tabla_padre
      );
    ELSE
      v_sql := format(
        'SELECT COALESCE(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM (SELECT %s FROM %I WHERE empresa_id = $1) x',
        v_cols, v_cfg.tabla
      );
    END IF;

    EXECUTE v_sql INTO v_part USING v_empresa_id;
    v_datos := jsonb_set(v_datos, ARRAY[v_cfg.tabla], v_part);
  END LOOP;

  v_datos := jsonb_set(v_datos, ARRAY['empresa'], (SELECT to_jsonb(e) FROM empresas e WHERE e.id = v_empresa_id));

  INSERT INTO demo_snapshots (empresa_id, datos)
  VALUES (v_empresa_id, v_datos)
  ON CONFLICT (empresa_id) DO UPDATE
    SET datos = EXCLUDED.datos, actualizado_at = now();

  RETURN v_empresa_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stock_valida_negativo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_permite boolean;
BEGIN
  IF NEW.cantidad < 0 OR NEW.cantidad_disponible < 0 THEN
    SELECT permite_negativo INTO v_permite
    FROM public.productos
    WHERE id = NEW.producto_id;

    IF v_permite IS NOT TRUE THEN
      RAISE EXCEPTION 'stock_no_negativo: el producto % no tiene permite_negativo=true (cantidad=%, cantidad_disponible=%)',
        NEW.producto_id, NEW.cantidad, NEW.cantidad_disponible
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.forzar_cierre_turno_caja(p_turno_id uuid, p_usuario_id uuid, p_motivo text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_turno             RECORD;
  v_total_efectivo    NUMERIC;
  v_neto_movimientos  NUMERIC;
  v_monto_calculado   NUMERIC;
BEGIN
  SELECT * INTO v_turno FROM public.turnos_caja WHERE id = p_turno_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_no_encontrado',
      'error', 'Turno no encontrado');
  END IF;

  IF v_turno.estado = 'cerrado' THEN
    RETURN json_build_object('ok', false, 'tipo', 'turno_ya_cerrado',
      'error', 'El turno ya fue cerrado');
  END IF;

  SELECT COALESCE(SUM(vpp.monto), 0) INTO v_total_efectivo
    FROM public.venta_pos_pagos vpp
    JOIN public.ventas_pos vp ON vp.id = vpp.venta_pos_id
   WHERE vp.turno_id = p_turno_id
     AND vpp.medio   = 'efectivo'
     AND vp.estado   = 'completada';

  SELECT COALESCE(SUM(
    CASE WHEN tipo = 'refuerzo' THEN monto ELSE -monto END
  ), 0) INTO v_neto_movimientos
    FROM public.movimientos_caja
   WHERE turno_id = p_turno_id;

  v_monto_calculado := v_turno.monto_inicial + v_total_efectivo + v_neto_movimientos;

  UPDATE public.turnos_caja
     SET estado                 = 'cerrado',
         monto_final_declarado  = v_monto_calculado,
         monto_final_calculado  = v_monto_calculado,
         diferencia             = 0,
         cerrado_at             = NOW(),
         cerrado_forzado        = true,
         cerrado_forzado_por    = p_usuario_id,
         motivo_cierre_forzado  = p_motivo
   WHERE id = p_turno_id;

  RETURN json_build_object(
    'ok',              true,
    'monto_calculado', v_monto_calculado,
    'cerrado_forzado', true
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fp_lotes_default_disponible()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cantidad_disponible IS NULL OR NEW.cantidad_disponible = 0 THEN
    NEW.cantidad_disponible := GREATEST(NEW.cantidad - COALESCE(NEW.cantidad_reservada, 0), 0);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generar_asientos_cobranzas(p_empresa_id uuid, p_desde date, p_hasta date)
 RETURNS TABLE(fecha date, comprobante text, cuenta text, descripcion text, debe numeric, haber numeric, origen_tipo text, origen_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plan jsonb; v_cta_deudores text; v_cta_caja text; v_cta_banco text;
BEGIN
  SELECT plan_cuentas INTO v_plan FROM export_contable_config WHERE empresa_id = p_empresa_id AND activo = true LIMIT 1;
  v_cta_deudores := COALESCE(v_plan->>'deudores_por_ventas', '1.1.3.01');
  v_cta_caja     := COALESCE(v_plan->>'caja',  '1.1.1.01');
  v_cta_banco    := COALESCE(v_plan->>'banco', '1.1.2.01');

  RETURN QUERY
  SELECT co.fecha::date, co.id::text, CASE WHEN co.medio = 'efectivo' THEN v_cta_caja ELSE v_cta_banco END,
         ('Cobro ' || co.medio)::text, co.monto, 0::numeric, 'cobro'::text, co.id
  FROM cobros co WHERE co.empresa_id = p_empresa_id AND co.fecha::date BETWEEN p_desde AND p_hasta
  UNION ALL
  SELECT co.fecha::date, co.id::text, v_cta_deudores, ('Cobro ' || co.medio)::text, 0::numeric, co.monto, 'cobro'::text, co.id
  FROM cobros co WHERE co.empresa_id = p_empresa_id AND co.fecha::date BETWEEN p_desde AND p_hasta
  ORDER BY 1, 2;
END; $function$;

CREATE OR REPLACE FUNCTION public.generar_asientos_compras(p_empresa_id uuid, p_desde date, p_hasta date)
 RETURNS TABLE(fecha date, comprobante text, cuenta text, descripcion text, debe numeric, haber numeric, origen_tipo text, origen_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plan jsonb; v_cta_compras text; v_cta_iva_credito text; v_cta_proveedores text;
BEGIN
  SELECT plan_cuentas INTO v_plan FROM export_contable_config WHERE empresa_id = p_empresa_id AND activo = true LIMIT 1;
  v_cta_compras     := COALESCE(v_plan->>'compras',              '5.1.1.01');
  v_cta_iva_credito := COALESCE(v_plan->>'iva_credito_fiscal',   '1.1.4.01');
  v_cta_proveedores := COALESCE(v_plan->>'proveedores',          '2.1.1.01');

  RETURN QUERY
  SELECT fp.fecha_factura, fp.numero_factura, COALESCE(p.codigo_contable, v_cta_compras),
         ('Compra s/ factura ' || fp.numero_factura || ' — ' || p.razon_social)::text, fp.subtotal, 0::numeric, 'factura_proveedor'::text, fp.id
  FROM facturas_proveedor fp JOIN proveedores p ON p.id = fp.proveedor_id
  WHERE fp.empresa_id = p_empresa_id AND fp.fecha_factura BETWEEN p_desde AND p_hasta AND fp.estado <> 'anulada'
  UNION ALL
  SELECT fp.fecha_factura, fp.numero_factura, v_cta_iva_credito, ('IVA compra ' || fp.numero_factura)::text, fp.iva_monto, 0::numeric, 'factura_proveedor'::text, fp.id
  FROM facturas_proveedor fp
  WHERE fp.empresa_id = p_empresa_id AND fp.fecha_factura BETWEEN p_desde AND p_hasta AND fp.estado <> 'anulada' AND fp.iva_monto <> 0
  UNION ALL
  SELECT fp.fecha_factura, fp.numero_factura, v_cta_proveedores, ('Compra s/ factura ' || fp.numero_factura)::text, 0::numeric, fp.total, 'factura_proveedor'::text, fp.id
  FROM facturas_proveedor fp
  WHERE fp.empresa_id = p_empresa_id AND fp.fecha_factura BETWEEN p_desde AND p_hasta AND fp.estado <> 'anulada'
  ORDER BY 1, 2;
END; $function$;

CREATE OR REPLACE FUNCTION public.generar_asientos_ventas(p_empresa_id uuid, p_desde date, p_hasta date)
 RETURNS TABLE(fecha date, comprobante text, cuenta text, descripcion text, debe numeric, haber numeric, origen_tipo text, origen_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plan jsonb;
  v_cta_deudores text; v_cta_ventas text; v_cta_iva_debito text; v_cta_nc_ventas text;
BEGIN
  SELECT plan_cuentas INTO v_plan FROM export_contable_config WHERE empresa_id = p_empresa_id AND activo = true LIMIT 1;
  v_cta_deudores   := COALESCE(v_plan->>'deudores_por_ventas',  '1.1.3.01');
  v_cta_ventas     := COALESCE(v_plan->>'ventas',               '4.1.1.01');
  v_cta_iva_debito := COALESCE(v_plan->>'iva_debito_fiscal',    '2.1.3.01');
  v_cta_nc_ventas  := COALESCE(v_plan->>'notas_credito_ventas', '4.1.1.02');

  RETURN QUERY
  SELECT f.fecha_emision::date, f.numero, v_cta_deudores, ('Venta s/ factura ' || f.numero)::text, f.total, 0::numeric, 'factura'::text, f.id
  FROM facturas f WHERE f.empresa_id = p_empresa_id AND f.estado = 'emitida' AND f.fecha_emision::date BETWEEN p_desde AND p_hasta
  UNION ALL
  SELECT f.fecha_emision::date, f.numero, v_cta_ventas, ('Venta s/ factura ' || f.numero)::text, 0::numeric, f.neto, 'factura'::text, f.id
  FROM facturas f WHERE f.empresa_id = p_empresa_id AND f.estado = 'emitida' AND f.fecha_emision::date BETWEEN p_desde AND p_hasta
  UNION ALL
  SELECT f.fecha_emision::date, f.numero, v_cta_iva_debito, ('IVA s/ factura ' || f.numero)::text, 0::numeric, f.iva, 'factura'::text, f.id
  FROM facturas f WHERE f.empresa_id = p_empresa_id AND f.estado = 'emitida' AND f.fecha_emision::date BETWEEN p_desde AND p_hasta AND f.iva <> 0
  UNION ALL
  SELECT nc.fecha_emision::date, nc.numero, v_cta_nc_ventas, ('NC ' || nc.numero || ' — ' || nc.motivo)::text, nc.neto, 0::numeric, 'nota_credito'::text, nc.id
  FROM notas_credito nc WHERE nc.empresa_id = p_empresa_id AND nc.fecha_emision::date BETWEEN p_desde AND p_hasta
  UNION ALL
  SELECT nc.fecha_emision::date, nc.numero, v_cta_iva_debito, ('IVA NC ' || nc.numero)::text, nc.iva, 0::numeric, 'nota_credito'::text, nc.id
  FROM notas_credito nc WHERE nc.empresa_id = p_empresa_id AND nc.fecha_emision::date BETWEEN p_desde AND p_hasta AND nc.iva <> 0
  UNION ALL
  SELECT nc.fecha_emision::date, nc.numero, v_cta_deudores, ('NC ' || nc.numero || ' — ' || nc.motivo)::text, 0::numeric, nc.total, 'nota_credito'::text, nc.id
  FROM notas_credito nc WHERE nc.empresa_id = p_empresa_id AND nc.fecha_emision::date BETWEEN p_desde AND p_hasta
  ORDER BY 1, 2;
END; $function$;

CREATE OR REPLACE FUNCTION public.get_push_secret()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_secret text;
BEGIN
  SELECT value INTO v_secret
  FROM public.internal_secrets
  WHERE name = 'internal_push_secret';
  RETURN v_secret;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gg_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$;

CREATE OR REPLACE FUNCTION public.is_saas_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.usuarios
    WHERE id = auth.uid()
      AND empresa_id = '00000000-0000-0000-0000-000000000099'
      AND rol = 'dueno'
  );
$function$;

CREATE OR REPLACE FUNCTION public.migracion_confirmar_comprobantes_historicos_lote(p_sesion_id uuid, p_empresa_id uuid, p_usuario_id uuid DEFAULT NULL::uuid, p_lote_size integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fila       RECORD;
  v_d          JSONB;
  v_cliente_id UUID;
  v_creados    INT := 0;
  v_omitidos   INT := 0;
  v_errores    JSONB := '[]'::jsonb;
  v_nuevo_id   UUID;
  v_procesadas INT := 0;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  FOR v_fila IN
    SELECT id, fila_numero, datos_mapeados
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND es_valida = true
       AND accion <> 'omitir'
       AND procesado_en IS NULL
     ORDER BY fila_numero
     LIMIT p_lote_size
       FOR UPDATE SKIP LOCKED
  LOOP
    v_procesadas := v_procesadas + 1;
    v_d := COALESCE(v_fila.datos_mapeados, '{}'::jsonb);

    BEGIN
      v_cliente_id := NULLIF(v_d->>'cliente_id_resuelto', '')::UUID;
      IF v_cliente_id IS NULL THEN
        RAISE EXCEPTION 'Cliente no resuelto';
      END IF;

      INSERT INTO comprobantes_historicos (
        empresa_id, cliente_id, tipo, numero_original, fecha, monto, moneda, observaciones, creado_por
      ) VALUES (
        p_empresa_id,
        v_cliente_id,
        v_d->>'tipo',
        TRIM(v_d->>'numero_original'),
        COALESCE((v_d->>'fecha_iso')::DATE, (v_d->>'fecha')::DATE),
        (v_d->>'monto')::NUMERIC,
        COALESCE(NULLIF(TRIM(v_d->>'moneda'), ''), 'ARS'),
        NULLIF(TRIM(v_d->>'observaciones'), ''),
        p_usuario_id
      )
      ON CONFLICT ON CONSTRAINT comprobantes_historicos_dedupe DO NOTHING
      RETURNING id INTO v_nuevo_id;

      IF v_nuevo_id IS NOT NULL THEN
        v_creados := v_creados + 1;
        UPDATE migracion_staging_rows SET procesado_en = now(), entidad_resultado_id = v_nuevo_id WHERE id = v_fila.id;
      ELSE
        v_omitidos := v_omitidos + 1;
        UPDATE migracion_staging_rows SET procesado_en = now(), error_ejecucion = 'omitido: ya existe (mismo tipo + número + cliente)' WHERE id = v_fila.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('fila_numero', v_fila.fila_numero, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows SET procesado_en = now(), error_ejecucion = SQLERRM WHERE id = v_fila.id;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'procesadas', v_procesadas,
    'creados', v_creados,
    'omitidos', v_omitidos,
    'errores', v_errores,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.migracion_formatear_cuit(p_cuit text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN regexp_replace(COALESCE(p_cuit, ''), '[^0-9]', '', 'g') ~ '^\d{11}$'
      THEN regexp_replace(
             regexp_replace(p_cuit, '[^0-9]', '', 'g'),
             '^(\d{2})(\d{8})(\d)$', '\1-\2-\3'
           )
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.migracion_precheck_advertencias(p_sesion_id uuid, p_empresa_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_entidad     text;
  v_advertencias jsonb := '[]'::jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  SELECT entidad INTO v_entidad FROM migracion_sesiones WHERE id = p_sesion_id AND empresa_id = p_empresa_id;
  IF v_entidad IS NULL THEN
    RAISE EXCEPTION 'Sesión no encontrada';
  END IF;

  IF v_entidad = 'clientes' THEN
    WITH filas AS (
      SELECT fila_numero, TRIM(datos_mapeados->>'razon_social') AS razon_social,
             datos_mapeados->>'vendedor' AS vendedor_texto,
             datos_mapeados->>'vendedor_resuelto' AS vendedor_resuelto
        FROM migracion_staging_rows
       WHERE sesion_id = p_sesion_id AND es_valida = true
    ),
    similares AS (
      SELECT a.fila_numero AS fila_a, b.fila_numero AS fila_b, a.razon_social AS ra, b.razon_social AS rb,
             similarity(a.razon_social, b.razon_social) AS sim
        FROM filas a JOIN filas b ON a.fila_numero < b.fila_numero
       WHERE similarity(a.razon_social, b.razon_social) > 0.6
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'tipo', 'razon_social_similar_en_archivo',
             'filas', ARRAY[fila_a, fila_b],
             'detalle', ra || ' / ' || rb,
             'similaridad', round(sim::numeric, 2)
           )), '[]'::jsonb)
      INTO v_advertencias
      FROM similares;

    WITH filas AS (
      SELECT fila_numero, TRIM(datos_mapeados->>'razon_social') AS razon_social
        FROM migracion_staging_rows
       WHERE sesion_id = p_sesion_id AND es_valida = true
    ),
    contra_existentes AS (
      SELECT f.fila_numero, f.razon_social, c.razon_social AS existente,
             similarity(f.razon_social, c.razon_social) AS sim
        FROM filas f
        JOIN clientes c ON c.empresa_id = p_empresa_id
                        AND similarity(f.razon_social, c.razon_social) > 0.6
    )
    SELECT v_advertencias || COALESCE(jsonb_agg(jsonb_build_object(
             'tipo', 'razon_social_similar_a_existente',
             'fila', fila_numero,
             'detalle', razon_social || ' ≈ ' || existente,
             'similaridad', round(sim::numeric, 2)
           )), '[]'::jsonb)
      INTO v_advertencias
      FROM contra_existentes;

    WITH filas AS (
      SELECT fila_numero, datos_mapeados->>'vendedor' AS vendedor_texto, datos_mapeados->>'vendedor_resuelto' AS vr
        FROM migracion_staging_rows
       WHERE sesion_id = p_sesion_id AND es_valida = true
    )
    SELECT v_advertencias || COALESCE(jsonb_agg(jsonb_build_object(
             'tipo', 'vendedor_no_resuelto',
             'fila', fila_numero,
             'detalle', vendedor_texto
           )), '[]'::jsonb)
      INTO v_advertencias
      FROM filas
     WHERE vendedor_texto IS NOT NULL AND TRIM(vendedor_texto) <> '' AND (vr IS NULL OR TRIM(vr) = '');

  ELSIF v_entidad = 'productos' THEN
    WITH filas AS (
      SELECT sr.fila_numero,
             (sr.datos_mapeados->>'precio')::numeric AS precio_nuevo,
             p.costo AS costo_actual,
             sr.datos_mapeados->>'nombre' AS nombre
        FROM migracion_staging_rows sr
        JOIN productos p ON p.id = sr.entidad_existente_id
       WHERE sr.sesion_id = p_sesion_id
         AND sr.es_valida = true
         AND sr.accion = 'actualizar'
         AND sr.datos_mapeados ? 'precio'
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'tipo', 'precio_bajo_costo',
             'fila', fila_numero,
             'detalle', nombre,
             'precio_nuevo', precio_nuevo,
             'costo_actual', costo_actual
           )), '[]'::jsonb)
      INTO v_advertencias
      FROM filas
     WHERE costo_actual IS NOT NULL AND precio_nuevo IS NOT NULL AND precio_nuevo < costo_actual;
  END IF;

  UPDATE migracion_sesiones SET advertencias_precheck = v_advertencias, actualizado_at = now()
   WHERE id = p_sesion_id;

  RETURN v_advertencias;
END;
$function$;

CREATE OR REPLACE FUNCTION public.migracion_set_direccion_principal(p_direccion_id uuid, p_empresa_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cliente_id UUID;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  SELECT cliente_id INTO v_cliente_id
    FROM cliente_direcciones
   WHERE id = p_direccion_id AND empresa_id = p_empresa_id
   FOR UPDATE;

  IF v_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Dirección no encontrada';
  END IF;

  UPDATE cliente_direcciones SET es_principal = false
   WHERE cliente_id = v_cliente_id AND es_principal = true;

  UPDATE cliente_direcciones SET es_principal = true
   WHERE id = p_direccion_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.saas_mi_suscripcion()
 RETURNS TABLE(empresa_id uuid, empresa_nombre text, plan saas_plan, plan_tier plan_tier, precio_mensual numeric, trial_fin date, suspendida boolean, suspendida_at timestamp with time zone, cbu text, alias text, titular text, banco text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    e.id,
    e.nombre,
    e.saas_plan,
    e.plan_tier,
    COALESCE(e.saas_precio_mes, cfg.precio_mensual),
    e.saas_trial_fin,
    e.saas_suspendida,
    e.saas_suspendida_at,
    COALESCE(NULLIF(e.saas_cbu, ''), cfg.cbu),
    COALESCE(NULLIF(e.saas_alias, ''), cfg.alias),
    cfg.titular,
    cfg.banco
  FROM public.usuarios u
  JOIN public.empresas e ON e.id = u.empresa_id
  CROSS JOIN (SELECT * FROM public.saas_config WHERE id = 1) cfg
  WHERE u.id = auth.uid()
    AND u.activo = true
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.saas_mis_facturas(p_limit integer DEFAULT 24)
 RETURNS SETOF saas_facturas
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT f.*
  FROM public.saas_facturas f
  JOIN public.usuarios u ON u.empresa_id = f.empresa_id
  WHERE u.id = auth.uid()
    AND u.activo = true
  ORDER BY f.fecha_emision DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$function$;

CREATE OR REPLACE FUNCTION public.set_carrito_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sumar_saldo_puntos_fallback(p_cliente_id uuid, p_empresa_id uuid, p_cantidad integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  INSERT INTO public.saldo_puntos (cliente_id, empresa_id, puntos_disponibles, puntos_totales, ultimo_movimiento)
  VALUES (p_cliente_id, p_empresa_id, p_cantidad, p_cantidad, now())
  ON CONFLICT (cliente_id, empresa_id) DO UPDATE
     SET puntos_disponibles = saldo_puntos.puntos_disponibles + p_cantidad,
         puntos_totales     = saldo_puntos.puntos_totales + p_cantidad,
         ultimo_movimiento  = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_precios_clientes_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
