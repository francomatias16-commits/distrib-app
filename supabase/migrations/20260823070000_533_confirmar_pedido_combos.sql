-- ============================================================
-- 20260823070000_533_confirmar_pedido_combos.sql
-- confirmar_pedido() (admin/vendedor): el loop de reserva de stock leía
-- pedido_items asumiendo que todo renglón tiene producto_id. Con combos
-- (migración 530) eso ya no es así — se explota cada renglón de combo en
-- sus componentes (combo_items) antes de chequear/reservar, igual que
-- crear_pedido_cliente (532). Firma sin cambios respecto a la vigente
-- (20260818_p1...).
-- ============================================================

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
  v_necesidad    RECORD;
BEGIN
  v_usuario_id := auth.uid();

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','vendedor','depositero','contador') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

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

  IF p_forzar AND auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado para forzar el límite de crédito');
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

  -- v533: se arma la necesidad TOTAL por producto (renglones directos +
  -- componentes de cada renglón de combo, multiplicados por su cantidad)
  -- antes de reservar, para no reservar dos veces de forma independiente
  -- si el mismo producto aparece directo y dentro de un combo.
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
    SELECT s.deposito_id,
           (s.cantidad - s.cantidad_reservada) AS disponible
      INTO v_stock
      FROM stock s
      JOIN depositos d ON d.id = s.deposito_id
     WHERE s.producto_id = v_necesidad.producto_id
       AND d.empresa_id  = v_pedido.empresa_id
       AND d.es_principal = TRUE
     LIMIT 1;

    IF NOT FOUND THEN
      SELECT s.deposito_id,
             (s.cantidad - s.cantidad_reservada) AS disponible
        INTO v_stock
        FROM stock s
        JOIN depositos d ON d.id = s.deposito_id
       WHERE s.producto_id = v_necesidad.producto_id
         AND d.empresa_id  = v_pedido.empresa_id
       ORDER BY (s.cantidad - s.cantidad_reservada) DESC
       LIMIT 1;
    END IF;

    IF NOT FOUND OR v_stock.disponible < v_necesidad.cantidad_necesaria THEN
      RETURN json_build_object(
        'ok', false,
        'error', 'Stock insuficiente para producto ' || v_necesidad.producto_id::TEXT ||
                 '. Disponible: ' || COALESCE(v_stock.disponible, 0),
        'producto_id', v_necesidad.producto_id
      );
    END IF;

    PERFORM incrementar_stock_reservado(
      v_necesidad.producto_id,
      v_stock.deposito_id,
      v_necesidad.cantidad_necesaria
    );

    INSERT INTO movimientos_stock
      (producto_id, deposito_id, tipo, cantidad, referencia_id, referencia, usuario_id)
    VALUES
      (v_necesidad.producto_id, v_stock.deposito_id, 'reserva', v_necesidad.cantidad_necesaria,
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

COMMENT ON FUNCTION public.confirmar_pedido(uuid, boolean) IS
  'v533: soporta pedido_items con combo_id (migración 530) — la necesidad de stock por producto se agrega desde renglones directos + componentes de cada combo (combo_items × cantidad del renglón) antes de reservar, evitando reservar el mismo producto dos veces si aparece directo y dentro de un combo.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260823070000_533_confirmar_pedido_combos.sql',
  '533',
  'claude_assistant',
  'confirmar_pedido (base: 20260818_p1) agrega la necesidad de stock por producto desde renglones directos + componentes de combos antes de reservar.'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
