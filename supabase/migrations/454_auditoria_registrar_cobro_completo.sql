-- 454 — Auditoría real (usuario_id): cobro manual (Cobranzas / cta-cte)
--
-- Cierra el punto de deuda técnica documentado en v722 (CHANGELOG_v722_
-- auditoria_pagos.md): "Cobranzas/cobro manual (mismo RPC
-- registrar_cobro_completo desde cc_clientes/admin) sigue sin auditoría
-- propia — sería el siguiente módulo lógico si se decide extender la
-- cobertura de cta_cte."
--
-- Investigación previa a este fix: el cobro manual desde el panel admin
-- NO pasa por ningún handler de Node — el frontend llama al RPC
-- `registrar_cobro_completo` directo vía Supabase JS
-- (frontend/admin/js/cta-cte.js y frontend/admin/js/rutas-resumen.js).
-- Por eso, a diferencia de pedidos/pos/pagos/chofer_invitacion (auditados
-- en JS con `registrarAuditoriaSilenciosa`), acá la auditoría solo puede
-- vivir dentro de la función SQL misma — no hay capa de handler que
-- interceptar.
--
-- Mismo criterio que el resto de la serie:
-- - `usuario_id` explícito = COALESCE(p_usuario_id, auth.uid()), la misma
--   resolución que ya usa el INSERT en `cobros` unas líneas más abajo en
--   esta misma función — cubre tanto el cobro manual desde el panel
--   (usuario logueado) como el cobro en reparto del chofer (pedidos.js le
--   pasa `p_usuario_id` explícito).
-- - Best-effort: el INSERT a `audit_log` va en su propio bloque
--   BEGIN/EXCEPTION anidado, para que un fallo de auditoría nunca
--   convierta un cobro ya confirmado (dinero real ya movido) en un
--   `ok:false` de cara al cliente.
-- - Se audita solo el camino de éxito real, después de resolver el
--   desbloqueo del cliente — nunca en el fast path de idempotencia
--   (`ya_existia`, reintento del outbox offline), mismo criterio que
--   "Registrar venta" en pos.js (v721): no duplicar el rastro de un
--   mismo hecho de negocio.

BEGIN;

CREATE OR REPLACE FUNCTION public.registrar_cobro_completo(
  p_empresa_id          UUID,
  p_cliente_id          UUID,
  p_monto               NUMERIC,
  p_medio               TEXT,
  p_referencia          TEXT DEFAULT NULL,
  p_notas               TEXT DEFAULT NULL,
  p_usuario_id          UUID DEFAULT NULL,
  p_factura_id          UUID DEFAULT NULL,
  p_facturas_aplicadas  JSONB DEFAULT NULL,
  p_offline_local_id    TEXT DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  v_usuario_id_resuelto UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  -- ── Fast path: reintento de sync offline ya procesado ──────────────
  -- Sin auditoría acá a propósito: no es un cobro nuevo, es el mismo
  -- hecho de negocio ya registrado (y ya auditado) en el intento original.
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

  v_usuario_id_resuelto := COALESCE(p_usuario_id, auth.uid());

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
                        WHEN (v_factura.total_cobrado + v_aplicado) >= v_factura.total THEN estado
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

  -- ── Auditoría (v454) ─────────────────────────────────────────────
  -- Best-effort en bloque anidado: si el INSERT a audit_log falla, el
  -- cobro (ya confirmado, dinero real ya movido) sigue devolviendo
  -- ok:true — mismo espíritu que `registrarAuditoriaSilenciosa` en JS,
  -- adaptado a PL/pgSQL porque acá no hay capa de handler.
  BEGIN
    INSERT INTO public.audit_log (empresa_id, usuario_id, tabla, accion, registro_id, datos_despues)
    VALUES (
      p_empresa_id,
      v_usuario_id_resuelto,
      'cobros',
      'INSERT',
      v_cobro_id::TEXT,
      jsonb_build_object(
        'monto', p_monto,
        'medio', p_medio,
        'cliente_id', p_cliente_id,
        'nro', v_nro,
        'factura_id', p_factura_id,
        'facturas_aplicadas', v_resultados
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- audit no debe romper el flujo de un cobro ya confirmado
  END;

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
    -- Backstop atómico: carrera real entre dos reintentos offline
    -- concurrentes del mismo offline_local_id.
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
$$;

REVOKE ALL ON FUNCTION public.registrar_cobro_completo FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_cobro_completo TO authenticated, service_role;

COMMENT ON FUNCTION public.registrar_cobro_completo IS
  'Crea cobro + movimiento en cta_cte de forma atómica, reevalúa el bloqueo por deuda del cliente, opcionalmente (p_factura_id / p_facturas_aplicadas) aplica el cobro a una o varias facturas puntuales, opcionalmente (p_offline_local_id) es idempotente ante reintentos del outbox offline del chofer, y audita el cobro real en audit_log (best-effort, v454) — devuelve el cobro ya existente en vez de duplicarlo cuando es un reintento.';

COMMIT;
