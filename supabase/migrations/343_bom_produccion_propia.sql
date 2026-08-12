-- =============================================================================
-- 343_bom_produccion_propia.sql
--
-- Roadmap v341, "Producción propia": sin esto, el motivo "Producción propia"
-- del modal de ajuste solo suma stock del producto terminado sin reflejar el
-- consumo real de materia prima — subestima el costo y sobreestima el stock
-- de insumos.
--
-- Esta migración agrega:
--   1) producto_insumos: la receta/BOM (producto terminado -> insumos y
--      cantidad de cada uno por unidad terminada).
--   2) producir_con_insumos(): produce N unidades del producto terminado y,
--      en la MISMA transacción, descuenta de cada insumo la cantidad que
--      indica la receta (cantidad_por_unidad * N) del mismo depósito.
--      Si algún insumo no alcanza, se rechaza todo (ok:false) sin tocar nada
--      — no queda un ingreso de terminado sin su consumo correspondiente.
-- =============================================================================

-- ── 1) Receta (BOM) ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.producto_insumos (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  producto_terminado_id  uuid NOT NULL REFERENCES public.productos(id) ON DELETE CASCADE,
  insumo_id              uuid NOT NULL REFERENCES public.productos(id) ON DELETE RESTRICT,
  cantidad_por_unidad    numeric NOT NULL CHECK (cantidad_por_unidad > 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT producto_insumos_no_auto_referencia CHECK (producto_terminado_id <> insumo_id),
  CONSTRAINT producto_insumos_unico UNIQUE (producto_terminado_id, insumo_id)
);

CREATE INDEX IF NOT EXISTS idx_producto_insumos_terminado ON public.producto_insumos(producto_terminado_id);
CREATE INDEX IF NOT EXISTS idx_producto_insumos_empresa    ON public.producto_insumos(empresa_id);

ALTER TABLE public.producto_insumos ENABLE ROW LEVEL SECURITY;

CREATE POLICY producto_insumos_empresa ON public.producto_insumos
  FOR ALL
  USING (empresa_id = get_empresa_id())
  WITH CHECK (empresa_id = get_empresa_id());

CREATE OR REPLACE FUNCTION public.fn_producto_insumos_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $trig$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$trig$;

CREATE TRIGGER trg_producto_insumos_updated_at
  BEFORE UPDATE ON public.producto_insumos
  FOR EACH ROW EXECUTE FUNCTION public.fn_producto_insumos_touch_updated_at();

COMMENT ON TABLE public.producto_insumos IS
  'Receta/BOM de producción propia: por cada producto terminado, qué insumos '
  '(y en qué cantidad por unidad terminada) se descuentan al producir. '
  'Usada por producir_con_insumos().';

-- ── 2) Producción con descuento automático de insumos ───────────────────────
CREATE OR REPLACE FUNCTION public.producir_con_insumos(
  p_producto_id  uuid,
  p_deposito_id  uuid,
  p_cantidad     numeric,
  p_motivo       text DEFAULT 'produccion',
  p_notas        text DEFAULT NULL,
  p_usuario_id   uuid DEFAULT NULL
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

  -- Lockear primero los insumos en orden estable (por id) para evitar
  -- deadlocks entre producciones concurrentes que compartan insumos, y
  -- validar que alcance el stock de cada uno ANTES de tocar nada.
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

  -- Asegurar y lockear la fila del producto terminado.
  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, 0)
  ON CONFLICT (producto_id, deposito_id) DO NOTHING;

  SELECT cantidad INTO v_stock_actual
    FROM public.stock
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id
   FOR UPDATE;

  v_stock_nuevo := COALESCE(v_stock_actual, 0) + p_cantidad;

  -- Segunda pasada: aplicar el descuento real de cada insumo (ya validado
  -- arriba que alcanza) y registrar el consumo.
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

    PERFORM fn_lotes_consumir_fefo(v_receta.insumo_id, p_deposito_id, v_insumo_necesario, 'produccion_consumo', p_usuario_id);

    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
    VALUES
      (v_receta.insumo_id, p_deposito_id, 'egreso', v_insumo_necesario, 'produccion_consumo', p_producto_id, p_usuario_id,
       'Consumido para producir ' || p_cantidad || ' de otro producto' || COALESCE(': ' || p_notas, ''));

    v_consumidos := v_consumidos || jsonb_build_object(
      'insumo_id', v_receta.insumo_id,
      'cantidad_consumida', v_insumo_necesario,
      'stock_nuevo', v_insumo_nuevo
    );
  END LOOP;

  -- Ingreso del producto terminado.
  UPDATE public.stock SET cantidad = v_stock_nuevo, updated_at = now()
   WHERE producto_id = p_producto_id AND deposito_id = p_deposito_id;

  INSERT INTO public.lotes (
    empresa_id, producto_id, deposito_id,
    numero_lote, cantidad, cantidad_disponible,
    estado
  ) VALUES (
    v_empresa_id, p_producto_id, p_deposito_id,
    'PROD-' || TO_CHAR(now(), 'YYYYMMDD-HH24MI'),
    p_cantidad, p_cantidad,
    'activo'
  );

  INSERT INTO public.movimientos_stock
    (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES
    (p_producto_id, p_deposito_id, 'ingreso', p_cantidad, p_motivo, p_usuario_id, p_notas);

  RETURN json_build_object(
    'ok',           true,
    'stock_nuevo',  v_stock_nuevo,
    'tiene_receta', v_tiene_receta,
    'insumos_consumidos', v_consumidos
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.producir_con_insumos(uuid, uuid, numeric, text, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.producir_con_insumos IS
  'Produce N unidades de un producto terminado y descuenta automáticamente, '
  'en la misma transacción, los insumos definidos en producto_insumos (BOM) '
  'para esa cantidad. Si no hay receta cargada para el producto, produce '
  'igual (tiene_receta:false) sin descontar nada, para no bloquear a las '
  'empresas que todavía no cargaron el BOM. Rechaza todo (ok:false) si algún '
  'insumo no alcanza.';

NOTIFY pgrst, 'reload schema';
