-- 115_fix_canal_portal_real_crear_pedido_cliente.sql
-- BUG-4: el handler confirmarPedidoHandler en lib/handlers/pedidos.js llama a
-- crear_pedido_cliente con los parámetros nombrados:
--   p_empresa_id, p_cliente_id, p_vendedor_id, p_items,
--   p_subtotal, p_iva_total, p_total, p_notas_cliente, p_fecha_entrega
-- Ese overload (014_rpc_crear_pedido) no tenía p_canal, por lo que los pedidos
-- del portal cliente quedaban con canal = default de columna ('web') en vez de
-- 'portal_cliente'.
--
-- La migración 113 de la sesión anterior creó un overload DISTINTO con firma
-- (p_cliente_id, p_items, p_notas, p_canal) — que el handler real NUNCA llama.
-- Este fix corrige el overload correcto: el de 9 parámetros (uuid,uuid,uuid,jsonb,
-- numeric,numeric,numeric,text,date), ahora con p_canal text DEFAULT 'portal_cliente'.

CREATE OR REPLACE FUNCTION crear_pedido_cliente(
  p_empresa_id    UUID,
  p_cliente_id    UUID,
  p_vendedor_id   UUID,
  p_items         JSONB,
  p_subtotal      NUMERIC,
  p_iva_total     NUMERIC,
  p_total         NUMERIC,
  p_notas_cliente TEXT    DEFAULT NULL,
  p_fecha_entrega DATE    DEFAULT NULL,
  p_canal         TEXT    DEFAULT 'portal_cliente'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_pedido_id  UUID;
  v_item       JSONB;
  v_deposito   UUID;
  v_disponible NUMERIC;
BEGIN
  -- ── 1. Insertar pedido ────────────────────────────────────────────────────
  INSERT INTO pedidos (
    empresa_id, cliente_id, vendedor_id,
    estado, subtotal, iva_total, total,
    notas_cliente, fecha_entrega, canal
  )
  VALUES (
    p_empresa_id, p_cliente_id, p_vendedor_id,
    'confirmado', p_subtotal, p_iva_total, p_total,
    p_notas_cliente, p_fecha_entrega, p_canal
  )
  RETURNING id INTO v_pedido_id;

  -- ── 2. Insertar ítems y reservar stock por ítem ───────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- 2a. Insertar ítem
    INSERT INTO pedido_items (
      pedido_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal
    )
    VALUES (
      v_pedido_id,
      (v_item->>'producto_id')::UUID,
      (v_item->>'cantidad')::NUMERIC,
      (v_item->>'precio_unitario')::NUMERIC,
      COALESCE((v_item->>'descuento_pct')::NUMERIC, 0),
      (v_item->>'subtotal')::NUMERIC
    );

    -- 2b. Obtener depósito principal y verificar stock con lock (FOR UPDATE)
    SELECT s.deposito_id,
           (s.cantidad - COALESCE(s.cantidad_reservada, 0)) AS disponible
      INTO v_deposito, v_disponible
      FROM stock s
      JOIN depositos d ON d.id = s.deposito_id
     WHERE s.producto_id = (v_item->>'producto_id')::UUID
       AND d.empresa_id  = p_empresa_id
       AND d.es_principal = TRUE
     LIMIT 1
     FOR UPDATE;

    -- Si no hay depósito o stock insuficiente, abortar con mensaje descriptivo
    IF v_deposito IS NULL OR v_disponible < (v_item->>'cantidad')::NUMERIC THEN
      RETURN jsonb_build_object(
        'ok',    FALSE,
        'tipo',  'stock_insuficiente',
        'error', 'Stock insuficiente para producto ' || (v_item->>'producto_id')
      );
    END IF;

    -- 2c. Reservar stock
    UPDATE stock
       SET cantidad_reservada = COALESCE(cantidad_reservada, 0) + (v_item->>'cantidad')::NUMERIC
     WHERE producto_id = (v_item->>'producto_id')::UUID
       AND deposito_id = v_deposito;

    -- 2d. Registrar movimiento de stock
    INSERT INTO movimientos_stock (
      producto_id, deposito_id, tipo, cantidad, referencia_id, referencia
    )
    VALUES (
      (v_item->>'producto_id')::UUID,
      v_deposito,
      'reserva',
      (v_item->>'cantidad')::NUMERIC,
      v_pedido_id,
      'Pedido #' || LEFT(v_pedido_id::TEXT, 8)
    );
  END LOOP;

  -- ── 3. Éxito ──────────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',        TRUE,
    'pedido_id', v_pedido_id
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok',    FALSE,
      'error', SQLERRM
    );
END;
$$;

-- Permisos (igual que antes)
REVOKE ALL ON FUNCTION crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text) TO service_role;

-- Registrar en registry
INSERT INTO schema_migrations_registry (numero, nombre, carpeta, aplicada_en)
VALUES (115, '115_fix_canal_portal_real_crear_pedido_cliente', 'supabase/migrations', NOW())
ON CONFLICT (numero) DO NOTHING;
