-- Fix PEDIDOS-AUDIT-01: cancelar_pedido() liberaba el stock reservado
-- buscando el depósito con `ORDER BY es_principal DESC LIMIT 1` — es decir,
-- siempre prefería el depósito principal si existía un registro de stock
-- ahí para ese producto — en vez de usar el depósito REAL donde
-- confirmar_pedido() había hecho la reserva (que puede ser un depósito
-- secundario, si el principal no tenía disponible suficiente en ese
-- momento: confirmar_pedido() prueba primero el principal y si no alcanza
-- cae al depósito con más disponible).
--
-- Con al menos una empresa ya operando con más de un depósito activo en
-- producción, esto es un bug real: al cancelar un pedido reservado en un
-- depósito secundario, esa reserva queda huérfana para siempre (nunca se
-- libera, reduce el disponible de ese depósito de forma permanente), y de
-- paso `liberar_stock_reservado` (que usa GREATEST(0, ...) sin validar)
-- puede descontar sin avisar la reserva del depósito principal si tenía
-- otras reservas activas de otros pedidos.
--
-- Fix: se toma el depósito real desde el movimiento de reserva original
-- (movimientos_stock, tipo='reserva', referencia_id=pedido_id) — mismo
-- patrón ya usado para corregir el caso análogo en POS (migración 483).
-- Fallback a la heurística vieja solo si no hay movimiento de reserva
-- registrado (pedidos legado/edge case), para no romper nada existente.

CREATE OR REPLACE FUNCTION public.cancelar_pedido(p_pedido_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pedido  RECORD;
  v_item    RECORD;
  v_stock   RECORD;
  v_uid     UUID;
  v_deposito_real UUID;
BEGIN
  v_uid := auth.uid();

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

  IF v_pedido.estado IN ('confirmado', 'preparando') THEN
    FOR v_item IN
      SELECT pi.producto_id, pi.cantidad
        FROM pedido_items pi
       WHERE pi.pedido_id = p_pedido_id
    LOOP
      -- FIX PEDIDOS-AUDIT-01: depósito real de la reserva, no heurística.
      SELECT ms.deposito_id INTO v_deposito_real
        FROM movimientos_stock ms
       WHERE ms.referencia_id = p_pedido_id
         AND ms.tipo = 'reserva'
         AND ms.producto_id = v_item.producto_id
       ORDER BY ms.created_at DESC
       LIMIT 1;

      IF v_deposito_real IS NOT NULL THEN
        v_stock.deposito_id := v_deposito_real;
      ELSE
        -- Fallback: heurística vieja, solo para pedidos sin movimiento de
        -- reserva registrado (legado).
        SELECT s.deposito_id INTO v_stock
          FROM stock s
          JOIN depositos d ON d.id = s.deposito_id
         WHERE s.producto_id = v_item.producto_id
           AND d.empresa_id  = v_pedido.empresa_id
         ORDER BY d.es_principal DESC
         LIMIT 1;
      END IF;

      IF v_stock.deposito_id IS NOT NULL THEN
        PERFORM liberar_stock_reservado(
          v_item.producto_id, v_stock.deposito_id, v_item.cantidad
        );

        INSERT INTO movimientos_stock
          (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
        VALUES
          (v_item.producto_id, v_stock.deposito_id, 'liberacion', v_item.cantidad,
           p_pedido_id, 'Cancelación pedido', v_uid);
      END IF;
    END LOOP;
  END IF;

  UPDATE pedidos
     SET estado = 'cancelado',
         notas_internas = COALESCE(p_motivo, notas_internas)
   WHERE id = p_pedido_id;

  UPDATE facturas
     SET estado = 'anulada'
   WHERE pedido_id = p_pedido_id
     AND estado IN ('pendiente', 'emitida');

  RETURN json_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
