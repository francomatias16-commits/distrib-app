-- ═══════════════════════════════════════════════════════════════════════════
-- 466_confirmar_despacho_stock_detalle_lotes.sql [reconstruida, ver 462]
--
-- confirmar_despacho_stock(): descuenta stock (y cantidad_reservada si
-- había reserva previa), registra el egreso y consume lotes por FEFO vía
-- fn_lotes_consumir_fefo (463), dejando el detalle en
-- movimientos_stock_lotes. RETURNS void — no expone json de resultado,
-- a diferencia del resto de las funciones de stock.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.confirmar_despacho_stock(
  p_producto_id uuid,
  p_deposito_id uuid,
  p_cantidad    numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cantidad_actual    NUMERIC;
  v_cantidad_reservada NUMERIC;
  v_mov_id             UUID;
BEGIN
  SELECT cantidad, cantidad_reservada
    INTO v_cantidad_actual, v_cantidad_reservada
    FROM stock
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock no encontrado para producto % en depósito %',
      p_producto_id, p_deposito_id;
  END IF;

  IF v_cantidad_actual < p_cantidad THEN
    RAISE EXCEPTION 'Stock insuficiente para despachar. Actual: %, requerido: %',
      v_cantidad_actual, p_cantidad;
  END IF;

  UPDATE stock
     SET cantidad           = cantidad           - p_cantidad,
         cantidad_reservada = GREATEST(0, cantidad_reservada - p_cantidad)
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_id;

  INSERT INTO movimientos_stock (producto_id, deposito_id, tipo, cantidad, referencia)
  VALUES (p_producto_id, p_deposito_id, 'egreso', p_cantidad, 'despacho')
  RETURNING id INTO v_mov_id;

  INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
  SELECT v_mov_id, f.lote_id, f.cantidad_consumida, 'consumo'
    FROM fn_lotes_consumir_fefo(p_producto_id, p_deposito_id, p_cantidad, 'despacho', NULL) f;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.confirmar_despacho_stock TO service_role;

COMMENT ON FUNCTION public.confirmar_despacho_stock IS
  'Descuenta stock reservado al confirmar un despacho, consume lotes por FEFO '
  'y deja el detalle en movimientos_stock_lotes (mig. 462).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '466_confirmar_despacho_stock_detalle_lotes.sql', '466', 'claude-session',
  'Reconstrucción retroactiva: confirmar_despacho_stock ya vigente en producción, consume lotes por FEFO y deja detalle en movimientos_stock_lotes.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
