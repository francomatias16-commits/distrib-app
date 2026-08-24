-- ============================================================
-- 20260823080000_534_cancelar_pedido_combos.sql
-- cancelar_pedido() (485) liberaba stock reservado leyendo
-- `pedido_items.producto_id` directo. Con combos (migración 530) un
-- renglón de combo tiene producto_id NULL y combo_id seteado — ese loop
-- lo ignora (NOT FOUND / liberar_stock_reservado(NULL, ...) es un no-op),
-- así que al cancelar un pedido confirmado con combos la reserva de cada
-- componente queda huérfana para siempre (mismo síntoma que PEDIDOS-AUDIT-01,
-- ahora por renglón de combo en vez de por depósito).
--
-- Fix: mismo patrón ya aplicado en confirmar_pedido (533) — se arma la
-- necesidad total por producto (renglones directos + combo_items × cantidad
-- del renglón de combo) antes de liberar, y se busca el depósito real de
-- CADA componente vía movimientos_stock (tipo='reserva', referencia_id=
-- pedido_id, producto_id=componente) — que confirmar_pedido/crear_pedido_cliente
-- ya insertan por producto_id de componente, no por combo_id, así que el
-- lookup existente sigue siendo válido sin cambios ahí. Se mantiene el
-- fallback a la heurística vieja (depósito principal) para pedidos legado
-- sin movimiento de reserva registrado.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancelar_pedido(p_pedido_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pedido        RECORD;
  v_necesidad     RECORD;
  v_stock         RECORD;
  v_uid           UUID;
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
    -- v534: necesidad TOTAL por producto — renglones directos + componentes
    -- de cada renglón de combo (combo_items × cantidad del renglón) —
    -- mismo criterio de agregación que confirmar_pedido (533), para liberar
    -- exactamente lo que se reservó incluso si un producto aparece tanto
    -- directo como dentro de un combo en el mismo pedido.
    FOR v_necesidad IN
      SELECT producto_id, SUM(cantidad_necesaria) AS cantidad_necesaria
      FROM (
        SELECT pi.producto_id AS producto_id, pi.cantidad AS cantidad_necesaria
          FROM pedido_items pi
         WHERE pi.pedido_id = p_pedido_id
           AND pi.producto_id IS NOT NULL
        UNION ALL
        SELECT ci.producto_id AS producto_id, ci.cantidad * pi.cantidad AS cantidad_necesaria
          FROM pedido_items pi
          JOIN combo_items ci ON ci.combo_id = pi.combo_id
         WHERE pi.pedido_id = p_pedido_id
           AND pi.combo_id IS NOT NULL
      ) necesidades
      GROUP BY producto_id
    LOOP
      -- Depósito real de la reserva de ESTE producto (FIX PEDIDOS-AUDIT-01,
      -- sigue válido tal cual: confirmar_pedido/crear_pedido_cliente
      -- insertan el movimiento de reserva por producto_id de componente,
      -- nunca por combo_id).
      SELECT ms.deposito_id INTO v_deposito_real
        FROM movimientos_stock ms
       WHERE ms.referencia_id = p_pedido_id
         AND ms.tipo = 'reserva'
         AND ms.producto_id = v_necesidad.producto_id
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
         WHERE s.producto_id = v_necesidad.producto_id
           AND d.empresa_id  = v_pedido.empresa_id
         ORDER BY d.es_principal DESC
         LIMIT 1;
      END IF;

      IF v_stock.deposito_id IS NOT NULL THEN
        PERFORM liberar_stock_reservado(
          v_necesidad.producto_id, v_stock.deposito_id, v_necesidad.cantidad_necesaria
        );

        INSERT INTO movimientos_stock
          (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
        VALUES
          (v_necesidad.producto_id, v_stock.deposito_id, 'liberacion', v_necesidad.cantidad_necesaria,
           p_pedido_id, 'Cancelación pedido', v_uid);
      END IF;

      v_deposito_real := NULL;
      v_stock.deposito_id := NULL;
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

COMMENT ON FUNCTION public.cancelar_pedido(uuid, text) IS
  'v534: soporta pedido_items con combo_id (migración 530) — libera stock agregando renglones directos + componentes de cada combo (combo_items × cantidad del renglón) antes de liberar, evitando reservas huérfanas de componentes de combo al cancelar. Base: 485_fix_cancelar_pedido_deposito_real_reserva.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260823080000_534_cancelar_pedido_combos.sql',
  '534',
  'claude_assistant',
  'cancelar_pedido (base: 485) agrega la necesidad de liberación de stock por producto desde renglones directos + componentes de combos, evitando reservas huérfanas de componentes de combo.'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
