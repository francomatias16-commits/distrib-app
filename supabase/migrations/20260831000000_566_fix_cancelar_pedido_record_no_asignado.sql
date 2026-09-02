-- ============================================================
-- 20260831000000_566_fix_cancelar_pedido_record_no_asignado.sql
--
-- cancelar_pedido() (534) declara `v_stock RECORD` y, cuando existe un
-- movimiento de reserva real para el producto (v_deposito_real IS NOT
-- NULL), hace `v_stock.deposito_id := v_deposito_real;` — pero un
-- RECORD en PL/pgSQL no puede recibir una asignación de campo hasta
-- que fue tipado por un SELECT INTO previo. Como en ese branch nunca
-- se hizo SELECT INTO v_stock antes, Postgres lanza
-- "record \"v_stock\" is not assigned yet", la excepción es capturada
-- por el EXCEPTION WHEN OTHERS de la función y esta responde
-- {ok:false, error:...} sin haber liberado stock NI actualizado
-- pedidos.estado — el pedido queda "confirmado" para siempre
-- (detectado por test-integration.js T25: la RPC "devuelve resultado"
-- pero el estado nunca pasa a 'cancelado').
--
-- Fix: se reemplaza el RECORD `v_stock` por una variable escalar
-- `v_deposito_id_liberar UUID`, que sí admite asignación directa en
-- ambos branches (reserva real vía movimientos_stock, o fallback por
-- depósito principal). Mismo patrón que ya usa confirmar_pedido (533),
-- que declara `v_deposito_id UUID` aparte de `v_stock RECORD` para
-- este propósito.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancelar_pedido(p_pedido_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pedido               RECORD;
  v_necesidad             RECORD;
  v_uid                   UUID;
  v_deposito_real         UUID;
  v_deposito_id_liberar   UUID;
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
      v_deposito_id_liberar := NULL;

      SELECT ms.deposito_id INTO v_deposito_real
        FROM movimientos_stock ms
       WHERE ms.referencia_id = p_pedido_id
         AND ms.tipo = 'reserva'
         AND ms.producto_id = v_necesidad.producto_id
       ORDER BY ms.created_at DESC
       LIMIT 1;

      IF v_deposito_real IS NOT NULL THEN
        v_deposito_id_liberar := v_deposito_real;
      ELSE
        -- Fallback: heurística vieja, solo para pedidos sin movimiento de
        -- reserva registrado (legado).
        SELECT s.deposito_id INTO v_deposito_id_liberar
          FROM stock s
          JOIN depositos d ON d.id = s.deposito_id
         WHERE s.producto_id = v_necesidad.producto_id
           AND d.empresa_id  = v_pedido.empresa_id
         ORDER BY d.es_principal DESC
         LIMIT 1;
      END IF;

      IF v_deposito_id_liberar IS NOT NULL THEN
        PERFORM liberar_stock_reservado(
          v_necesidad.producto_id, v_deposito_id_liberar, v_necesidad.cantidad_necesaria
        );

        INSERT INTO movimientos_stock
          (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
        VALUES
          (v_necesidad.producto_id, v_deposito_id_liberar, 'liberacion', v_necesidad.cantidad_necesaria,
           p_pedido_id, 'Cancelación pedido', v_uid);
      END IF;

      v_deposito_real := NULL;
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
  'v566: fix de v534 — v_stock era RECORD y se le asignaba un campo (v_stock.deposito_id) sin SELECT INTO previo, lo que producía "record not assigned yet" y hacía que la cancelación fallara en silencio (estado nunca pasaba a cancelado). Reemplazado por variable escalar v_deposito_id_liberar. Base: 534_cancelar_pedido_combos.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260831000000_566_fix_cancelar_pedido_record_no_asignado.sql',
  '566',
  'claude_assistant',
  'Fix cancelar_pedido: v_stock RECORD con asignación de campo sin SELECT INTO previo causaba excepción silenciosa (estado nunca cambiaba a cancelado). Reemplazado por v_deposito_id_liberar UUID.'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
