-- SECNEW-01 (2026-08-24) — encontrado y corregido directo en producción vía
-- MCP de Supabase. Este archivo reconstruye esa migración para que el repo
-- quede sincronizado (mismo criterio que sesión 9 usó para SEC-005..014).
-- Ver AUDITORIA_2026/00_PLAN_MAESTRO.md, fila SECNEW-01.
--
-- Problema: crear_pedido_cliente insertaba pedidos con el empresa_id/
-- cliente_id que le pasara el caller, sin validar nada contra la sesión —
-- expuesta a anon/authenticated por PostgREST. Mismo patrón que SEC-006/
-- SEC-010.
--
-- Fix: si el caller no es service_role (el backend y el bot de WhatsApp
-- son los únicos legítimos y usan service_role, sin cambio de
-- comportamiento), se valida que empresa_id coincida con la sesión y que
-- cliente_id pertenezca a esa empresa.

CREATE OR REPLACE FUNCTION public.crear_pedido_cliente(p_empresa_id uuid, p_cliente_id uuid, p_vendedor_id uuid, p_items jsonb, p_subtotal numeric, p_iva_total numeric, p_total numeric, p_notas_cliente text DEFAULT NULL::text, p_fecha_entrega date DEFAULT NULL::date, p_canal text DEFAULT 'portal_cliente'::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_forma_pago text DEFAULT 'cuenta_corriente'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pedido_id      UUID;
  v_item           JSONB;
  v_deposito       UUID;
  v_disponible     NUMERIC;
  v_forma_pago     TEXT := CASE WHEN p_forma_pago = 'pago_inmediato' THEN 'pago_inmediato' ELSE 'cuenta_corriente' END;
  v_necesidad      RECORD;
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
      RETURN json_build_object('ok', false, 'codigo', 'NO_AUTORIZADO', 'error', 'No autorizado');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.clientes
      WHERE id = p_cliente_id AND empresa_id = p_empresa_id
    ) THEN
      RETURN json_build_object('ok', false, 'codigo', 'CLIENTE_NO_PERTENECE', 'error', 'El cliente no pertenece a la empresa');
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_pedido_id
      FROM pedidos
     WHERE empresa_id = p_empresa_id
       AND cliente_id = p_cliente_id
       AND idempotency_key = p_idempotency_key
     LIMIT 1;

    IF v_pedido_id IS NOT NULL THEN
      RETURN json_build_object(
        'ok',         TRUE,
        'pedido_id',  v_pedido_id,
        'ya_existia', TRUE
      );
    END IF;
  END IF;

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
      RETURN json_build_object(
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

  RETURN json_build_object(
    'ok',        TRUE,
    'pedido_id', v_pedido_id
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object(
      'ok',    FALSE,
      'error', SQLERRM
    );
END;
$function$;
