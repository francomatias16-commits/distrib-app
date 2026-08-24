-- Punto 6 (Fase A, auditoría financiera 2026): registrar_cobro_completo
-- validaba tenant (empresa_id) y rol DESPUÉS del fast-path de idempotencia
-- (p_offline_local_id) — un caller de otro tenant podía, en teoría, hacer
-- hit en el fast-path y recibir el cobro_id de un cobro ajeno antes de que
-- se rechazara la llamada. Se reordena: tenant y rol se validan primero,
-- el fast-path corre después.
--
-- NOTA (reconstrucción): esta migración ya estaba aplicada en producción
-- (ver CHANGELOG_v870) pero el archivo no había quedado versionado en el
-- repo — recurrencia del "disaster-recovery gap" ya documentado en
-- AUDITORIA_2026. Se reconstruye acá desde la definición real de la
-- función en producción, carácter por carácter (pg_get_functiondef), para
-- que el repo vuelva a reflejar el estado real de la base.

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

  -- Punto 6: tenant y rol se validan ANTES del fast-path (antes se
  -- validaban después) — ningún fast-path idempotente responde sin haber
  -- confirmado primero que el caller pertenece al tenant correspondiente.
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','vendedor','contador','chofer') THEN
    RETURN json_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  -- Punto 5 (migración 508): ya estaba acotado por empresa_id — sigue
  -- igual, solo cambia de posición respecto a las validaciones de arriba.
  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.cobros
     WHERE empresa_id = p_empresa_id
       AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      RETURN json_build_object('ok', true, 'cobro_id', v_existente_id, 'ya_existia', true);
    END IF;
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
       WHERE empresa_id = p_empresa_id
         AND offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        RETURN json_build_object('ok', true, 'cobro_id', v_existente_id, 'ya_existia', true);
      END IF;
    END IF;
    RETURN json_build_object('ok', false, 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'error', SQLERRM);
END;
$function$
