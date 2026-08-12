-- ============================================================
-- DISTRIB-APP — Fase 1: Fixes de integración
-- 013_fase1_fixes.sql
-- Ejecutar DESPUÉS de 012_fase1_roles_rls.sql
--
-- Por qué existe este archivo:
--  • frontend/admin/js/pedidos.js (ya escrito) llama a las RPCs
--    confirmar_pedido / cancelar_pedido / marcar_preparado pasando
--    p_usuario_id (y cancelar_pedido también p_motivo). Las firmas
--    creadas en 011_fase1_transacciones.sql NO tenían esos parámetros,
--    así que PostgREST devolvía "function not found" (PGRST202) y el
--    flujo de confirmar/cancelar pedidos quedaba roto end-to-end.
--  • El cálculo de saldo de cta_cte en confirmar_pedido() usaba
--    tipo IN ('factura','nota_debito'), pero en TODO el resto del
--    sistema (api/pedidos/confirmar-pedido.js, api/notif/deuda-vencida.js)
--    el tipo que representa una deuda (DEBE) es 'debito' /
--    'nota_debito', y los que representan pagos/créditos (HABER)
--    son 'credito' / 'nota_credito' / 'cobro'. Se corrige para usar
--    la misma taxonomía en toda la app.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1) confirmar_pedido: agregar p_usuario_id (opcional) y corregir
--    el cálculo de saldo de cuenta corriente.
-- ────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS confirmar_pedido(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS confirmar_pedido(UUID);

CREATE OR REPLACE FUNCTION confirmar_pedido(
  p_pedido_id  UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_forzar     BOOLEAN DEFAULT FALSE
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido       RECORD;
  v_cliente      RECORD;
  v_item         RECORD;
  v_stock        RECORD;
  v_saldo_cte    NUMERIC;
  v_usuario_id   UUID;
BEGIN
  v_usuario_id := COALESCE(p_usuario_id, auth.uid());

  -- 1. Cargar y bloquear el pedido
  SELECT p.* INTO v_pedido
    FROM pedidos p
   WHERE p.id = p_pedido_id
     AND p.empresa_id = get_empresa_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_pedido.estado <> 'borrador' THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'El pedido no está en borrador (estado actual: ' || v_pedido.estado || ')'
    );
  END IF;

  -- 2. Cargar datos del cliente
  SELECT * INTO v_cliente FROM clientes WHERE id = v_pedido.cliente_id;

  -- 3. Validar límite de crédito (salteable con p_forzar)
  --    DEBE  (aumenta deuda): 'debito', 'nota_debito'
  --    HABER (disminuye deuda): 'credito', 'nota_credito', 'cobro'
  IF NOT p_forzar AND v_cliente.limite_credito > 0 THEN
    SELECT COALESCE(SUM(
      CASE WHEN tipo IN ('debito', 'nota_debito') THEN importe ELSE -importe END
    ), 0)
      INTO v_saldo_cte
      FROM cta_cte
     WHERE cliente_id = v_cliente.id;

    IF (v_saldo_cte + v_pedido.total) > v_cliente.limite_credito THEN
      RETURN json_build_object(
        'ok', false,
        'error', 'Límite de crédito superado. Saldo actual: $' || v_saldo_cte || ' / Límite: $' || v_cliente.limite_credito,
        'tipo', 'limite_credito'
      );
    END IF;
  END IF;

  -- 4. Validar y reservar stock ítem por ítem
  FOR v_item IN
    SELECT pi.producto_id, pi.cantidad
      FROM pedido_items pi
     WHERE pi.pedido_id = p_pedido_id
  LOOP
    SELECT s.deposito_id,
           (s.cantidad - s.cantidad_reservada) AS disponible
      INTO v_stock
      FROM stock s
      JOIN depositos d ON d.id = s.deposito_id
     WHERE s.producto_id = v_item.producto_id
       AND d.empresa_id  = v_pedido.empresa_id
       AND d.es_principal = TRUE
     LIMIT 1;

    IF NOT FOUND THEN
      SELECT s.deposito_id,
             (s.cantidad - s.cantidad_reservada) AS disponible
        INTO v_stock
        FROM stock s
        JOIN depositos d ON d.id = s.deposito_id
       WHERE s.producto_id = v_item.producto_id
         AND d.empresa_id  = v_pedido.empresa_id
       ORDER BY (s.cantidad - s.cantidad_reservada) DESC
       LIMIT 1;
    END IF;

    IF NOT FOUND OR v_stock.disponible < v_item.cantidad THEN
      RETURN json_build_object(
        'ok', false,
        'error', 'Stock insuficiente para producto ' || v_item.producto_id::TEXT ||
                 '. Disponible: ' || COALESCE(v_stock.disponible, 0),
        'producto_id', v_item.producto_id
      );
    END IF;

    PERFORM incrementar_stock_reservado(
      v_item.producto_id,
      v_stock.deposito_id,
      v_item.cantidad
    );

    INSERT INTO movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
    VALUES
      (v_item.producto_id, v_stock.deposito_id, 'reserva', v_item.cantidad,
       p_pedido_id, 'Confirmación pedido admin', v_usuario_id);
  END LOOP;

  -- 5. Actualizar estado del pedido
  UPDATE pedidos
     SET estado = 'confirmado'
   WHERE id = p_pedido_id;

  RETURN json_build_object('ok', true, 'pedido_id', p_pedido_id);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ────────────────────────────────────────────────────────────
-- 2) cancelar_pedido: agregar p_usuario_id y p_motivo (opcionales)
-- ────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS cancelar_pedido(UUID);

CREATE OR REPLACE FUNCTION cancelar_pedido(
  p_pedido_id  UUID,
  p_usuario_id UUID DEFAULT NULL,
  p_motivo     TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido  RECORD;
  v_item    RECORD;
  v_stock   RECORD;
  v_uid     UUID;
  v_ref     TEXT;
BEGIN
  v_uid := COALESCE(p_usuario_id, auth.uid());
  v_ref := 'Cancelación pedido' || CASE WHEN p_motivo IS NOT NULL AND p_motivo <> ''
                                          THEN ' — ' || p_motivo ELSE '' END;

  SELECT * INTO v_pedido
    FROM pedidos
   WHERE id = p_pedido_id
     AND empresa_id = get_empresa_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_pedido.estado IN ('entregado', 'cancelado') THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'No se puede cancelar un pedido ' || v_pedido.estado
    );
  END IF;

  -- Liberar stock solo si ya estaba reservado
  IF v_pedido.estado IN ('confirmado', 'preparando') THEN
    FOR v_item IN
      SELECT pi.producto_id, pi.cantidad
        FROM pedido_items pi
       WHERE pi.pedido_id = p_pedido_id
    LOOP
      SELECT s.deposito_id INTO v_stock
        FROM stock s
        JOIN depositos d ON d.id = s.deposito_id
       WHERE s.producto_id = v_item.producto_id
         AND d.empresa_id  = v_pedido.empresa_id
       ORDER BY d.es_principal DESC
       LIMIT 1;

      IF FOUND THEN
        PERFORM liberar_stock_reservado(
          v_item.producto_id, v_stock.deposito_id, v_item.cantidad
        );

        INSERT INTO movimientos_stock
          (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
        VALUES
          (v_item.producto_id, v_stock.deposito_id, 'liberacion', v_item.cantidad,
           p_pedido_id, v_ref, v_uid);
      END IF;
    END LOOP;
  END IF;

  -- Cancelar el pedido
  UPDATE pedidos SET estado = 'cancelado' WHERE id = p_pedido_id;

  -- Anular facturas pendientes vinculadas
  UPDATE facturas
     SET estado = 'anulada'
   WHERE pedido_id = p_pedido_id
     AND estado IN ('pendiente', 'emitida');

  RETURN json_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ────────────────────────────────────────────────────────────
-- 3) marcar_preparado: agregar p_usuario_id (opcional, no usado
--    internamente pero necesario para que coincida con la llamada
--    RPC del frontend)
-- ────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS marcar_preparado(UUID);

CREATE OR REPLACE FUNCTION marcar_preparado(
  p_pedido_id  UUID,
  p_usuario_id UUID DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pedido RECORD;
BEGIN
  SELECT * INTO v_pedido
    FROM pedidos
   WHERE id = p_pedido_id
     AND empresa_id = get_empresa_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_pedido.estado <> 'confirmado' THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'El pedido debe estar confirmado para pasar a preparando (estado: ' || v_pedido.estado || ')'
    );
  END IF;

  UPDATE pedidos SET estado = 'preparando' WHERE id = p_pedido_id;

  RETURN json_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ============================================================
-- FIN DE 013_fase1_fixes.sql
-- ============================================================
