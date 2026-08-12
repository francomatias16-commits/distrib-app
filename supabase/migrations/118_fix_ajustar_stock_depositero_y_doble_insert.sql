-- 118: fix ajustar_stock()
-- 1) Autorizar también a 'depositero' (ya tiene acceso a /admin/stock y a la RLS stock_modify)
-- 2) Eliminar el INSERT interno en movimientos_stock: stock.js v41 ya inserta el movimiento
--    con motivo/notas/tipo reales desde el cliente. Mantener el insert acá generaba filas
--    duplicadas (hasta 3 por una sola transferencia).
CREATE OR REPLACE FUNCTION public.ajustar_stock(
  p_producto_id uuid,
  p_deposito_id uuid,
  p_delta numeric,
  p_motivo text DEFAULT 'ajuste_manual'::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_empresa_id  UUID;
  v_stock_nuevo NUMERIC;
BEGIN
  -- Obtener empresa_id del depósito
  SELECT empresa_id INTO v_empresa_id
  FROM public.depositos
  WHERE id = p_deposito_id;

  IF v_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'Depósito no encontrado');
  END IF;

  -- Verificar autorización (admin, dueño o depositero de la empresa)
  IF NOT (
    get_rol_usuario() IN ('admin', 'dueno', 'depositero') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  -- Upsert en stock (cantidad_disponible se sincroniza vía trigger trg_sync_stock_disponible)
  INSERT INTO public.stock (producto_id, deposito_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, GREATEST(0, p_delta))
  ON CONFLICT (producto_id, deposito_id)
  DO UPDATE SET
    cantidad   = GREATEST(0, public.stock.cantidad + p_delta),
    updated_at = NOW()
  RETURNING cantidad INTO v_stock_nuevo;

  -- NOTA: el registro en movimientos_stock lo hace el cliente (stock.js) con
  -- motivo/notas/tipo reales. No duplicar el insert acá.

  RETURN json_build_object(
    'ok',         true,
    'stock_nuevo', COALESCE(v_stock_nuevo, 0),
    'delta',       p_delta
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
