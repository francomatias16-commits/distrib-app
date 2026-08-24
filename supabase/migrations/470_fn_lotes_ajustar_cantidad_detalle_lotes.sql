-- ═══════════════════════════════════════════════════════════════════════════
-- 470_fn_lotes_ajustar_cantidad_detalle_lotes.sql [reconstruida, ver 462]
--
-- [Reconstrucción retroactiva — función ya vigente en producción, leída
--  directamente desde pg_proc. No-op funcional sobre la base actual.]
--
-- fn_lotes_ajustar_cantidad(): edición manual de la cantidad de un lote
-- (pantalla "Editar lote"). Calcula el delta contra la cantidad anterior,
-- actualiza cantidad/cantidad_disponible del lote y, si el lote tiene
-- depósito asignado, sincroniza `stock`, registra el movimiento
-- (ingreso/egreso según el signo del delta) y deja el detalle en
-- movimientos_stock_lotes. Si el lote es legado y no tiene depósito, ajusta
-- el lote igual pero lo deja constando en la respuesta (stock_sincronizado=false).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_lotes_ajustar_cantidad(
  p_lote_id         uuid,
  p_cantidad_nueva  numeric,
  p_motivo          text,
  p_usuario_id      uuid DEFAULT NULL::uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lote          RECORD;
  v_empresa_id    UUID;
  v_delta         NUMERIC;
  v_disp_nueva    NUMERIC;
  v_stock_actual  NUMERIC;
  v_stock_nuevo   NUMERIC;
  v_mov_id        UUID;
  v_tipo          tipo_movimiento;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_cantidad_nueva IS NULL OR p_cantidad_nueva < 0 THEN
    RETURN json_build_object('ok', false, 'error', 'La cantidad no puede ser negativa');
  END IF;

  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RETURN json_build_object('ok', false, 'error', 'El motivo es obligatorio para ajustar la cantidad de un lote');
  END IF;

  SELECT id, empresa_id, producto_id, deposito_id, cantidad, cantidad_disponible, numero_lote
    INTO v_lote
    FROM public.lotes
   WHERE id = p_lote_id
   FOR UPDATE;

  IF v_lote.id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Lote no encontrado');
  END IF;

  v_empresa_id := v_lote.empresa_id;

  IF auth.role() <> 'service_role' AND NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  v_delta := p_cantidad_nueva - v_lote.cantidad;

  IF v_delta = 0 THEN
    RETURN json_build_object('ok', true, 'sin_cambios', true, 'cantidad', v_lote.cantidad);
  END IF;

  v_disp_nueva := GREATEST(0, COALESCE(v_lote.cantidad_disponible, 0) + v_delta);

  UPDATE public.lotes
     SET cantidad            = p_cantidad_nueva,
         cantidad_disponible = v_disp_nueva,
         updated_at          = now()
   WHERE id = p_lote_id;

  -- Si el lote no tiene depósito asignado (dato legado), se ajusta el lote
  -- igual pero no hay tabla `stock` agregada de la que descontar/sumar de
  -- forma inequívoca — se deja constancia en la respuesta.
  IF v_lote.deposito_id IS NOT NULL THEN
    INSERT INTO public.stock (producto_id, deposito_id, cantidad)
    VALUES (v_lote.producto_id, v_lote.deposito_id, 0)
    ON CONFLICT (producto_id, deposito_id) DO NOTHING;

    SELECT cantidad INTO v_stock_actual
      FROM public.stock
     WHERE producto_id = v_lote.producto_id AND deposito_id = v_lote.deposito_id
     FOR UPDATE;

    v_stock_nuevo := GREATEST(0, COALESCE(v_stock_actual, 0) + v_delta);

    UPDATE public.stock
       SET cantidad = v_stock_nuevo, updated_at = now()
     WHERE producto_id = v_lote.producto_id AND deposito_id = v_lote.deposito_id;

    v_tipo := CASE WHEN v_delta > 0 THEN 'ingreso' ELSE 'egreso' END::tipo_movimiento;

    INSERT INTO public.movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia, referencia_id, usuario_id, notas)
    VALUES
      (v_lote.producto_id, v_lote.deposito_id, v_tipo, ABS(v_delta), 'ajuste_lote', v_lote.id,
       p_usuario_id, 'Ajuste manual de lote ' || COALESCE(v_lote.numero_lote, v_lote.id::text) || ': ' || p_motivo)
    RETURNING id INTO v_mov_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_id, v_lote.id, ABS(v_delta), CASE WHEN v_delta > 0 THEN 'alta' ELSE 'consumo' END);
  END IF;

  RETURN json_build_object(
    'ok', true,
    'cantidad_anterior', v_lote.cantidad,
    'cantidad_nueva', p_cantidad_nueva,
    'delta', v_delta,
    'stock_sincronizado', (v_lote.deposito_id IS NOT NULL)
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_lotes_ajustar_cantidad TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_lotes_ajustar_cantidad IS
  'Ajusta manualmente la cantidad de un lote existente, sincroniza stock por '
  'el delta y deja el detalle en movimientos_stock_lotes (mig. 462).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '470_fn_lotes_ajustar_cantidad_detalle_lotes.sql', '470', 'claude-session',
  'Reconstrucción retroactiva: fn_lotes_ajustar_cantidad ya vigente en producción, sincroniza stock por el delta y deja el detalle en movimientos_stock_lotes.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
