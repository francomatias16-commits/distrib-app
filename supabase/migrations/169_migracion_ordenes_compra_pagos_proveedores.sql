-- Punto 5 del plan de migraciones (P1): órdenes de compra y pagos a
-- proveedores históricos, mismo patrón que pedidos (cabecera+items
-- agrupados) y cta_cte (movimientos planos) respectivamente.

-- ─── Confirmar: órdenes de compra (agrupadas por numero_orden+proveedor) ──
CREATE OR REPLACE FUNCTION public.migracion_confirmar_ordenes_compra_lote(
  p_sesion_id uuid, p_empresa_id uuid, p_usuario_id uuid DEFAULT NULL::uuid, p_lote_size integer DEFAULT 100
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grupo       RECORD;
  v_orden_id    UUID;
  v_creados     INT := 0;
  v_errores     JSONB := '[]'::jsonb;
  v_procesadas  INT := 0;
BEGIN
  FOR v_grupo IN
    SELECT datos_mapeados->>'numero_orden' AS numero_orden,
           (datos_mapeados->>'proveedor_id_resuelto')::UUID AS proveedor_id,
           MIN(datos_mapeados->>'estado_resuelto') AS estado_raw,
           MIN(datos_mapeados->>'fecha_pedido_iso') AS fecha_pedido_raw,
           MIN(datos_mapeados->>'fecha_recepcion_iso') AS fecha_recepcion_raw,
           MIN(NULLIF(TRIM(datos_mapeados->>'notas'), '')) AS notas,
           MIN(fila_numero) AS primera_fila
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND es_valida = true
       AND accion <> 'omitir'
       AND procesado_en IS NULL
     GROUP BY 1, 2
     ORDER BY MIN(fila_numero)
     LIMIT p_lote_size
  LOOP
    v_procesadas := v_procesadas + 1;

    BEGIN
      IF v_grupo.proveedor_id IS NULL THEN
        RAISE EXCEPTION 'Proveedor no resuelto para la orden %', v_grupo.numero_orden;
      END IF;

      INSERT INTO ordenes_compra (
        empresa_id, proveedor_id, numero, estado, notas,
        fecha_pedido, fecha_recepcion, created_by
      ) VALUES (
        p_empresa_id, v_grupo.proveedor_id,
        'MIG-' || COALESCE(v_grupo.numero_orden, v_grupo.primera_fila::text),
        COALESCE(v_grupo.estado_raw, 'recibida'),
        v_grupo.notas,
        COALESCE(v_grupo.fecha_pedido_raw::timestamptz, now()),
        v_grupo.fecha_recepcion_raw::timestamptz,
        p_usuario_id
      )
      RETURNING id INTO v_orden_id;

      INSERT INTO ordenes_compra_items (orden_id, producto_id, cantidad, precio_unitario, precio_costo, iva_pct, subtotal, cantidad_recibida)
      SELECT
        v_orden_id,
        (msr.datos_mapeados->>'producto_id_resuelto')::UUID,
        (msr.datos_mapeados->>'cantidad')::NUMERIC,
        COALESCE(NULLIF(TRIM(msr.datos_mapeados->>'precio_unitario'), '')::NUMERIC, 0),
        COALESCE(NULLIF(TRIM(msr.datos_mapeados->>'precio_unitario'), '')::NUMERIC, 0),
        COALESCE(NULLIF(TRIM(msr.datos_mapeados->>'iva_pct'), '')::NUMERIC, 21),
        (msr.datos_mapeados->>'cantidad')::NUMERIC * COALESCE(NULLIF(TRIM(msr.datos_mapeados->>'precio_unitario'), '')::NUMERIC, 0),
        CASE WHEN COALESCE(v_grupo.estado_raw, 'recibida') = 'recibida' THEN (msr.datos_mapeados->>'cantidad')::NUMERIC ELSE 0 END
      FROM migracion_staging_rows msr
      WHERE msr.sesion_id = p_sesion_id
        AND msr.es_valida = true AND msr.accion <> 'omitir' AND msr.procesado_en IS NULL
        AND msr.datos_mapeados->>'numero_orden' IS NOT DISTINCT FROM v_grupo.numero_orden
        AND (msr.datos_mapeados->>'proveedor_id_resuelto')::UUID = v_grupo.proveedor_id;

      UPDATE ordenes_compra SET
        subtotal  = (SELECT COALESCE(SUM(subtotal), 0) FROM ordenes_compra_items WHERE orden_id = v_orden_id),
        iva_total = (SELECT COALESCE(SUM(subtotal * iva_pct / 100), 0) FROM ordenes_compra_items WHERE orden_id = v_orden_id),
        total     = (SELECT COALESCE(SUM(subtotal * (1 + iva_pct / 100)), 0) FROM ordenes_compra_items WHERE orden_id = v_orden_id)
      WHERE id = v_orden_id;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_orden_id
       WHERE sesion_id = p_sesion_id
         AND datos_mapeados->>'numero_orden' IS NOT DISTINCT FROM v_grupo.numero_orden
         AND (datos_mapeados->>'proveedor_id_resuelto')::UUID = v_grupo.proveedor_id
         AND procesado_en IS NULL;

      v_creados := v_creados + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('numero_orden', v_grupo.numero_orden, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows
         SET procesado_en = now(), error_ejecucion = SQLERRM
       WHERE sesion_id = p_sesion_id
         AND datos_mapeados->>'numero_orden' IS NOT DISTINCT FROM v_grupo.numero_orden
         AND (datos_mapeados->>'proveedor_id_resuelto')::UUID IS NOT DISTINCT FROM v_grupo.proveedor_id
         AND procesado_en IS NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'procesadas', v_procesadas,
    'ordenes_creadas', v_creados,
    'errores', v_errores,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;

-- ─── Confirmar: pagos a proveedores (1 fila = 1 pago, sin agrupación) ─────
CREATE OR REPLACE FUNCTION public.migracion_confirmar_pagos_proveedores_lote(
  p_sesion_id uuid, p_empresa_id uuid, p_usuario_id uuid DEFAULT NULL::uuid, p_lote_size integer DEFAULT 500
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fila         RECORD;
  v_d            JSONB;
  v_proveedor_id UUID;
  v_pago_id      UUID;
  v_creados      INT := 0;
  v_errores      JSONB := '[]'::jsonb;
  v_procesadas   INT := 0;
BEGIN
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
      v_proveedor_id := (v_d->>'proveedor_id_resuelto')::UUID;
      IF v_proveedor_id IS NULL THEN
        RAISE EXCEPTION 'Proveedor no resuelto';
      END IF;

      INSERT INTO pagos_proveedor (
        empresa_id, proveedor_id, factura_id, monto, medio_pago, fecha_pago, referencia, notas, usuario_id
      ) VALUES (
        p_empresa_id, v_proveedor_id, NULL,
        (v_d->>'monto')::NUMERIC,
        COALESCE(v_d->>'medio_pago_resuelto', 'transferencia'),
        (v_d->>'fecha_pago_iso')::DATE,
        NULLIF(TRIM(v_d->>'referencia'), ''),
        NULLIF(TRIM(v_d->>'notas'), ''),
        p_usuario_id
      )
      RETURNING id INTO v_pago_id;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_pago_id
       WHERE id = v_fila.id;

      v_creados := v_creados + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errores := v_errores || jsonb_build_object('fila_numero', v_fila.fila_numero, 'mensaje', SQLERRM);
      UPDATE migracion_staging_rows
         SET procesado_en = now(), error_ejecucion = SQLERRM
       WHERE id = v_fila.id;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'procesadas', v_procesadas,
    'creados', v_creados,
    'errores', v_errores,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;

-- ─── Deshacer: extender migracion_deshacer_sesion con las 2 entidades nuevas ──
CREATE OR REPLACE FUNCTION public.migracion_deshacer_sesion(p_sesion_id uuid, p_empresa_id uuid, p_entidad text, p_usuario_id uuid DEFAULT NULL::uuid, p_lote_size integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grupo           RECORD;
  v_accion          TEXT;
  v_resultado_id    UUID;
  v_eliminados      INT := 0;
  v_no_revertibles  INT := 0;
  v_omitidos        INT := 0;
  v_procesadas      INT := 0;
  v_motivo_omision  TEXT;
  v_cnt_cta_cte     INT;
  v_cnt_pagos       INT;
  v_cnt_oc          INT;
  v_cnt_fact_prov   INT;
  v_cnt_pagos_prov  INT;
BEGIN
  IF p_entidad NOT IN ('clientes', 'productos', 'pedidos', 'cta_cte', 'precios_clientes', 'proveedores', 'ordenes_compra', 'pagos_proveedores') THEN
    RAISE EXCEPTION 'Entidad no soportada para deshacer: %', p_entidad;
  END IF;

  FOR v_grupo IN
    SELECT DISTINCT entidad_resultado_id, accion
      FROM migracion_staging_rows
     WHERE sesion_id = p_sesion_id
       AND entidad_resultado_id IS NOT NULL
       AND error_ejecucion IS NULL
       AND accion <> 'omitir'
       AND deshecho_en IS NULL
     ORDER BY entidad_resultado_id
     LIMIT p_lote_size
  LOOP
    v_procesadas := v_procesadas + 1;
    v_resultado_id := v_grupo.entidad_resultado_id;
    v_accion := v_grupo.accion;
    v_motivo_omision := NULL;

    BEGIN
      IF v_accion = 'actualizar' THEN
        v_no_revertibles := v_no_revertibles + 1;
        v_motivo_omision := 'Actualización de un registro existente: no se revierte automáticamente, requiere revisión manual';

      ELSIF p_entidad = 'clientes' THEN
        SELECT count(*) INTO v_cnt_cta_cte FROM cta_cte WHERE cliente_id = v_resultado_id;
        SELECT count(*) INTO v_cnt_pagos   FROM transacciones_pago WHERE cliente_id = v_resultado_id;
        IF v_cnt_cta_cte > 0 OR v_cnt_pagos > 0 THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'Tiene cuenta corriente o pagos asociados (posiblemente generados después de la migración): no se elimina automáticamente';
        ELSE
          DELETE FROM clientes WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
          v_eliminados := v_eliminados + 1;
        END IF;

      ELSIF p_entidad = 'productos' THEN
        DELETE FROM productos WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;

      ELSIF p_entidad = 'pedidos' THEN
        DELETE FROM pedidos WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;

      ELSIF p_entidad = 'cta_cte' THEN
        DELETE FROM cta_cte WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;

      ELSIF p_entidad = 'precios_clientes' THEN
        DELETE FROM precios_clientes WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;

      ELSIF p_entidad = 'proveedores' THEN
        SELECT count(*) INTO v_cnt_oc        FROM ordenes_compra     WHERE proveedor_id = v_resultado_id;
        SELECT count(*) INTO v_cnt_fact_prov FROM facturas_proveedor WHERE proveedor_id = v_resultado_id;
        SELECT count(*) INTO v_cnt_pagos_prov FROM pagos_proveedor   WHERE proveedor_id = v_resultado_id;
        IF v_cnt_oc > 0 OR v_cnt_fact_prov > 0 OR v_cnt_pagos_prov > 0 THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'Tiene órdenes de compra, facturas o pagos asociados (posiblemente generados después de la migración): no se elimina automáticamente';
        ELSE
          DELETE FROM proveedores WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
          v_eliminados := v_eliminados + 1;
        END IF;

      -- Punto 5 del plan (P1): órdenes de compra y pagos a proveedores históricos.
      ELSIF p_entidad = 'ordenes_compra' THEN
        SELECT count(*) INTO v_cnt_fact_prov FROM facturas_proveedor WHERE orden_id = v_resultado_id;
        IF v_cnt_fact_prov > 0 THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'Tiene facturas de proveedor asociadas (posiblemente generadas después de la migración): no se elimina automáticamente';
        ELSE
          DELETE FROM ordenes_compra WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
          v_eliminados := v_eliminados + 1;
        END IF;

      ELSIF p_entidad = 'pagos_proveedores' THEN
        DELETE FROM pagos_proveedor WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
        v_eliminados := v_eliminados + 1;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      v_omitidos := v_omitidos + 1;
      v_motivo_omision := SQLERRM;
    END;

    UPDATE migracion_staging_rows
       SET deshecho_en = now(), deshecho_error = v_motivo_omision
     WHERE sesion_id = p_sesion_id
       AND entidad_resultado_id = v_resultado_id
       AND deshecho_en IS NULL;
  END LOOP;

  RETURN jsonb_build_object(
    'procesadas', v_procesadas,
    'eliminados', v_eliminados,
    'no_revertibles', v_no_revertibles,
    'omitidos', v_omitidos,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;
