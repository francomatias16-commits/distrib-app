-- =============================================================================
-- 058_ajustar_stock.sql
-- RPC faltante: ajuste manual de stock (transferencias entre depósitos y ajustes)
-- Usado en: frontend/admin/js/stock.js (3 llamadas en modal de movimiento)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ajustar_stock(
  p_producto_id UUID,
  p_deposito_id UUID,
  p_delta       NUMERIC,
  p_motivo      TEXT DEFAULT 'ajuste_manual'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Verificar autorización (debe ser admin o dueño de la empresa)
  IF NOT (
    get_rol_usuario() IN ('admin', 'dueno') AND get_empresa_id() = v_empresa_id
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'Sin autorización');
  END IF;

  -- Upsert en stock
  INSERT INTO public.stock (producto_id, deposito_id, empresa_id, cantidad)
  VALUES (p_producto_id, p_deposito_id, v_empresa_id, GREATEST(0, p_delta))
  ON CONFLICT (producto_id, deposito_id)
  DO UPDATE SET
    cantidad   = GREATEST(0, public.stock.cantidad + p_delta),
    updated_at = NOW()
  RETURNING cantidad INTO v_stock_nuevo;

  -- Registrar en movimientos_stock
  INSERT INTO public.movimientos_stock
    (empresa_id, producto_id, deposito_id, tipo, cantidad, motivo, usuario_id, created_at)
  VALUES (
    v_empresa_id,
    p_producto_id,
    p_deposito_id,
    CASE WHEN p_delta >= 0 THEN 'entrada' ELSE 'salida' END,
    ABS(p_delta),
    p_motivo,
    auth.uid(),
    NOW()
  );

  RETURN json_build_object(
    'ok',         true,
    'stock_nuevo', COALESCE(v_stock_nuevo, 0),
    'delta',       p_delta
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ajustar_stock(UUID, UUID, NUMERIC, TEXT) TO authenticated;

COMMENT ON FUNCTION public.ajustar_stock IS
  'Ajuste manual de stock en un depósito. Delta positivo = entrada, negativo = salida. Registra en movimientos_stock.';
