-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 172: lotes / FEFO históricos como entidad del wizard
-- (Punto 10 del plan de migraciones, P2)
--
-- Reglas de diseño (igual que precios_clientes/cta_cte): el producto debe
-- EXISTIR ya (se resuelve por código en el mapeo, no se autocrea). El
-- depósito sigue el mismo criterio que la migración de productos: si la
-- fila trae uno, se resuelve/autocrea por nombre vía migracion_resolver_
-- deposito (migración 157); si no, cae al depósito elegido para la sesión
-- o al principal de la empresa.
--
-- Decisión de producto explícita (para no repetir la ambigüedad de
-- cta_cte/saldo_inicial que señala el punto 4 del análisis): esta entidad
-- SOLO inserta en `lotes` (trazabilidad/FEFO). NO toca la tabla `stock`
-- agregada — si el stock inicial ya se cargó vía la migración de productos
-- (o a mano), sumar acá duplicaría cantidades. Migrar lotes es para
-- trazabilidad de vencimientos, no para dar de alta stock.
--
-- 1 fila = 1 lote (sin agrupación, mismo tamaño de lote que precios_clientes).
-- Sin dedupe: dos lotes del mismo producto con el mismo número de lote son
-- válidos (ej. reposiciones separadas), así que no hay UNIQUE que lo impida
-- ni falta que lo haya.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.migracion_sesiones DROP CONSTRAINT migracion_sesiones_entidad_check;
ALTER TABLE public.migracion_sesiones ADD CONSTRAINT migracion_sesiones_entidad_check
  CHECK (entidad = ANY (ARRAY[
    'clientes'::text, 'productos'::text, 'pedidos'::text, 'cta_cte'::text,
    'precios_clientes'::text, 'proveedores'::text,
    'ordenes_compra'::text, 'pagos_proveedores'::text, 'lotes'::text
  ]));

CREATE OR REPLACE FUNCTION public.migracion_confirmar_lotes_lote(
  p_sesion_id   UUID,
  p_empresa_id  UUID,
  p_deposito_id UUID,
  p_usuario_id  UUID DEFAULT NULL,
  p_lote_size   INT  DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fila          RECORD;
  v_d             JSONB;
  v_producto_id   UUID;
  v_deposito_fila UUID;
  v_cantidad      NUMERIC;
  v_costo         NUMERIC;
  v_estado        TEXT;
  v_id_final      UUID;
  v_creados       INT := 0;
  v_errores       JSONB := '[]'::jsonb;
  v_procesadas    INT := 0;
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
      v_producto_id := (v_d->>'producto_id_resuelto')::UUID;
      IF v_producto_id IS NULL THEN RAISE EXCEPTION 'Producto no resuelto'; END IF;

      v_cantidad := (v_d->>'cantidad')::NUMERIC;
      IF v_cantidad IS NULL OR v_cantidad < 0 THEN RAISE EXCEPTION 'Cantidad inválida'; END IF;

      v_costo := NULLIF(TRIM(v_d->>'costo_unitario'), '')::NUMERIC;

      -- Migración 157 (reutilizada): depósito por fila si viene, si no el
      -- de la sesión (que ya trae el fallback al principal resuelto en JS).
      v_deposito_fila := COALESCE(
        migracion_resolver_deposito(p_empresa_id, v_d->>'deposito'),
        p_deposito_id
      );

      v_estado := NULLIF(LOWER(TRIM(v_d->>'estado_lote')), '');
      IF v_estado IS NOT NULL AND v_estado NOT IN ('activo', 'agotado', 'vencido') THEN
        RAISE EXCEPTION 'Estado de lote inválido: %', v_estado;
      END IF;

      INSERT INTO lotes (
        empresa_id, producto_id, deposito_id, numero_lote,
        cantidad, costo_unitario, fecha_fabricacion, fecha_vencimiento, estado
      )
      VALUES (
        p_empresa_id, v_producto_id, v_deposito_fila,
        NULLIF(TRIM(v_d->>'numero_lote'), ''),
        v_cantidad, COALESCE(v_costo, 0),
        NULLIF(v_d->>'fecha_fabricacion', '')::DATE,
        NULLIF(v_d->>'fecha_vencimiento', '')::DATE,
        COALESCE(v_estado, 'activo')
      )
      RETURNING id INTO v_id_final;

      v_creados := v_creados + 1;

      UPDATE migracion_staging_rows
         SET procesado_en = now(), entidad_resultado_id = v_id_final
       WHERE id = v_fila.id;
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
    'actualizados', 0,
    'errores', v_errores,
    'hay_mas', v_procesadas >= p_lote_size
  );
END;
$function$;

-- ─── Deshacer: extender migracion_deshacer_sesion con 'lotes' ────────────────
-- Un lote puede tener ofertas de liquidación asociadas (FK con ON DELETE
-- CASCADE) o reservas activas (cantidad_reservada > 0) generadas después de
-- la migración — en esos casos no se borra automáticamente, igual que el
-- resto de las entidades con dependientes.
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
BEGIN
  IF p_entidad NOT IN ('clientes', 'productos', 'pedidos', 'cta_cte', 'precios_clientes', 'proveedores', 'ordenes_compra', 'pagos_proveedores', 'lotes') THEN
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
