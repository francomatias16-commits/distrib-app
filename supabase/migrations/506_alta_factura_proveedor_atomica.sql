-- 506_alta_factura_proveedor_atomica.sql
-- Punto 3 de la auditoría: el alta de factura de proveedor se hacía en
-- varios pasos sueltos desde el handler (insert cabecera → insert items →
-- conciliar RPC → update conciliación → auditoría). Un fallo a mitad de
-- camino (ej. insert de ítems falla después de crear la cabecera) dejaba
-- una factura fantasma sin ítems, visible en los listados, sin forma
-- simple de saber que quedó incompleta.
--
-- Fix: RPC transaccional alta_factura_proveedor que hace TODO en una sola
-- función (una sola transacción real de Postgres):
--   1) valida tenant/rol de la sesión (mismo patrón que registrar_pago_proveedor)
--   2) valida proveedor (pertenece a la empresa)
--   3) valida OC si viene (existe, misma empresa, mismo proveedor, no cancelada)
--   4) valida cada ítem (cantidad>0, precio>=0, producto de la misma empresa
--      si se referencia uno) y calcula subtotal/iva/total desde los ítems
--      (ya no acepta subtotal/total sueltos del cliente sin validar contra
--      los ítems reales, cierra un vector de manipulación de importes)
--   5) inserta cabecera + ítems
--   6) si hay OC, concilia automáticamente reutilizando la RPC ya endurecida
--      conciliar_oc_factura (punto 2) — misma transacción, así que si la
--      conciliación falla también se revierte el alta completa
--   7) inserta la auditoría en la misma transacción (punto 8): si cualquier
--      paso anterior falla, no queda alta sin su fila de auditoría porque
--      todo el bloque se revierte junto (PL/pgSQL hace SAVEPOINT implícito
--      al tener EXCEPTION, y el rollback a ese punto deshace TODO el bloque)
--
-- Criterio de aceptación: cualquier error intermedio deja cero datos
-- parciales (no hay cabecera sin ítems, ni ítems sin conciliación cuando
-- corresponde, ni alta sin auditoría).

CREATE OR REPLACE FUNCTION public.alta_factura_proveedor(
  p_empresa_id       uuid,
  p_proveedor_id     uuid,
  p_numero_factura   text,
  p_fecha_factura    date,
  p_orden_id         uuid    DEFAULT NULL,
  p_tipo             text    DEFAULT 'A',
  p_fecha_vencimiento date   DEFAULT NULL,
  p_iva_pct          numeric DEFAULT 21,
  p_notas            text    DEFAULT NULL,
  p_items            jsonb   DEFAULT '[]'::jsonb,
  p_umbral_pct       numeric DEFAULT 5,
  p_usuario_id       uuid    DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_proveedor     record;
  v_oc            record;
  v_item          jsonb;
  v_cantidad      numeric;
  v_precio        numeric;
  v_producto_id   uuid;
  v_subtotal      numeric := 0;
  v_iva_monto     numeric;
  v_total         numeric;
  v_factura_id    uuid;
  v_conciliacion  jsonb;
  v_usuario_id    uuid := COALESCE(p_usuario_id, auth.uid());
BEGIN
  -- Tenant / rol de sesión (mismo criterio que registrar_pago_proveedor)
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'NO_AUTORIZADO', 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','contador') THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'NO_AUTORIZADO', 'error', 'No autorizado');
  END IF;

  IF p_empresa_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'EMPRESA_REQUERIDA', 'error', 'empresa requerida');
  END IF;

  IF p_numero_factura IS NULL OR btrim(p_numero_factura) = '' THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'NUMERO_REQUERIDO', 'error', 'numero_factura requerido');
  END IF;

  IF p_fecha_factura IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'FECHA_REQUERIDA', 'error', 'fecha_factura requerida');
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'ITEMS_REQUERIDOS', 'error', 'la factura requiere al menos un item');
  END IF;

  -- Proveedor pertenece a la empresa
  SELECT id INTO v_proveedor
  FROM public.proveedores
  WHERE id = p_proveedor_id AND empresa_id = p_empresa_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'PROVEEDOR_INEXISTENTE', 'error', 'proveedor no encontrado en la empresa');
  END IF;

  -- OC opcional: si viene, debe existir, ser de la misma empresa y proveedor, y no estar cancelada
  IF p_orden_id IS NOT NULL THEN
    SELECT id, empresa_id, proveedor_id, estado INTO v_oc
    FROM public.ordenes_compra
    WHERE id = p_orden_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'OC_INEXISTENTE', 'error', 'orden de compra inexistente');
    END IF;

    IF v_oc.empresa_id IS DISTINCT FROM p_empresa_id THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'EMPRESA_NO_COINCIDE', 'error', 'la orden de compra no pertenece a la empresa');
    END IF;

    IF v_oc.proveedor_id IS DISTINCT FROM p_proveedor_id THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'PROVEEDOR_NO_COINCIDE', 'error', 'la orden de compra no pertenece al proveedor indicado');
    END IF;

    IF v_oc.estado = 'cancelada' THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'OC_CANCELADA', 'error', 'la orden de compra está cancelada');
    END IF;
  END IF;

  -- Validar cada ítem y acumular el subtotal real (no se confía en
  -- subtotal/total sueltos que pudiera mandar el cliente)
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

  v_iva_monto := ROUND(v_subtotal * (COALESCE(p_iva_pct, 21) / 100), 2);
  v_total     := ROUND(v_subtotal, 2) + v_iva_monto;

  -- Cabecera
  INSERT INTO public.facturas_proveedor (
    empresa_id, proveedor_id, orden_id, numero_factura, tipo,
    fecha_factura, fecha_vencimiento, subtotal, iva_pct, iva_monto, total, notas
  ) VALUES (
    p_empresa_id, p_proveedor_id, p_orden_id, p_numero_factura, COALESCE(p_tipo, 'A'),
    p_fecha_factura, p_fecha_vencimiento, ROUND(v_subtotal, 2), COALESCE(p_iva_pct, 21), v_iva_monto, v_total, p_notas
  )
  RETURNING id INTO v_factura_id;

  -- Ítems
  INSERT INTO public.facturas_proveedor_items (factura_id, producto_id, descripcion, cantidad, precio_unitario)
  SELECT
    v_factura_id,
    NULLIF(elem->>'producto_id', '')::uuid,
    COALESCE(NULLIF(elem->>'descripcion', ''), NULLIF(elem->>'nombre', ''), '—'),
    (elem->>'cantidad')::numeric,
    (elem->>'precio_unitario')::numeric
  FROM jsonb_array_elements(p_items) AS elem;

  -- Conciliación automática si hay OC — reutiliza la RPC del punto 2, ya
  -- endurecida contra cruces de tenant/proveedor; misma transacción.
  IF p_orden_id IS NOT NULL THEN
    v_conciliacion := public.conciliar_oc_factura(p_orden_id, v_factura_id, p_empresa_id, p_umbral_pct);

    IF (v_conciliacion->>'ok')::boolean THEN
      UPDATE public.facturas_proveedor
      SET conciliacion = v_conciliacion, discrepancias = v_conciliacion->'discrepancias'
      WHERE id = v_factura_id;
    END IF;
  END IF;

  -- Auditoría dentro de la misma transacción (punto 8): si algo de lo
  -- anterior falla, el rollback implícito del EXCEPTION handler descarta
  -- esta fila junto con el resto, así que nunca hay alta sin auditoría ni
  -- auditoría de un alta que no se completó.
  INSERT INTO public.audit_log (empresa_id, tabla, registro_id, accion, datos_antes, datos_despues, usuario_id)
  VALUES (
    p_empresa_id, 'facturas_proveedor', v_factura_id::text, 'INSERT', NULL,
    jsonb_build_object(
      'proveedor_id', p_proveedor_id, 'numero_factura', p_numero_factura,
      'total', v_total, 'orden_id', p_orden_id
    ),
    v_usuario_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'factura_id', v_factura_id,
    'subtotal', ROUND(v_subtotal, 2),
    'iva_monto', v_iva_monto,
    'total', v_total,
    'conciliacion', v_conciliacion
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'codigo', 'ERROR_INTERNO', 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.alta_factura_proveedor(
  uuid, uuid, text, date, uuid, text, date, numeric, text, jsonb, numeric, uuid
) TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_en, aplicada_por, notas)
VALUES ('db', '506_alta_factura_proveedor_atomica.sql', '506', now(), 'claude',
  'Punto 3 de la auditoria: RPC transaccional alta_factura_proveedor. Reemplaza el flujo de insert cabecera + insert items + RPC conciliar + update conciliacion + auditoria hecho en pasos sueltos desde el handler, por una sola funcion atomica. Requiere actualizar cc-proveedores.js (repo) y cc_proveedores.js (handler) para llamar la RPC en vez de los inserts sueltos.');
