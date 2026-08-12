-- ═══════════════════════════════════════════════════════════════
-- 110 · RPC get_carrito_cliente
-- Devuelve los ítems del carrito con datos del producto.
-- Seguro: solo puede consultar su propio carrito (valida via JWT).
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_carrito_cliente(p_cliente_id uuid)
RETURNS TABLE (
  id           uuid,
  producto_id  uuid,
  cantidad     int,
  precio_snap  numeric,
  nombre       text,
  unidad       text,
  foto_url     text,
  stock_disponible int
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cliente_id uuid;
BEGIN
  -- Verificar que el auth.uid() tiene ese cliente_id
  SELECT u.cliente_id INTO v_cliente_id
  FROM usuarios u
  WHERE u.id = auth.uid() AND u.cliente_id = p_cliente_id;

  IF v_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Acceso denegado';
  END IF;

  RETURN QUERY
  SELECT
    ci.id,
    ci.producto_id,
    ci.cantidad,
    ci.precio_snap,
    p.nombre::text,
    p.unidad::text,
    p.foto_url::text,
    GREATEST(0, COALESCE(SUM(s.cantidad - s.cantidad_reservada), 0))::int AS stock_disponible
  FROM carrito_items ci
  JOIN productos p ON p.id = ci.producto_id
  LEFT JOIN stock s ON s.producto_id = ci.producto_id
  WHERE ci.cliente_id = p_cliente_id
  GROUP BY ci.id, ci.producto_id, ci.cantidad, ci.precio_snap, p.nombre, p.unidad, p.foto_url
  ORDER BY ci.creado_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_carrito_cliente(uuid) TO authenticated;
