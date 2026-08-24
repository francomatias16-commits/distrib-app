-- ═══════════════════════════════════════════════════════════════════════════
-- 467_producir_con_insumos_detalle_lotes.sql [reconstruida, ver 462]
--
-- producir_con_insumos(): consume los insumos de la receta por FEFO real vía
-- fn_lotes_consumir_fefo (463) en vez de descontar solo el agregado de
-- `stock`, calcula el costo unitario real ponderado del producto terminado
-- a partir del costo de los lotes de insumo efectivamente consumidos, y deja
-- el detalle completo (consumo de insumos + alta del lote de salida) en
-- movimientos_stock_lotes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.producir_con_insumos(
  p_producto_id uuid,
  p_deposito_id uuid,
  p_cantidad    numeric,
  p_motivo      text DEFAULT 'produccion',
  p_notas       text DEFAULT NULL,
  p_usuario_id  uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id       UUID;
  v_stock_actual     NUMERIC;
  v_stock_nuevo      NUMERIC;
  v_receta           RECORD;
  v_insumo_stock     NUMERIC;
  v_insumo_necesario NUMERIC;
  v_insumo_nuevo     NUMERIC;
  v_consumidos       jsonb := '[]'::jsonb;
  v_tiene_receta     boolean := false;
  v_mov_id           UUID;
  v_lote_salida_id   UUID;
  v_costo_total      NUMERIC := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad a producir debe ser mayor a cero');
  END IF;

  SELECT empresa_id INTO v_empresa_id FROM public.depositos WHERE id = p_deposito_id;
  IF v_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos WHERE id = p_producto_id AND empresa_id = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Producto no encontrado en esta empresa');
  END IF;

  FOR v_receta IN
    SELECT pi.insumo_id, pi.cantidad_por_unidad
      FROM public.producto_insumos pi
     WHERE pi.producto_terminado_id = p_producto_id
     ORDER BY pi.insumo_id
  LOOP
    v_tiene_receta := true;

    INSERT INTO public.stock (producto_id, deposito_id, cantidad)
    VALUES (v_receta.insumo_id, p_deposito_id, 0)
    ON CONFLICT (producto_id, deposito_id) DO NOTHING;

    SELECT cantidad INTO v_insumo_stock
      FROM public.stock
     WHERE producto_id = v_receta.insumo_id AND deposito_id = p_deposito_id
     FOR UPDATE;

    v_insumo_necesario := v_receta.cantidad_por_unidad * p_cantidad;
    v_insumo_nuevo := COALESCE(v_insumo_stock, 0) - v_insumo_necesario;

    IF v_insumo_nuevo < 0 THEN
      RETURN json_build_object(
        'ok', false,
        'error', format(
          'Insumo insuficiente para producir %s unidades: falta stock de un insumo (disponible %s, necesario %s)',
          p_cantidad, COALESCE(v_insumo_stock, 0), v_insumo_necesario
        ),
        'insumo_id', v_receta.insumo_id
      );
    END IF;
  END LOOP;

  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  SELECT cantidad INTO v_stock_actual
    FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id
   FOR UPDATE;

  v_stock_nuevo := COALESCE(v_stock_actual, 0) + p_cantidad;

  FOR v_receta IN
    SELECT pi.insumo_id, pi.cantidad_por_unidad
      FROM public.producto_insumos pi
     WHERE pi.producto_terminado_id = p_producto_id
     ORDER BY pi.insumo_id
  LOOP
    v_insumo_necesario := v_receta.cantidad_por_unidad * p_cantidad;

    SELECT cantidad INTO v_insumo_stock
      FROM public.stock
     WHERE producto_id = v_receta.insumo_id AND deposito_id = p_deposito_id;
    v_insumo_nuevo := v_insumo_stock - v_insumo_necesario;

    UPDATE public.stock SET cantidad = v_insumo_nuevo, updated_at = now()
     WHERE producto_id = v_receta.insumo_id AND deposito_id = p_deposito_id;

    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
    VALUES
      (v_receta.insumo_id, p_deposito_id, 'egreso', v_insumo_necesario, 'produccion_consumo', p_producto_id, p_usuario_id,
       'Consumido para producir ' || p_cantidad || ' de otro producto' || COALESCE(': ' || p_notas, ''))
    RETURNING id INTO v_mov_id;

    -- Se llama UNA sola vez: el propio INSERT consume los lotes (efecto
    -- secundario de fn_lotes_consumir_fefo) y deja el detalle grabado.
    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    SELECT v_mov_id, f.lote_id, f.cantidad_consumida, 'consumo'
      FROM fn_lotes_consumir_fefo(v_receta.insumo_id, p_deposito_id, v_insumo_necesario, 'produccion_consumo', p_usuario_id) f;

    -- Costo real consumido en esta fila (se lee de lo recién insertado,
    -- sin volver a llamar la función FEFO).
    v_costo_total := v_costo_total + COALESCE((
      SELECT SUM(msl.cantidad * COALESCE(l.costo_unitario, 0))
        FROM movimientos_stock_lotes msl
        JOIN lotes l ON l.id = msl.lote_id
       WHERE msl.movimiento_stock_id = v_mov_id
    ), 0);

    v_consumidos := v_consumidos || jsonb_build_object(
      'insumo_id', v_receta.insumo_id,
      'cantidad_consumida', v_insumo_necesario,
      'stock_nuevo', v_insumo_nuevo
    );
  END LOOP;

  UPDATE public.stock SET cantidad = v_stock_nuevo, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;

  INSERT INTO public.lotes (
    empresa_id, producto_id, deposito_id,
    numero_lote, cantidad, cantidad_disponible,
    costo_unitario, estado
  ) VALUES (
    v_empresa_id, p_producto_id, p_deposito_id,
    'PROD-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
    p_cantidad, p_cantidad,
    CASE WHEN p_cantidad > 0 THEN ROUND(v_costo_total / p_cantidad, 2) ELSE NULL END,
    'activo'
  ) RETURNING id INTO v_lote_salida_id;

  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES
    (p_producto_id, p_deposito_id, 'ingreso', p_cantidad, p_motivo, p_usuario_id, p_notas)
  RETURNING id INTO v_mov_id;

  INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
  VALUES (v_mov_id, v_lote_salida_id, p_cantidad, 'alta');

  RETURN json_build_object(
    'ok',           true,
    'stock_nuevo',  v_stock_nuevo,
    'tiene_receta', v_tiene_receta,
    'insumos_consumidos', v_consumidos,
    'costo_unitario_calculado', CASE WHEN p_cantidad > 0 THEN ROUND(v_costo_total / p_cantidad, 2) ELSE NULL END
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.producir_con_insumos TO authenticated, service_role;

COMMENT ON FUNCTION public.producir_con_insumos IS
  'Produce un producto terminado consumiendo su receta de insumos por FEFO '
  'real, calcula el costo unitario real ponderado desde los lotes '
  'consumidos y deja el detalle completo en movimientos_stock_lotes (mig. 462).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '467_producir_con_insumos_detalle_lotes.sql', '467', 'claude-session',
  'Reconstrucción retroactiva: producir_con_insumos ya vigente en producción — consume insumos por FEFO y calcula costo real ponderado desde los lotes consumidos, deja detalle completo en movimientos_stock_lotes.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
