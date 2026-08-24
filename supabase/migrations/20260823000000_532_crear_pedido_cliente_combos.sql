-- ============================================================
-- 20260823000000_532_crear_pedido_cliente_combos.sql
-- crear_pedido_cliente() (523) insertaba cada renglón asumiendo
-- producto_id NOT NULL y reservaba stock producto-por-producto, en el
-- mismo paso que insertaba el renglón. Con combos (530) un renglón puede
-- traer combo_id en vez de producto_id (ítem único, precio propio) — hay
-- que insertarlo tal cual en pedido_items, pero la reserva de stock tiene
-- que hacerse por los PRODUCTOS componentes (combo_items), no por el
-- combo en sí, y agregada junto con cualquier renglón directo del mismo
-- producto (mismo criterio que confirmar_pedido, 533, para no reservar
-- dos veces si un producto aparece directo y dentro de un combo en el
-- mismo pedido).
--
-- Firma sin cambios respecto a 523 (misma señal que 533 respecto a
-- 20260818_p1...): el payload p_items ahora puede traer combo_id en vez
-- de producto_id por renglón — mismo shape que arma itemsParaRpc en
-- lib/calc/pedido-totales.js (v(combos)).
-- ============================================================

CREATE OR REPLACE FUNCTION public.crear_pedido_cliente(
  p_empresa_id       UUID,
  p_cliente_id       UUID,
  p_vendedor_id      UUID,
  p_items            JSONB,
  p_subtotal         NUMERIC,
  p_iva_total        NUMERIC,
  p_total            NUMERIC,
  p_notas_cliente    TEXT    DEFAULT NULL,
  p_fecha_entrega    DATE    DEFAULT NULL,
  p_canal            TEXT    DEFAULT 'portal_cliente',
  p_idempotency_key  TEXT    DEFAULT NULL,
  p_forma_pago       TEXT    DEFAULT 'cuenta_corriente'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_pedido_id      UUID;
  v_item           JSONB;
  v_deposito       UUID;
  v_disponible     NUMERIC;
  v_forma_pago     TEXT := CASE WHEN p_forma_pago = 'pago_inmediato' THEN 'pago_inmediato' ELSE 'cuenta_corriente' END;
  v_necesidad      RECORD;
BEGIN
  -- ── 0. Idempotencia: igual que 523 ──────────────────────────────────────
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_pedido_id
      FROM pedidos
     WHERE empresa_id = p_empresa_id
       AND cliente_id = p_cliente_id
       AND idempotency_key = p_idempotency_key
     LIMIT 1;

    IF v_pedido_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok',         TRUE,
        'pedido_id',  v_pedido_id,
        'ya_existia', TRUE
      );
    END IF;
  END IF;

  -- ── 1. Insertar pedido ────────────────────────────────────────────────
  INSERT INTO pedidos (
    empresa_id, cliente_id, vendedor_id,
    estado, subtotal, iva_total, total,
    notas_cliente, fecha_entrega, canal,
    idempotency_key, forma_pago
  )
  VALUES (
    p_empresa_id, p_cliente_id, p_vendedor_id,
    'confirmado', p_subtotal, p_iva_total, p_total,
    p_notas_cliente, p_fecha_entrega, p_canal,
    p_idempotency_key, v_forma_pago
  )
  RETURNING id INTO v_pedido_id;

  -- ── 2. Insertar ítems (producto directo O combo, ítem único) ───────────
  -- v532: acá solo se persiste el renglón tal cual viene (ya validado y con
  -- precio/IVA resueltos server-side por confirmarPedidoHandler antes de
  -- llamar esta RPC) — la reserva de stock se hace aparte, en el paso 3,
  -- agregada por producto real.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO pedido_items (
      pedido_id, producto_id, combo_id, cantidad, precio_unitario, descuento_pct, subtotal
    )
    VALUES (
      v_pedido_id,
      (v_item->>'producto_id')::UUID,
      (v_item->>'combo_id')::UUID,
      (v_item->>'cantidad')::NUMERIC,
      (v_item->>'precio_unitario')::NUMERIC,
      COALESCE((v_item->>'descuento_pct')::NUMERIC, 0),
      (v_item->>'subtotal')::NUMERIC
    );
  END LOOP;

  -- ── 3. Reservar stock: necesidad TOTAL por producto (renglones directos
  -- + componentes de cada renglón de combo, combo_items × cantidad del
  -- renglón) — mismo criterio de agregación que confirmar_pedido (533),
  -- para no reservar dos veces un producto que aparece directo y dentro de
  -- un combo en el mismo pedido.
  FOR v_necesidad IN
    SELECT producto_id, SUM(cantidad_necesaria) AS cantidad_necesaria
    FROM (
      SELECT pi.producto_id AS producto_id, pi.cantidad AS cantidad_necesaria
        FROM pedido_items pi
       WHERE pi.pedido_id = v_pedido_id
         AND pi.producto_id IS NOT NULL
      UNION ALL
      SELECT ci.producto_id AS producto_id, ci.cantidad * pi.cantidad AS cantidad_necesaria
        FROM pedido_items pi
        JOIN combo_items ci ON ci.combo_id = pi.combo_id
       WHERE pi.pedido_id = v_pedido_id
         AND pi.combo_id IS NOT NULL
    ) necesidades
    GROUP BY producto_id
  LOOP
    -- Depósito principal + verificación de stock con lock (FOR UPDATE) —
    -- mismo criterio que 523.
    SELECT s.deposito_id,
           (s.cantidad - COALESCE(s.cantidad_reservada, 0)) AS disponible
      INTO v_deposito, v_disponible
      FROM stock s
      JOIN depositos d ON d.id = s.deposito_id
     WHERE s.producto_id = v_necesidad.producto_id
       AND d.empresa_id  = p_empresa_id
       AND d.es_principal = TRUE
     LIMIT 1
     FOR UPDATE;

    IF v_deposito IS NULL OR v_disponible < v_necesidad.cantidad_necesaria THEN
      RETURN jsonb_build_object(
        'ok',    FALSE,
        'tipo',  'stock_insuficiente',
        'error', 'Stock insuficiente para producto ' || v_necesidad.producto_id
      );
    END IF;

    UPDATE stock
       SET cantidad_reservada = COALESCE(cantidad_reservada, 0) + v_necesidad.cantidad_necesaria
     WHERE producto_id = v_necesidad.producto_id
       AND deposito_id = v_deposito;

    INSERT INTO movimientos_stock (
      producto_id, deposito_id, tipo, cantidad, referencia_id, referencia
    )
    VALUES (
      v_necesidad.producto_id,
      v_deposito,
      'reserva',
      v_necesidad.cantidad_necesaria,
      v_pedido_id,
      'Pedido #' || LEFT(v_pedido_id::TEXT, 8)
    );
  END LOOP;

  -- ── 4. Éxito ─────────────────────────────────────────────────────────
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

COMMENT ON FUNCTION public.crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text,text,text) IS
  'v532: soporta renglones de combo (pedido_items.combo_id, migración 530) — el ítem se inserta tal cual (único, precio propio) y la reserva de stock se calcula aparte, agregando renglones directos + componentes de combo por producto real, antes de reservar (mismo criterio que confirmar_pedido v533). Base: 523_forma_pago_pedido_cliente.';

REVOKE ALL ON FUNCTION public.crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text,text,text) TO service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260823000000_532_crear_pedido_cliente_combos.sql',
  '532',
  'claude_assistant',
  'Reconstrucción: crear_pedido_cliente (base: 523) inserta renglones de combo tal cual y reserva stock agregando renglones directos + componentes de combo por producto real.'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
