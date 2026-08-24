-- ============================================================================
-- P1 — Lote 2: gates de ROL dentro de RPCs financieras + validaciones de
-- ownership + constraint único de idempotencia POS.
-- Cubre: SEC-03, SEC-08, SYNC-03, SYNC-05.
--
-- NOTA DE RECONCILIACIÓN (sandbox): igual que 20260817_p0_criticos_auditoria2026.sql
-- — esta migración ya está aplicada en Supabase (migration history
-- 20260818021658, nombre "20260817_p1_rpcs_financieras_auditoria2026") y se
-- agrega acá recién ahora para sincronizar el repo local. NO aplicar de
-- nuevo. El borrador local anterior que cubría SEC-03/SEC-08
-- (20260818_auditoria_integral_2026_sec03_sec08_altos.sql) quedó
-- descartado: no llegó a aplicarse y esta es la versión real ya en
-- producción/QA, con más validaciones que ese borrador (p.ej.
-- crear_presupuesto_con_items acá recalcula subtotal/total server-side en
-- vez de solo comparar contra el payload, y valida que cada producto sea de
-- la empresa).
-- ============================================================================

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

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','vendedor','depositero','contador') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

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

CREATE OR REPLACE FUNCTION public.registrar_cobro_completo(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_monto numeric,
  p_medio text,
  p_referencia text DEFAULT NULL::text,
  p_notas text DEFAULT NULL::text,
  p_usuario_id uuid DEFAULT NULL::uuid,
  p_factura_id uuid DEFAULT NULL::uuid,
  p_facturas_aplicadas jsonb DEFAULT NULL::jsonb,
  p_offline_local_id text DEFAULT NULL::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cobro_id     UUID;
  v_nro          TEXT;
  v_saldo        NUMERIC;
  v_factura      RECORD;
  v_aplicado     NUMERIC;
  v_item         JSONB;
  v_fact_id      UUID;
  v_monto_pedido NUMERIC;
  v_restante     NUMERIC;
  v_total_aplicado NUMERIC := 0;
  v_resultados   JSONB := '[]'::JSONB;
  v_existente_id UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.cobros
     WHERE offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      RETURN json_build_object('ok', true, 'cobro_id', v_existente_id, 'ya_existia', true);
    END IF;
  END IF;

  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','vendedor','contador','chofer') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF p_monto <= 0 THEN
    RETURN json_build_object('ok', false, 'error', 'El monto debe ser mayor a cero');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id) THEN
    RETURN json_build_object('ok', false, 'error', 'Cliente no encontrado en la empresa');
  END IF;

  IF p_facturas_aplicadas IS NULL AND p_factura_id IS NOT NULL THEN
    p_facturas_aplicadas := jsonb_build_array(jsonb_build_object('factura_id', p_factura_id, 'monto', p_monto));
  END IF;

  v_restante := p_monto;
  IF p_facturas_aplicadas IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_facturas_aplicadas)
    LOOP
      v_fact_id      := (v_item->>'factura_id')::UUID;
      v_monto_pedido := (v_item->>'monto')::NUMERIC;

      IF v_monto_pedido IS NULL OR v_monto_pedido <= 0 THEN
        RETURN json_build_object('ok', false, 'error', 'Monto inválido en facturas_aplicadas');
      END IF;

      SELECT id, total, COALESCE(total_cobrado, 0) AS total_cobrado, estado
        INTO v_factura
        FROM facturas
       WHERE id = v_fact_id AND empresa_id = p_empresa_id AND cliente_id = p_cliente_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RETURN json_build_object('ok', false, 'error', 'Una factura indicada no existe o no pertenece a este cliente');
      END IF;

      IF v_factura.estado = 'anulada' THEN
        RETURN json_build_object('ok', false, 'error', 'Una de las facturas está anulada, no se le puede aplicar un cobro');
      END IF;

      IF (v_factura.total - v_factura.total_cobrado) <= 0 THEN
        RETURN json_build_object('ok', false, 'error', 'Una de las facturas ya está saldada');
      END IF;

      v_total_aplicado := v_total_aplicado + LEAST(v_monto_pedido, v_factura.total - v_factura.total_cobrado, v_restante);
    END LOOP;

    IF v_total_aplicado > p_monto THEN
      RETURN json_build_object('ok', false, 'error', 'La suma de facturas_aplicadas supera el monto del cobro');
    END IF;
  END IF;

  v_nro := siguiente_numero_comprobante(p_empresa_id, 'cobro');

  INSERT INTO cobros (empresa_id, cliente_id, monto, medio, referencia, notas, usuario_id, offline_local_id)
  VALUES (p_empresa_id, p_cliente_id, p_monto, p_medio, p_referencia, p_notas,
          COALESCE(p_usuario_id, auth.uid()), p_offline_local_id)
  RETURNING id INTO v_cobro_id;

  INSERT INTO cta_cte (empresa_id, cliente_id, tipo, monto, cobro_id,
                        nro_comprobante, descripcion, medio_pago)
  VALUES (p_empresa_id, p_cliente_id, 'cobro', p_monto, v_cobro_id, v_nro,
          'Cobro ' || p_medio || COALESCE(' — ' || p_referencia, ''), p_medio);

  v_restante := p_monto;
  IF p_facturas_aplicadas IS NOT NULL THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_facturas_aplicadas)
    LOOP
      v_fact_id      := (v_item->>'factura_id')::UUID;
      v_monto_pedido := (v_item->>'monto')::NUMERIC;

      SELECT id, total, COALESCE(total_cobrado, 0) AS total_cobrado, estado
        INTO v_factura
        FROM facturas
       WHERE id = v_fact_id AND empresa_id = p_empresa_id AND cliente_id = p_cliente_id;

      v_aplicado := LEAST(v_monto_pedido, v_factura.total - v_factura.total_cobrado, v_restante);
      v_restante := v_restante - v_aplicado;

      UPDATE facturas
         SET total_cobrado = v_factura.total_cobrado + v_aplicado,
             estado = CASE
                        WHEN (v_factura.total_cobrado + v_aplicado) >= v_factura.total
                             AND v_factura.estado = 'parcial'::estado_factura
                          THEN 'emitida'::estado_factura
                        WHEN (v_factura.total_cobrado + v_aplicado) >= v_factura.total
                          THEN estado
                        ELSE 'parcial'::estado_factura
                      END
       WHERE id = v_fact_id;

      INSERT INTO cobro_facturas_aplicadas (cobro_id, factura_id, empresa_id, monto_aplicado)
      VALUES (v_cobro_id, v_fact_id, p_empresa_id, v_aplicado);

      v_resultados := v_resultados || jsonb_build_object(
        'factura_id', v_fact_id,
        'monto_aplicado', v_aplicado,
        'saldada', (v_factura.total_cobrado + v_aplicado) >= v_factura.total
      );
    END LOOP;
  END IF;

  SELECT COALESCE(saldo_deuda, 0) INTO v_saldo
  FROM clientes WHERE id = p_cliente_id;

  IF v_saldo <= 0 THEN
    UPDATE clientes
    SET bloqueado = false, bloqueado_motivo = NULL
    WHERE id = p_cliente_id AND bloqueado = true;

    UPDATE bloqueos_cliente
    SET activo = false
    WHERE cliente_id = p_cliente_id AND activo = true;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'cobro_id', v_cobro_id,
    'nro', v_nro,
    'factura_id', p_factura_id,
    'factura_saldada', CASE WHEN p_factura_id IS NOT NULL AND jsonb_array_length(v_resultados) = 1
                             THEN (v_resultados->0->>'saldada')::BOOLEAN
                             ELSE NULL END,
    'facturas_aplicadas', CASE WHEN jsonb_array_length(v_resultados) > 0 THEN v_resultados ELSE NULL END
  );

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id INTO v_existente_id
        FROM public.cobros
       WHERE offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        RETURN json_build_object('ok', true, 'cobro_id', v_existente_id, 'ya_existia', true);
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_pago_proveedor(
  p_empresa_id uuid,
  p_proveedor_id uuid,
  p_factura_id uuid,
  p_monto numeric,
  p_medio text DEFAULT 'transferencia'::text,
  p_fecha date DEFAULT CURRENT_DATE,
  p_referencia text DEFAULT NULL::text,
  p_notas text DEFAULT NULL::text,
  p_usuario_id uuid DEFAULT NULL::uuid,
  p_cheque_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_factura      record;
  v_saldo        numeric;
  v_nuevo_pagado numeric;
  v_nuevo_estado text;
  v_cheque       record;
  v_referencia   text := p_referencia;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','contador') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a cero');
  END IF;

  SELECT * INTO v_factura
  FROM public.facturas_proveedor
  WHERE id = p_factura_id AND empresa_id = p_empresa_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Factura no encontrada');
  END IF;

  IF v_factura.proveedor_id IS DISTINCT FROM p_proveedor_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La factura no pertenece al proveedor indicado');
  END IF;

  IF v_factura.estado = 'anulada' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La factura está anulada');
  END IF;

  IF v_factura.estado = 'pagada' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'La factura ya está pagada');
  END IF;

  v_saldo := v_factura.total - v_factura.total_pagado;
  IF p_monto > v_saldo THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format(
        'El monto ($%s) supera el saldo pendiente de la factura ($%s). Corregí el monto o registrá el pago contra la factura correcta.',
        to_char(p_monto, 'FM999999999.00'), to_char(v_saldo, 'FM999999999.00')
      ),
      'saldo_pendiente', v_saldo
    );
  END IF;

  IF p_cheque_id IS NOT NULL THEN
    SELECT * INTO v_cheque
    FROM public.cheques
    WHERE id = p_cheque_id AND empresa_id = p_empresa_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Cheque no encontrado en la empresa');
    END IF;

    IF v_cheque.estado NOT IN ('pendiente', 'en_cartera') THEN
      RETURN jsonb_build_object('ok', false, 'error',
        format('El cheque está en estado "%s" y no se puede entregar a un proveedor', v_cheque.estado));
    END IF;

    IF v_cheque.monto IS DISTINCT FROM p_monto THEN
      RETURN jsonb_build_object('ok', false, 'error',
        format('El monto del pago ($%s) no coincide con el del cheque ($%s)',
          to_char(p_monto, 'FM999999999.00'), to_char(v_cheque.monto, 'FM999999999.00')));
    END IF;

    UPDATE public.cheques
       SET estado = 'entregado_proveedor'
     WHERE id = p_cheque_id;

    IF v_referencia IS NULL THEN
      v_referencia := 'Cheque ' || v_cheque.banco || ' N° ' || v_cheque.numero;
    END IF;
  END IF;

  INSERT INTO public.pagos_proveedor (
    empresa_id, proveedor_id, factura_id,
    monto, medio_pago, fecha_pago, referencia, notas, usuario_id, cheque_id
  ) VALUES (
    p_empresa_id, p_proveedor_id, p_factura_id,
    p_monto, p_medio, p_fecha, v_referencia, p_notas, COALESCE(p_usuario_id, auth.uid()), p_cheque_id
  );

  v_nuevo_pagado := v_factura.total_pagado + p_monto;

  v_nuevo_estado := CASE
    WHEN v_nuevo_pagado >= v_factura.total THEN 'pagada'
    WHEN v_nuevo_pagado > 0                THEN 'parcial'
    ELSE 'pendiente'
  END;

  UPDATE public.facturas_proveedor
  SET total_pagado = v_nuevo_pagado,
      estado       = v_nuevo_estado,
      updated_at   = now()
  WHERE id = p_factura_id;

  RETURN jsonb_build_object(
    'ok',           true,
    'total_pagado', v_nuevo_pagado,
    'saldo',        v_factura.total - v_nuevo_pagado,
    'estado',       v_nuevo_estado
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.crear_nota_credito(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_tipo text,
  p_motivo text,
  p_items jsonb,
  p_factura_id uuid DEFAULT NULL::uuid,
  p_created_by uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_nc_id UUID;
  v_item  JSONB;
  v_neto  NUMERIC := 0;
  v_iva   NUMERIC := 0;
  v_sub   NUMERIC;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado en la empresa');
  END IF;

  IF p_factura_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM facturas WHERE id = p_factura_id AND empresa_id = p_empresa_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Factura no encontrada');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sub  := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_unitario')::NUMERIC;
    v_neto := v_neto + v_sub;
  END LOOP;

  IF p_tipo IN ('A','B') THEN
    v_iva := v_neto * 0.21;
  END IF;

  INSERT INTO notas_credito
    (empresa_id, cliente_id, factura_id, tipo, motivo, neto, iva, total,
     estado, created_by)
  VALUES
    (p_empresa_id, p_cliente_id, p_factura_id, p_tipo, p_motivo,
     v_neto, v_iva, v_neto + v_iva, 'pendiente', COALESCE(p_created_by, auth.uid()))
  RETURNING id INTO v_nc_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_sub := (v_item->>'cantidad')::NUMERIC * (v_item->>'precio_unitario')::NUMERIC;
    INSERT INTO notas_credito_items
      (nota_credito_id, descripcion, cantidad, precio_unitario, subtotal)
    VALUES (
      v_nc_id,
      v_item->>'descripcion',
      (v_item->>'cantidad')::NUMERIC,
      (v_item->>'precio_unitario')::NUMERIC,
      v_sub
    );
  END LOOP;

  RETURN jsonb_build_object('id', v_nc_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.crear_presupuesto_con_items(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_vendedor_id uuid,
  p_estado text,
  p_subtotal numeric,
  p_total numeric,
  p_notas text,
  p_fecha_vencimiento timestamp with time zone,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_numero text;
  v_next integer;
  v_presupuesto_id uuid;
  v_item jsonb;
  v_subtotal_calc numeric := 0;
  v_sub numeric;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','vendedor','contador') THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'El presupuesto necesita al menos un ítem';
  END IF;

  IF p_cliente_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = p_empresa_id
  ) THEN
    RAISE EXCEPTION 'Cliente no encontrado en la empresa';
  END IF;

  IF p_vendedor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM usuarios WHERE id = p_vendedor_id AND empresa_id = p_empresa_id
  ) THEN
    RAISE EXCEPTION 'Vendedor no encontrado en la empresa';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM productos
       WHERE id = (v_item->>'producto_id')::uuid AND empresa_id = p_empresa_id
    ) THEN
      RAISE EXCEPTION 'Producto de un ítem no pertenece a la empresa';
    END IF;
    v_sub := (v_item->>'cantidad')::numeric * (v_item->>'precio_unitario')::numeric
             * (1 - COALESCE((v_item->>'descuento_pct')::numeric, 0) / 100);
    v_subtotal_calc := v_subtotal_calc + v_sub;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_empresa_id::text || ':presupuesto', 0));

  SELECT COALESCE(MAX((substring(numero FROM 'PRES-([0-9]+)'))::integer), 0) + 1
    INTO v_next
    FROM public.presupuestos
   WHERE empresa_id = p_empresa_id
     AND numero ~ '^PRES-[0-9]+$';
  v_numero := 'PRES-' || lpad(v_next::text, 5, '0');

  INSERT INTO public.presupuestos (
    empresa_id, cliente_id, vendedor_id, numero, estado,
    subtotal, total, notas, fecha_vencimiento
  ) VALUES (
    p_empresa_id, p_cliente_id, p_vendedor_id, v_numero, p_estado,
    v_subtotal_calc, v_subtotal_calc, p_notas, p_fecha_vencimiento
  ) RETURNING id INTO v_presupuesto_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.presupuesto_items (
      presupuesto_id, producto_id, cantidad, precio_unitario, descuento_pct, subtotal
    ) VALUES (
      v_presupuesto_id,
      (v_item->>'producto_id')::uuid,
      (v_item->>'cantidad')::numeric,
      (v_item->>'precio_unitario')::numeric,
      COALESCE((v_item->>'descuento_pct')::numeric, 0),
      (v_item->>'cantidad')::numeric * (v_item->>'precio_unitario')::numeric
        * (1 - COALESCE((v_item->>'descuento_pct')::numeric, 0) / 100)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'presupuesto_id', v_presupuesto_id,
    'numero', v_numero,
    'total', v_subtotal_calc
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.siguiente_numero_comprobante(p_empresa_id uuid, p_tipo text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_siguiente integer;
  v_empresa_actual uuid;
BEGIN
  IF p_tipo NOT IN ('OC','factura_b','nota_credito','REMITO','remito','presupuesto','cobro') THEN
    RAISE EXCEPTION 'Tipo de comprobante inválido: %', p_tipo;
  END IF;

  IF auth.role() <> 'service_role' THEN
    v_empresa_actual := public.get_empresa_id();
    IF v_empresa_actual IS NULL OR p_empresa_id IS NULL OR p_empresa_id IS DISTINCT FROM v_empresa_actual THEN
      RAISE EXCEPTION 'No autorizado';
    END IF;
  END IF;

  INSERT INTO public.contadores_empresa (empresa_id, tipo, ultimo_numero)
    VALUES (p_empresa_id, p_tipo, 0)
    ON CONFLICT (empresa_id, tipo) DO NOTHING;

  SELECT ultimo_numero + 1
    INTO v_siguiente
    FROM public.contadores_empresa
   WHERE empresa_id = p_empresa_id
     AND tipo       = p_tipo
   FOR UPDATE;

  UPDATE public.contadores_empresa
     SET ultimo_numero = v_siguiente,
         updated_at    = now()
   WHERE empresa_id = p_empresa_id
     AND tipo       = p_tipo;

  RETURN lpad(v_siguiente::text, 8, '0');
END;
$function$;

-- SYNC-05: constraint único que faltaba para deduplicar facturación POS por
-- venta_pos_id (evita facturas duplicadas si el flujo de facturación desde
-- POS se reintenta).
DROP INDEX IF EXISTS public.idx_facturas_venta_pos;
CREATE UNIQUE INDEX idx_facturas_venta_pos_unique
  ON public.facturas (venta_pos_id)
  WHERE venta_pos_id IS NOT NULL;
