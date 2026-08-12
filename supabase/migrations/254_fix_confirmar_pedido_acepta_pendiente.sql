-- 254_fix_confirmar_pedido_acepta_pendiente.sql
--
-- BUG (reportado desde /admin/pedidos, columna Acciones sin botón para
-- pedidos en Confirmado/Preparando/Borrador — el síntoma real terminó
-- siendo más profundo):
--
--   rpc_crear_pedido (migración 029) crea todo pedido nuevo con
--   estado = 'pendiente'. confirmar_pedido_sugerido (piloto WhatsApp)
--   también deja los pedidos en 'pendiente' al aceptarse. En los hechos,
--   'pendiente' es el único estado inicial real: 0 filas de pedidos con
--   estado = 'borrador' en producción.
--
--   Pero confirmar_pedido() —la RPC que el panel admin llama al apretar
--   "Confirmar pedido"— sólo aceptaba avanzar pedidos con
--   estado = 'borrador'. Resultado: TODO pedido nuevo (375 al momento de
--   este fix) fallaba silenciosamente al intentar confirmarlo
--   (RPC devolvía {ok:false, error:'El pedido no está en borrador...'}),
--   quedando trabado en 'pendiente' sin forma de avanzar por la UI.
--
-- FIX: confirmar_pedido() ahora acepta tanto 'borrador' como 'pendiente'
-- como estado de partida válido.
--
-- Acompaña el fix de frontend (pedidos.js / pedidos.html / pedidos.css)
-- que agrega 'pendiente' a TRANSICIONES, capEstado, el chip de estado y
-- el pill de filtro (antes decía "Borrador", ahora "Pendiente").

CREATE OR REPLACE FUNCTION public.confirmar_pedido(p_pedido_id uuid, p_forzar boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pedido       RECORD;
  v_cliente      RECORD;
  v_item         RECORD;
  v_stock        RECORD;
  v_deposito_id  UUID;
  v_disponible   NUMERIC;
  v_usuario_id   UUID;
BEGIN
  v_usuario_id := auth.uid();

  SELECT p.*, e.id AS eid
    INTO v_pedido
    FROM pedidos p
    JOIN empresas e ON e.id = p.empresa_id
   WHERE p.id = p_pedido_id
     AND p.empresa_id = get_empresa_id()
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'Pedido no encontrado');
  END IF;

  IF v_pedido.estado NOT IN ('borrador', 'pendiente') THEN
    RETURN json_build_object(
      'ok', false,
      'error', 'El pedido no está pendiente de confirmación (estado actual: ' || v_pedido.estado || ')'
    );
  END IF;

  SELECT * INTO v_cliente FROM clientes WHERE id = v_pedido.cliente_id;

  IF NOT p_forzar AND v_cliente.limite_credito > 0 THEN
    IF (COALESCE(v_cliente.saldo_deuda, 0) + v_pedido.total) > v_cliente.limite_credito THEN
      RETURN json_build_object(
        'ok', false,
        'error', 'Límite de crédito superado. Saldo actual: $' || v_cliente.saldo_deuda || ' / Límite: $' || v_cliente.limite_credito,
        'tipo', 'limite_credito'
      );
    END IF;
  END IF;

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

  UPDATE pedidos
     SET estado = 'confirmado'
   WHERE id = p_pedido_id;

  RETURN json_build_object('ok', true, 'pedido_id', p_pedido_id);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
