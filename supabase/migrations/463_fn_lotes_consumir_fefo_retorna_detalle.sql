-- ═══════════════════════════════════════════════════════════════════════════
-- 463_fn_lotes_consumir_fefo_retorna_detalle.sql [reconstruida, ver 462]
--
-- fn_lotes_consumir_fefo() pasa de RETURNS void a RETURNS TABLE(lote_id,
-- cantidad_consumida): devuelve, fila por fila, cada lote consumido y
-- cuánto, para que los callers puedan insertar el detalle en
-- movimientos_stock_lotes. Incluye guarda de salida temprana cuando no hay
-- disponibilidad total en depósito (evita el loop innecesario).
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.fn_lotes_consumir_fefo(uuid, uuid, numeric, text, uuid);

CREATE OR REPLACE FUNCTION public.fn_lotes_consumir_fefo(
  p_producto_id uuid,
  p_deposito_id uuid,
  p_cantidad    numeric,
  p_referencia  text DEFAULT NULL,
  p_usuario_id  uuid DEFAULT NULL
)
RETURNS TABLE(lote_id uuid, cantidad_consumida numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lote        RECORD;
  v_restante    NUMERIC := p_cantidad;
  v_consumir    NUMERIC;
  v_total_disp  NUMERIC;
BEGIN
  SELECT COALESCE(SUM(cantidad_disponible), 0)
    INTO v_total_disp
    FROM lotes
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_id
     AND estado      = 'activo'
     AND cantidad_disponible > 0;

  IF v_total_disp = 0 THEN
    RETURN;
  END IF;

  FOR v_lote IN
    SELECT id, cantidad_disponible
      FROM lotes
     WHERE producto_id = p_producto_id
       AND deposito_id = p_deposito_id
       AND estado      = 'activo'
       AND cantidad_disponible > 0
     ORDER BY
       fecha_vencimiento ASC NULLS LAST,
       created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_restante <= 0;

    v_consumir := LEAST(v_lote.cantidad_disponible, v_restante);

    UPDATE lotes
       SET cantidad            = GREATEST(0, cantidad - v_consumir),
           cantidad_disponible = GREATEST(0, cantidad_disponible - v_consumir),
           updated_at          = now()
     WHERE id = v_lote.id;

    lote_id := v_lote.id;
    cantidad_consumida := v_consumir;
    RETURN NEXT;

    v_restante := v_restante - v_consumir;
  END LOOP;

  -- Si sobró algo por consumir (stock pre-migración sin lote), se ignora
  -- silenciosamente, igual que antes.
  RETURN;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_lotes_consumir_fefo(uuid, uuid, numeric, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_lotes_consumir_fefo IS
  'Consume stock de lotes activos por orden FEFO (vencimiento más próximo primero, '
  'luego el más antiguo). Devuelve una fila por cada lote tocado (lote_id, '
  'cantidad_consumida) para que el caller registre el detalle en '
  'movimientos_stock_lotes.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '463_fn_lotes_consumir_fefo_retorna_detalle.sql', '463', 'claude-session',
  'Reconstrucción retroactiva: fn_lotes_consumir_fefo pasa de RETURNS void a RETURNS TABLE(lote_id, cantidad_consumida) para poder trazar el detalle de consumo en movimientos_stock_lotes.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
