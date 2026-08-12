-- 176_fix_migracion_deshacer_sesion_entidades_p2.sql
--
-- GAP encontrado al sincronizar el código: migracion_deshacer_sesion() seguía
-- con la lista de entidades previa a la migración 174 y explota con
-- 'Entidad no soportada para deshacer' si alguien confirma una migración de
-- cheques/puntos_fidelizacion/ventas_pos y después toca "Deshacer" en el
-- wizard. Se agrega soporte para las 3, con el mismo criterio de "no borrar
-- si hay algo enganchado después" que ya usan clientes/proveedores/lotes:
--   - cheques: si cobro_id ya está seteado (el cheque se aplicó a un cobro
--     después de migrado), no se borra automáticamente.
--   - ventas_pos: si tiene pagos, factura o devolución asociada, no se borra.
--   - puntos_fidelizacion: a diferencia de las demás, no alcanza con un
--     DELETE — hay que revertir el efecto en saldo_puntos (mismo cálculo
--     inverso al que hace migracion_confirmar_puntos_lote) antes de borrar
--     el movimiento. Si el saldo actual no alcanza para revertir (el cliente
--     ya usó/canjeó esos puntos después de la migración), no se revierte.
CREATE OR REPLACE FUNCTION public.migracion_deshacer_sesion(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_entidad    TEXT,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT DEFAULT 200
)
RETURNS JSONB
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
  v_cnt_ofertas     INT;
  v_cnt_reservado   NUMERIC;
  v_cnt_pagos_pos   INT;
  v_cnt_fact_pos    INT;
  v_cnt_devol_pos   INT;
  v_cheque_cobro    UUID;
  v_mov             RECORD;
  v_saldo           RECORD;
BEGIN
  IF p_entidad NOT IN ('clientes', 'productos', 'pedidos', 'cta_cte', 'precios_clientes', 'proveedores', 'ordenes_compra', 'pagos_proveedores', 'lotes', 'cheques', 'puntos_fidelizacion', 'ventas_pos') THEN
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

      ELSIF p_entidad = 'lotes' THEN
        SELECT count(*) INTO v_cnt_ofertas FROM ofertas_liquidacion WHERE lote_id = v_resultado_id;
        SELECT COALESCE(cantidad_reservada, 0) INTO v_cnt_reservado FROM lotes WHERE id = v_resultado_id;
        IF v_cnt_ofertas > 0 OR COALESCE(v_cnt_reservado, 0) > 0 THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'Tiene ofertas de liquidación o reservas asociadas (posiblemente generadas después de la migración): no se elimina automáticamente';
        ELSE
          DELETE FROM lotes WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
          v_eliminados := v_eliminados + 1;
        END IF;

      ELSIF p_entidad = 'cheques' THEN
        SELECT cobro_id INTO v_cheque_cobro FROM cheques WHERE id = v_resultado_id;
        IF v_cheque_cobro IS NOT NULL THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'El cheque ya está aplicado a un cobro (posiblemente generado después de la migración): no se elimina automáticamente';
        ELSE
          DELETE FROM cheques WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
          v_eliminados := v_eliminados + 1;
        END IF;

      ELSIF p_entidad = 'ventas_pos' THEN
        SELECT count(*) INTO v_cnt_pagos_pos FROM venta_pos_pagos  WHERE venta_pos_id = v_resultado_id;
        SELECT count(*) INTO v_cnt_fact_pos  FROM facturas         WHERE venta_pos_id = v_resultado_id;
        SELECT count(*) INTO v_cnt_devol_pos FROM devoluciones_pos WHERE venta_pos_id = v_resultado_id;
        IF v_cnt_pagos_pos > 0 OR v_cnt_fact_pos > 0 OR v_cnt_devol_pos > 0 THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'Tiene pagos, factura o devolución asociados (posiblemente generados después de la migración): no se elimina automáticamente';
        ELSE
          DELETE FROM venta_pos_items WHERE venta_pos_id = v_resultado_id;
          DELETE FROM ventas_pos WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
          v_eliminados := v_eliminados + 1;
        END IF;

      ELSIF p_entidad = 'puntos_fidelizacion' THEN
        SELECT id, cliente_id, tipo, cantidad INTO v_mov FROM movimientos_puntos WHERE id = v_resultado_id;
        IF v_mov.id IS NULL THEN
          v_omitidos := v_omitidos + 1;
          v_motivo_omision := 'Movimiento de puntos no encontrado';
        ELSE
          SELECT puntos_disponibles, puntos_canjeados, puntos_totales INTO v_saldo
            FROM saldo_puntos WHERE cliente_id = v_mov.cliente_id AND empresa_id = p_empresa_id;

          IF v_saldo.puntos_disponibles IS NULL
             OR (v_mov.tipo = 'ganancia' AND v_saldo.puntos_disponibles < v_mov.cantidad)
             OR (v_mov.tipo = 'canje' AND v_saldo.puntos_canjeados < v_mov.cantidad) THEN
            v_omitidos := v_omitidos + 1;
            v_motivo_omision := 'El saldo de puntos del cliente cambió después de la migración (ya usó/acumuló puntos): no se revierte automáticamente';
          ELSE
            UPDATE saldo_puntos SET
              puntos_disponibles = CASE WHEN v_mov.tipo = 'ganancia' THEN puntos_disponibles - v_mov.cantidad WHEN v_mov.tipo = 'canje' THEN puntos_disponibles + v_mov.cantidad ELSE puntos_disponibles END,
              puntos_canjeados   = CASE WHEN v_mov.tipo = 'canje' THEN puntos_canjeados - v_mov.cantidad ELSE puntos_canjeados END,
              puntos_totales     = puntos_totales - CASE WHEN v_mov.tipo = 'ganancia' THEN v_mov.cantidad WHEN v_mov.tipo = 'canje' THEN -v_mov.cantidad ELSE 0 END
            WHERE cliente_id = v_mov.cliente_id AND empresa_id = p_empresa_id;

            DELETE FROM movimientos_puntos WHERE id = v_resultado_id;
            v_eliminados := v_eliminados + 1;
          END IF;
        END IF;
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
