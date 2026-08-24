-- ═══════════════════════════════════════════════════════════════════════════
-- 469_recepcionar_orden_compra_detalle_lotes.sql [reconstruida, ver 462]
--
-- [Reconstrucción retroactiva — función ya vigente en producción, leída
--  directamente desde pg_proc. No-op funcional sobre la base actual.]
--
-- recepcionar_orden_compra() (con fix de IVA de la mig. 453): por cada línea
-- recibida crea un lote 'OC-<orden_id>-<fecha>' con el costo_unitario de la
-- recepción, sincroniza `stock` y deja el alta correspondiente en
-- movimientos_stock_lotes. Actualiza costo del producto, cantidad_recibida
-- del ítem de la OC y el estado/montos de la orden (recibida / recibida_parcial).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.recepcionar_orden_compra(
  p_empresa_id  uuid,
  p_orden_id    uuid,
  p_items       jsonb,
  p_usuario_id  uuid DEFAULT NULL::uuid,
  p_deposito_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deposito_id     uuid;
  v_item            jsonb;
  v_prod_id         uuid;
  v_cant            numeric;
  v_costo           numeric;
  v_iva_pct         numeric;
  v_stock_actual    numeric;
  v_stock_nuevo     numeric;
  v_items_proc      int := 0;
  v_total_recib     numeric := 0;
  v_items_completos boolean;
  v_lote_id         uuid;
  v_mov_id          uuid;
BEGIN
  PERFORM public.assert_empresa_access(p_empresa_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.ordenes_compra
    WHERE id = p_orden_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Orden no encontrada');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS elem
    WHERE (elem->>'producto_id') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.productos pr
        WHERE pr.id = (elem->>'producto_id')::uuid
          AND pr.empresa_id = p_empresa_id
      )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Uno o más productos no pertenecen a esta empresa');
  END IF;

  v_deposito_id := p_deposito_id;

  IF v_deposito_id IS NULL THEN
    SELECT id INTO v_deposito_id
      FROM public.depositos
     WHERE empresa_id = p_empresa_id
     ORDER BY es_principal DESC, id ASC
     LIMIT 1;
  END IF;

  IF v_deposito_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La empresa no tiene depósitos cargados');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.depositos WHERE id = v_deposito_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Depósito inválido para esta empresa');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_prod_id := (v_item->>'producto_id')::uuid;
    v_cant    := COALESCE((v_item->>'cantidad_recibida')::numeric, 0);
    v_costo   := COALESCE((v_item->>'precio_costo')::numeric, 0);

    IF v_cant <= 0 OR v_prod_id IS NULL THEN CONTINUE; END IF;

    SELECT COALESCE(oci.iva_pct, 21) INTO v_iva_pct
      FROM public.ordenes_compra_items oci
     WHERE oci.orden_id = p_orden_id AND oci.producto_id = v_prod_id
     LIMIT 1;

    INSERT INTO public.stock (producto_id, deposito_id, cantidad)
    VALUES (v_prod_id, v_deposito_id, 0)
    ON CONFLICT (producto_id, deposito_id) DO NOTHING;

    SELECT cantidad INTO v_stock_actual
      FROM public.stock
     WHERE producto_id = v_prod_id AND deposito_id = v_deposito_id
     FOR UPDATE;

    v_stock_nuevo := COALESCE(v_stock_actual, 0) + v_cant;

    UPDATE public.stock
       SET cantidad = v_stock_nuevo, updated_at = now()
     WHERE producto_id = v_prod_id AND deposito_id = v_deposito_id;

    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      costo_unitario, estado
    ) VALUES (
      p_empresa_id, v_prod_id, v_deposito_id,
      'OC-' || p_orden_id::text || '-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      v_cant, v_cant,
      v_costo, 'activo'
    ) RETURNING id INTO v_lote_id;

    INSERT INTO public.movimientos_stock (
      producto_id, deposito_id, tipo, cantidad,
      referencia, referencia_id, usuario_id, notas, costo_unitario
    ) VALUES (
      v_prod_id, v_deposito_id, 'ingreso', v_cant,
      'orden_compra', p_orden_id, p_usuario_id,
      'Recepción OC ' || p_orden_id::text, NULLIF(v_costo, 0)
    ) RETURNING id INTO v_mov_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_id, v_lote_id, v_cant, 'alta');

    UPDATE public.productos
       SET costo      = CASE WHEN v_costo > 0 THEN v_costo ELSE costo END,
           updated_at = now()
     WHERE id = v_prod_id AND empresa_id = p_empresa_id;

    UPDATE public.ordenes_compra_items
       SET cantidad_recibida = COALESCE(cantidad_recibida, 0) + v_cant
     WHERE orden_id = p_orden_id AND producto_id = v_prod_id;

    v_total_recib := v_total_recib + (v_cant * v_costo * (1 + v_iva_pct / 100));
    v_items_proc  := v_items_proc + 1;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.ordenes_compra_items
     WHERE orden_id = p_orden_id AND cantidad_recibida < cantidad
  ) INTO v_items_completos;

  UPDATE public.ordenes_compra oc
     SET estado          = CASE WHEN v_items_completos THEN 'recibida' ELSE 'recibida_parcial' END,
         fecha_recepcion = now(),
         subtotal        = CASE WHEN v_total_recib > 0 THEN sub.subtotal_recibido ELSE oc.subtotal END,
         iva_total       = CASE WHEN v_total_recib > 0 THEN sub.iva_recibido ELSE oc.iva_total END,
         total           = CASE WHEN v_total_recib > 0 THEN v_total_recib ELSE oc.total END
    FROM (
      SELECT
        COALESCE(SUM(oci.cantidad_recibida * oci.precio_costo), 0) AS subtotal_recibido,
        COALESCE(SUM(oci.cantidad_recibida * oci.precio_costo * oci.iva_pct / 100), 0) AS iva_recibido
      FROM public.ordenes_compra_items oci
      WHERE oci.orden_id = p_orden_id
    ) sub
   WHERE oc.id = p_orden_id AND oc.empresa_id = p_empresa_id;

  RETURN jsonb_build_object(
    'ok',               true,
    'items_procesados', v_items_proc,
    'total_recibido',   v_total_recib,
    'deposito_id',      v_deposito_id,
    'estado_oc',        CASE WHEN v_items_completos THEN 'recibida' ELSE 'recibida_parcial' END
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.recepcionar_orden_compra TO authenticated, service_role;

COMMENT ON FUNCTION public.recepcionar_orden_compra IS
  'Recepciona una orden de compra: por cada línea crea un lote OC-<orden>-<fecha>, '
  'sincroniza stock y deja el alta en movimientos_stock_lotes (mig. 462).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '469_recepcionar_orden_compra_detalle_lotes.sql', '469', 'claude-session',
  'Reconstrucción retroactiva: recepcionar_orden_compra (ya con fix de IVA de la mig. 453) crea un lote OC-<fecha> por línea recibida y deja el alta en movimientos_stock_lotes.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
