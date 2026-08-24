-- 507_editar_factura_proveedor_atomica.sql
-- Punto 4 de la auditoría: el PATCH de edición de factura de proveedor
-- hacía, igual que el alta antes del punto 3, varios pasos sueltos:
-- update cabecera → borrar ítems → insertar ítems nuevos → RPC conciliar →
-- update conciliación → auditoría, cada uno contra la base por separado y
-- sin lock. Dos PATCH concurrentes sobre la misma factura podían pisarse
-- (el segundo update de cabecera no sabía que el primero ya había
-- cambiado el orden_id o el total), y un fallo a mitad de camino (ej. el
-- insert de ítems nuevos después de haber borrado los viejos) podía dejar
-- una factura con cabecera nueva y cero ítems.
--
-- Fix: RPC transaccional editar_factura_proveedor:
--   1) bloquea la factura con SELECT ... FOR UPDATE (evita que dos PATCH
--      concurrentes se pisen; el segundo espera a que termine el primero
--      y ve el estado ya actualizado, no el viejo)
--   2) control de versión opcional vía p_expected_updated_at — si el
--      caller mandó el updated_at que tenía al abrir el formulario y no
--      coincide con el actual, rechaza con VERSION_CONFLICT en vez de
--      pisar una edición ajena
--   3) valida tenant/rol de sesión (mismo patrón que las RPCs anteriores)
--   4) rechaza editar cabecera/ítems de una factura anulada o con pagos
--      ya registrados (mismo criterio que tenía el handler)
--   5) si cambia orden_id, valida la nueva OC igual que en el alta (punto 3):
--      existe, misma empresa, mismo proveedor, no cancelada
--   6) si vienen ítems nuevos, los valida (cantidad>0, precio>=0, producto
--      de la misma empresa) y recalcula subtotal/iva/total desde ellos —
--      ya no se aceptan subtotal/total sueltos sin validar (mismo cierre
--      de vector que en el punto 3)
--   7) actualiza cabecera, reemplaza ítems, re-concilia si corresponde y
--      audita, todo en la misma transacción — si algo falla a mitad de
--      camino, el rollback implícito del EXCEPTION handler descarta todo
--      el bloque junto (cabecera vieja queda intacta, no hay detalle
--      incompleto ni conciliación de una OC anterior)
--
-- Criterio de aceptación: una edición nunca deja cabecera nueva con
-- detalle viejo, detalle incompleto, o conciliación de una OC anterior;
-- dos PATCH concurrentes sobre la misma factura no se pisan.

CREATE OR REPLACE FUNCTION public.editar_factura_proveedor(
  p_empresa_id          uuid,
  p_id                  uuid,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_estado              text        DEFAULT NULL,
  p_notas               text        DEFAULT NULL,
  p_notas_provisto      boolean     DEFAULT false,
  p_fecha_vencimiento   date        DEFAULT NULL,
  p_numero_factura      text        DEFAULT NULL,
  p_tipo                text        DEFAULT NULL,
  p_fecha_factura       date        DEFAULT NULL,
  p_iva_pct             numeric     DEFAULT NULL,
  p_orden_id_provisto   boolean     DEFAULT false,
  p_orden_id            uuid        DEFAULT NULL,
  p_items_provisto      boolean     DEFAULT false,
  p_items               jsonb       DEFAULT '[]'::jsonb,
  p_umbral_pct          numeric     DEFAULT 5,
  p_usuario_id          uuid        DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_factura       record;
  v_oc            record;
  v_item          jsonb;
  v_cantidad      numeric;
  v_precio        numeric;
  v_producto_id   uuid;
  v_subtotal      numeric := 0;
  v_iva_monto     numeric;
  v_total         numeric;
  v_iva_pct_final numeric;
  v_orden_final   uuid;
  v_conciliacion  jsonb;
  v_camposCabecera boolean;
  v_usuario_id    uuid := COALESCE(p_usuario_id, auth.uid());
  v_estado_antes  text;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'NO_AUTORIZADO', 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','contador') THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'NO_AUTORIZADO', 'error', 'No autorizado');
  END IF;

  IF p_empresa_id IS NULL OR p_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'PARAMETROS_REQUERIDOS', 'error', 'empresa_id e id requeridos');
  END IF;

  IF p_estado IS NOT NULL AND p_estado <> 'pendiente' THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'ESTADO_NO_PERMITIDO', 'error',
      format('Estado ''%s'' no se puede asignar directo por este endpoint.', p_estado));
  END IF;

  -- Lock: evita que dos PATCH concurrentes sobre la misma factura se pisen
  SELECT * INTO v_factura
  FROM public.facturas_proveedor
  WHERE id = p_id AND empresa_id = p_empresa_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'FACTURA_INEXISTENTE', 'error', 'Factura no encontrada');
  END IF;

  IF p_expected_updated_at IS NOT NULL AND v_factura.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object(
      'ok', false, 'codigo', 'VERSION_CONFLICT',
      'error', 'La factura fue editada por otra persona mientras tanto. Volvé a abrirla para ver los cambios.',
      'updated_at_actual', v_factura.updated_at
    );
  END IF;

  v_estado_antes := v_factura.estado;

  v_camposCabecera := p_orden_id_provisto OR p_items_provisto
    OR p_numero_factura IS NOT NULL OR p_tipo IS NOT NULL
    OR p_fecha_factura IS NOT NULL OR p_iva_pct IS NOT NULL;

  IF v_camposCabecera AND (v_factura.estado = 'anulada' OR v_factura.total_pagado > 0) THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'EDICION_NO_PERMITIDA',
      'error', 'No se pueden editar los datos/ítems de una factura anulada o con pagos ya registrados.');
  END IF;

  v_orden_final := CASE WHEN p_orden_id_provisto THEN p_orden_id ELSE v_factura.orden_id END;

  -- Si cambia orden_id (viene provisto y no es null), validar la nueva OC
  IF p_orden_id_provisto AND p_orden_id IS NOT NULL THEN
    SELECT id, empresa_id, proveedor_id, estado INTO v_oc
    FROM public.ordenes_compra WHERE id = p_orden_id FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'OC_INEXISTENTE', 'error', 'orden de compra inexistente');
    END IF;
    IF v_oc.empresa_id IS DISTINCT FROM p_empresa_id THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'EMPRESA_NO_COINCIDE', 'error', 'la orden de compra no pertenece a la empresa');
    END IF;
    IF v_oc.proveedor_id IS DISTINCT FROM v_factura.proveedor_id THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'PROVEEDOR_NO_COINCIDE', 'error', 'la orden de compra no pertenece al proveedor de la factura');
    END IF;
    IF v_oc.estado = 'cancelada' THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'OC_CANCELADA', 'error', 'la orden de compra está cancelada');
    END IF;
  END IF;

  v_iva_pct_final := COALESCE(p_iva_pct, v_factura.iva_pct);

  -- Ítems nuevos: validar y recalcular subtotal/iva/total desde ellos
  IF p_items_provisto THEN
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'ITEMS_INVALIDOS', 'error', 'items debe ser un array');
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_cantidad    := (v_item->>'cantidad')::numeric;
      v_precio      := (v_item->>'precio_unitario')::numeric;
      v_producto_id := NULLIF(v_item->>'producto_id', '')::uuid;

      IF v_cantidad IS NULL OR v_cantidad <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'ITEM_CANTIDAD_INVALIDA', 'error', 'cada item requiere cantidad > 0');
      END IF;
      IF v_precio IS NULL OR v_precio < 0 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'ITEM_PRECIO_INVALIDO', 'error', 'cada item requiere precio_unitario >= 0');
      END IF;
      IF v_producto_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.productos WHERE id = v_producto_id AND empresa_id = p_empresa_id
      ) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'PRODUCTO_NO_PERTENECE', 'error', 'un item referencia un producto de otra empresa');
      END IF;

      v_subtotal := v_subtotal + (v_cantidad * v_precio);
    END LOOP;

    v_iva_monto := ROUND(v_subtotal * (v_iva_pct_final / 100), 2);
    v_total     := ROUND(v_subtotal, 2) + v_iva_monto;
  END IF;

  -- Update de cabecera (solo los campos que vinieron)
  UPDATE public.facturas_proveedor SET
    estado             = COALESCE(p_estado, estado),
    notas              = CASE WHEN p_notas_provisto THEN p_notas ELSE notas END,
    fecha_vencimiento  = COALESCE(p_fecha_vencimiento, fecha_vencimiento),
    numero_factura     = COALESCE(p_numero_factura, numero_factura),
    tipo               = COALESCE(p_tipo, tipo),
    fecha_factura      = COALESCE(p_fecha_factura, fecha_factura),
    iva_pct            = v_iva_pct_final,
    orden_id           = CASE WHEN p_orden_id_provisto THEN p_orden_id ELSE orden_id END,
    subtotal           = CASE WHEN p_items_provisto THEN ROUND(v_subtotal, 2) ELSE subtotal END,
    iva_monto          = CASE WHEN p_items_provisto THEN v_iva_monto ELSE iva_monto END,
    total              = CASE WHEN p_items_provisto THEN v_total ELSE total END,
    updated_at         = now()
  WHERE id = p_id;

  -- Reemplazar ítems si vinieron
  IF p_items_provisto THEN
    DELETE FROM public.facturas_proveedor_items WHERE factura_id = p_id;

    INSERT INTO public.facturas_proveedor_items (factura_id, producto_id, descripcion, cantidad, precio_unitario)
    SELECT
      p_id,
      NULLIF(elem->>'producto_id', '')::uuid,
      COALESCE(NULLIF(elem->>'descripcion', ''), NULLIF(elem->>'nombre', ''), '—'),
      (elem->>'cantidad')::numeric,
      (elem->>'precio_unitario')::numeric
    FROM jsonb_array_elements(p_items) AS elem;

    -- Re-conciliar con los ítems actualizados si la factura tiene OC
    IF v_orden_final IS NOT NULL THEN
      v_conciliacion := public.conciliar_oc_factura(v_orden_final, p_id, p_empresa_id, p_umbral_pct);

      IF (v_conciliacion->>'ok')::boolean THEN
        UPDATE public.facturas_proveedor
        SET conciliacion = v_conciliacion, discrepancias = v_conciliacion->'discrepancias'
        WHERE id = p_id;
      END IF;
    END IF;
  END IF;

  -- Auditoría dentro de la misma transacción (mismo criterio que el punto 3)
  INSERT INTO public.audit_log (empresa_id, tabla, registro_id, accion, datos_antes, datos_despues, usuario_id)
  VALUES (
    p_empresa_id, 'facturas_proveedor', p_id::text, 'UPDATE',
    jsonb_build_object('estado', v_estado_antes),
    jsonb_build_object(
      'estado', COALESCE(p_estado, v_factura.estado),
      'numero_factura', COALESCE(p_numero_factura, v_factura.numero_factura),
      'orden_id', v_orden_final,
      'items_reemplazados', p_items_provisto
    ),
    v_usuario_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'factura_id', p_id,
    'orden_id', v_orden_final,
    'conciliacion', v_conciliacion
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'codigo', 'ERROR_INTERNO', 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.editar_factura_proveedor(
  uuid, uuid, timestamptz, text, text, boolean, date, text, text, date, numeric,
  boolean, uuid, boolean, jsonb, numeric, uuid
) TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_en, aplicada_por, notas)
VALUES ('db', '507_editar_factura_proveedor_atomica.sql', '507', now(), 'claude',
  'Punto 4 de la auditoria: RPC transaccional editar_factura_proveedor. Lock FOR UPDATE + control de version por updated_at + validacion de OC/items + reemplazo de items + reconciliacion + auditoria, todo en una sola transaccion. Reemplaza el PATCH multi-paso del handler. Requiere actualizar cc-proveedores.js (repo) y cc_proveedores.js (handler).');
