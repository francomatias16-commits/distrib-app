-- 523_forma_pago_pedido_cliente.sql
--
-- Contexto: el checkout del portal cliente (carrito.html) no tenía forma de
-- elegir cómo se paga un pedido — TODO pedido quedaba a cuenta corriente,
-- así que el chequeo de límite de crédito (confirmarPedidoHandler, paso 5)
-- bloqueaba sin salida a cualquier cliente sobregirado, aunque quisiera
-- pagar ese pedido puntual por otro medio (transferencia/efectivo a
-- coordinar con el vendedor).
--
-- Este fix agrega una columna `forma_pago` a `pedidos` y un parámetro
-- p_forma_pago a crear_pedido_cliente(). El chequeo de límite de crédito en
-- Node (confirmarPedidoHandler) ya se saltea cuando forma_pago =
-- 'pago_inmediato'; acá solo falta persistir el dato para que
-- emitirFactura() (lib/facturas.js) sepa que ESE pedido no debe generar
-- deuda en cta_cte al facturarse — mismo criterio que ya existía para
-- ventas POS con pago mixto (__monto_cta_cte_pos, ver migraciones POS).
--
-- NOTA IMPORTANTE (drift detectado): los 3 call-sites reales de
-- crear_pedido_cliente (confirmarPedidoHandler x2 en pedidos.js, y
-- notif.js para el bot de WhatsApp) ya mandan p_idempotency_key, pero
-- ninguna migración versionada en este repo agrega ese parámetro — el
-- 115_fix_canal_portal_real_crear_pedido_cliente.sql vigente solo llega
-- hasta p_canal (10 params). Esta migración reconstruye la firma completa
-- que el código Node asume hoy (idempotencia incluida) y le suma
-- p_forma_pago. Si la función real en producción difiere de lo asumido acá
-- (por ejemplo, otro nombre de columna o lógica de dedupe distinta),
-- conviene diffear contra el esquema real antes de aplicar esta migración.

-- ── 1. Columna forma_pago en pedidos ─────────────────────────────────────
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS forma_pago TEXT NOT NULL DEFAULT 'cuenta_corriente';

ALTER TABLE public.pedidos
  DROP CONSTRAINT IF EXISTS pedidos_forma_pago_check;

ALTER TABLE public.pedidos
  ADD CONSTRAINT pedidos_forma_pago_check
  CHECK (forma_pago IN ('cuenta_corriente', 'pago_inmediato'));

-- Columna de idempotencia (asumida por el código Node — ver nota arriba).
-- Si ya existe (porque se aplicó fuera de este repo) esto es un no-op.
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS pedidos_idempotency_key_unique
  ON public.pedidos (empresa_id, cliente_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── 2. Limpiar overloads viejos para no dejar ambigüedad de firma ───────
DROP FUNCTION IF EXISTS public.crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text);
DROP FUNCTION IF EXISTS public.crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text,text);

-- ── 3. crear_pedido_cliente con idempotencia + forma_pago ───────────────
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
BEGIN
  -- ── 0. Idempotencia: si ya existe un pedido con esta key para este
  -- cliente/empresa, devolverlo tal cual en vez de crear uno nuevo
  -- (reintento del cliente tras un timeout de red — ver Hallazgo 3 en
  -- carrito.html).
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

  -- ── 1. Insertar pedido ────────────────────────────────────────────────────
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

REVOKE ALL ON FUNCTION public.crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crear_pedido_cliente(uuid,uuid,uuid,jsonb,numeric,numeric,numeric,text,date,text,text,text) TO service_role;
