-- =============================================================================
-- 341_fix_recepcionar_orden_compra_stock_real.sql
--
-- Bug: recepcionar_orden_compra() (migración 054) es llamada real desde
-- lib/handlers/proveedores.js cuando se confirma la recepción de una OC, pero:
--
--   1) Solo suma en productos.stock_actual (columna suelta), nunca escribe en
--      la tabla `stock` por depósito. Todo el módulo de Stock (grilla de
--      depósitos, "Reposición sugerida" vía analizar_stock_autonomo(), el
--      modal de ajuste, ajustar_stock) lee/escribe exclusivamente `stock`.
--      Resultado: la mercadería recibida no aparece en ningún depósito real,
--      no se puede vender/transferir/ajustar, y no genera lote FEFO.
--   2) Inserta en movimientos_stock con columnas (empresa_id, referencia_tipo)
--      que no existen en la tabla real (ver 001_schema.sql / backup.sql) —
--      la función fallaría en tiempo de ejecución y el EXCEPTION handler
--      devuelve ok:false silenciosamente en vez de propagar el error real.
--   3) Sobrescribe ordenes_compra_items.cantidad con la cantidad recibida en
--      vez de acumular en cantidad_recibida, rompiendo el cálculo de recepción
--      parcial vs. total.
--
-- Fix (preservando la firma que ya usa proveedores.js, agregando
-- p_deposito_id opcional al final):
--   1) Resuelve depósito destino: el pasado por parámetro, o el depósito
--      marcado es_principal de la empresa, o el primero por id si no hay
--      principal marcado.
--   2) Lockea la fila de `stock` (mismo patrón que ajustar_stock, migración
--      201) y la actualiza de verdad — la tabla `productos` en producción NO
--      tiene columna `stock_actual` (drift respecto del snapshot local en
--      docs/schema-snapshots/backup.sql, confirmado en vivo contra
--      information_schema.columns); el stock real vive exclusivamente en
--      `stock` por depósito. Sí se sincroniza `productos.costo` con el
--      último costo de compra.
--   3) Crea lote FEFO (mismo patrón que ajustar_stock cuando p_delta > 0).
--   4) Inserta en movimientos_stock con las columnas reales de la tabla.
--   5) Acumula cantidad_recibida en vez de pisar cantidad; calcula estado de
--      la OC como 'recibida' solo si TODOS los items están completos, o
--      'recibida_parcial' si falta alguno.
--
-- Lección de la migración 340: si se agrega un parámetro con DEFAULT a una
-- función existente, PostgREST puede terminar viendo dos firmas que matchean
-- la misma llamada (ambigüedad PGRST203). Por eso acá se dropea explícitamente
-- la firma vieja de 4 argumentos antes de crear la de 5.
-- =============================================================================

DROP FUNCTION IF EXISTS public.recepcionar_orden_compra(uuid, uuid, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.recepcionar_orden_compra(
  p_empresa_id   uuid,
  p_orden_id     uuid,
  p_items        jsonb,
  p_usuario_id   uuid DEFAULT NULL,
  p_deposito_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deposito_id     uuid;
  v_item            jsonb;
  v_prod_id         uuid;
  v_cant            numeric;
  v_costo           numeric;
  v_stock_actual    numeric;
  v_stock_nuevo     numeric;
  v_items_proc      int := 0;
  v_total_recib     numeric := 0;
  v_items_completos boolean;
BEGIN
  -- Validar que la OC pertenece a la empresa
  IF NOT EXISTS (
    SELECT 1 FROM public.ordenes_compra
    WHERE id = p_orden_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Orden no encontrada');
  END IF;

  -- Resolver depósito destino: el pasado por parámetro > el principal de la
  -- empresa > el primero por id. Si la empresa no tiene ningún depósito
  -- cargado, no hay dónde recepcionar.
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

  -- Procesar cada item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_prod_id := (v_item->>'producto_id')::uuid;
    v_cant    := COALESCE((v_item->>'cantidad_recibida')::numeric, 0);
    v_costo   := COALESCE((v_item->>'precio_costo')::numeric, 0);

    IF v_cant <= 0 OR v_prod_id IS NULL THEN CONTINUE; END IF;

    -- Asegurar fila de stock y lockearla (mismo patrón que ajustar_stock)
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

    -- Lote FEFO de ingreso (mismo patrón que ajustar_stock con p_delta > 0)
    INSERT INTO public.lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      costo_unitario, estado
    ) VALUES (
      p_empresa_id, v_prod_id, v_deposito_id,
      'OC-' || p_orden_id::text || '-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
      v_cant, v_cant,
      v_costo, 'activo'
    );

    -- Movimiento de stock con las columnas reales de la tabla
    INSERT INTO public.movimientos_stock (
      producto_id, deposito_id, tipo, cantidad,
      referencia, referencia_id, usuario_id, notas, costo_unitario
    ) VALUES (
      v_prod_id, v_deposito_id, 'ingreso', v_cant,
      'orden_compra', p_orden_id, p_usuario_id,
      'Recepción OC ' || p_orden_id::text, NULLIF(v_costo, 0)
    );

    -- Actualizar costo del producto con el último costo de compra (la tabla
    -- productos NO tiene columna stock_actual en producción — el stock real
    -- vive exclusivamente en la tabla `stock` por depósito, ya actualizada
    -- arriba).
    UPDATE public.productos
       SET costo      = CASE WHEN v_costo > 0 THEN v_costo ELSE costo END,
           updated_at = now()
     WHERE id = v_prod_id AND empresa_id = p_empresa_id;

    -- Acumular cantidad_recibida (antes pisaba `cantidad`, rompiendo el
    -- cálculo de recepción parcial vs. total)
    UPDATE public.ordenes_compra_items
       SET cantidad_recibida = COALESCE(cantidad_recibida, 0) + v_cant
     WHERE orden_id = p_orden_id AND producto_id = v_prod_id;

    v_total_recib := v_total_recib + (v_cant * v_costo);
    v_items_proc  := v_items_proc + 1;
  END LOOP;

  -- Estado de la OC: 'recibida' solo si todos los items llegaron completos,
  -- 'recibida_parcial' si falta alguno.
  SELECT NOT EXISTS (
    SELECT 1 FROM public.ordenes_compra_items
     WHERE orden_id = p_orden_id AND cantidad_recibida < cantidad
  ) INTO v_items_completos;

  UPDATE public.ordenes_compra
     SET estado          = CASE WHEN v_items_completos THEN 'recibida' ELSE 'recibida_parcial' END,
         fecha_recepcion = now(),
         total           = CASE WHEN v_total_recib > 0 THEN v_total_recib ELSE total END
   WHERE id = p_orden_id AND empresa_id = p_empresa_id;

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
$$;

GRANT EXECUTE ON FUNCTION public.recepcionar_orden_compra(uuid, uuid, jsonb, uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.recepcionar_orden_compra IS
  'Recepciona una OC: lockea y actualiza la tabla stock por depósito (no solo '
  'productos.stock_actual), genera lote FEFO, registra el movimiento con las '
  'columnas reales de movimientos_stock, acumula cantidad_recibida por item y '
  'marca la OC como recibida/recibida_parcial según corresponda.';

NOTIFY pgrst, 'reload schema';
