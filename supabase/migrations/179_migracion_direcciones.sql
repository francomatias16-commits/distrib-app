-- 179_migracion_direcciones.sql
-- Cierre del punto 18 del plan de migraciones: direcciones de entrega como
-- entidad propia del wizard (bulk import), no solo CRUD manual uno por uno
-- (eso ya existía desde la migración 178 vía lib/repos/cliente-direcciones.js
-- y las rutas de lib/handlers/clientes.js).
--
-- Mismo patrón que comprobantes_historicos (migración 177): 1 fila = 1
-- registro, sin agrupación. Cliente DEBE existir ya (se resuelve por CUIT,
-- nunca se autocrea — mismo criterio que cta_cte/precios_clientes/cheques).
--
-- Dedupe: a diferencia de cheques (sin control porque no hay identificador
-- natural confiable), acá se agrega UNIQUE(empresa_id, cliente_id,
-- domicilio) + ON CONFLICT DO NOTHING en la RPC, para que reprocesar el
-- mismo archivo no duplique direcciones.
--
-- La primera dirección de cada cliente (ya existente o recién migrada en
-- la misma corrida) se marca es_principal automáticamente — mismo criterio
-- que crearDireccion() en lib/repos/cliente-direcciones.js, para no chocar
-- contra el índice único parcial idx_cliente_direcciones_principal_unica.

-- ═══════════════════════════════════════════════════════════════════════
-- 1) Entidad nueva del wizard de migración
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE migracion_sesiones DROP CONSTRAINT IF EXISTS migracion_sesiones_entidad_check;
ALTER TABLE migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY[
    'clientes','productos','pedidos','cta_cte','precios_clientes',
    'proveedores','ordenes_compra','pagos_proveedores','lotes',
    'categorias','depositos','listas_precios','zonas',
    'cheques','puntos_fidelizacion','ventas_pos',
    'comprobantes_historicos','direcciones'
  ]::text[]));

-- ═══════════════════════════════════════════════════════════════════════
-- 2) Dedupe real: constraint sobre cliente_direcciones
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.cliente_direcciones
  ADD CONSTRAINT cliente_direcciones_dedupe UNIQUE (empresa_id, cliente_id, domicilio);

-- ═══════════════════════════════════════════════════════════════════════
-- 3) RPC de confirmación por lote (mismo patrón que comprobantes/cheques)
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.migracion_confirmar_direcciones_lote(
  p_sesion_id  UUID,
  p_empresa_id UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_lote_size  INT DEFAULT 500
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fila         RECORD;
  v_d            JSONB;
  v_cliente_id   UUID;
  v_creados      INT := 0;
  v_omitidos     INT := 0;
  v_errores      JSONB := '[]'::jsonb;
  v_nuevo_id     UUID;
  v_procesadas   INT := 0;
  v_es_principal BOOLEAN;
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
      v_cliente_id := NULLIF(v_d->>'cliente_id_resuelto', '')::UUID;
      IF v_cliente_id IS NULL THEN
        RAISE EXCEPTION 'Cliente no resuelto';
      END IF;

      SELECT NOT EXISTS (
        SELECT 1 FROM cliente_direcciones WHERE cliente_id = v_cliente_id
      ) INTO v_es_principal;

      INSERT INTO cliente_direcciones (
        empresa_id, cliente_id, etiqueta, domicilio, localidad, provincia, lat, lng, es_principal, notas
      ) VALUES (
        p_empresa_id,
        v_cliente_id,
        COALESCE(NULLIF(TRIM(v_d->>'etiqueta'), ''), 'Principal'),
        TRIM(v_d->>'domicilio'),
        NULLIF(TRIM(v_d->>'localidad'), ''),
        NULLIF(TRIM(v_d->>'provincia'), ''),
        NULLIF(v_d->>'lat', '')::NUMERIC,
        NULLIF(v_d->>'lng', '')::NUMERIC,
        v_es_principal,
        NULLIF(TRIM(v_d->>'notas'), '')
      )
      ON CONFLICT ON CONSTRAINT cliente_direcciones_dedupe DO NOTHING
      RETURNING id INTO v_nuevo_id;

      IF v_nuevo_id IS NOT NULL THEN
        v_creados := v_creados + 1;
        UPDATE migracion_staging_rows SET procesado_en = now(), entidad_resultado_id = v_nuevo_id WHERE id = v_fila.id;
      ELSE
        v_omitidos := v_omitidos + 1;
        UPDATE migracion_staging_rows SET procesado_en = now(), error_ejecucion = 'omitido: ya existe (mismo cliente + domicilio)' WHERE id = v_fila.id;
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

-- ═══════════════════════════════════════════════════════════════════════
-- 4) Soporte de "deshacer" para direcciones
-- ═══════════════════════════════════════════════════════════════════════
-- Nota de housekeeping: comprobantes_historicos (mig. 177) y las 4
-- entidades "maestro" (categorias/depositos/listas_precios/zonas, mig.
-- 173) tampoco están hoy en la lista blanca de migracion_deshacer_sesion
-- — quedó pendiente en esas migraciones, no es parte de este alcance.
-- Acá sí se agrega 'direcciones' porque es el objeto de esta migración.
-- cliente_direcciones no tiene ninguna FK apuntándole desde otra tabla
-- (verificado contra information_schema), así que el borrado es
-- incondicional, sin chequeo de dependientes.
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
  v_cnt_ofertas     INT;
  v_cnt_reservado   NUMERIC;
  v_cnt_pagos_pos   INT;
  v_cnt_fact_pos    INT;
  v_cnt_devol_pos   INT;
  v_cheque_cobro    UUID;
  v_mov             RECORD;
  v_saldo           RECORD;
BEGIN
  IF p_entidad NOT IN ('clientes', 'productos', 'pedidos', 'cta_cte', 'precios_clientes', 'proveedores', 'ordenes_compra', 'pagos_proveedores', 'lotes', 'cheques', 'puntos_fidelizacion', 'ventas_pos', 'direcciones') THEN
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

      ELSIF p_entidad = 'direcciones' THEN
        DELETE FROM cliente_direcciones WHERE id = v_resultado_id AND empresa_id = p_empresa_id;
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
