-- ============================================================
-- 444_offline_dedup_entregas_devoluciones_cobro.sql
--
-- Plan offline — Etapa 3, ítems 2 y 3: aplica retroactivamente contra
-- Supabase lo que en el repo local estaba escrito como migraciones 441 y
-- 442 (nunca llegaron a producción — los números 441/442 ya estaban
-- tomados por otras migraciones no relacionadas aplicadas después). El
-- código de lib/handlers/pedidos.js y lib/repos/pedidos.js (v644/v645)
-- ya espera estas columnas y este parámetro; sin esto rompe en producción.
--
-- IMPORTANTE: el borrador viejo de registrar_cobro_completo (442 en el
-- repo local) es anterior a que la función sumara soporte multi-factura
-- (p_facturas_aplicadas / cobro_facturas_aplicadas) y el cálculo de saldo
-- vía clientes.saldo_deuda. Esta migración parte de la definición REAL
-- vigente en producción (verificada con pg_get_functiondef) y le agrega
-- únicamente p_offline_local_id + fast-path + backstop — no se toca
-- ninguna otra lógica.
-- ============================================================

BEGIN;

-- ── entregas / devoluciones: idempotencia a nivel handler (JS), el índice
--    único es el backstop ante una carrera real entre reintentos casi
--    simultáneos del mismo offline_local_id ────────────────────────────

ALTER TABLE entregas
  ADD COLUMN IF NOT EXISTS offline_local_id TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entregas_offline_local_id
  ON entregas (offline_local_id)
  WHERE offline_local_id IS NOT NULL;

COMMENT ON COLUMN entregas.offline_local_id IS
  'ID generado en el dispositivo (crypto.randomUUID()) cuando la confirmación '
  '(entrega o no-entrega) se originó en una acción encolada offline por el '
  'chofer. Evita duplicar la entrega si el outbox reintenta la misma acción.';

ALTER TABLE devoluciones
  ADD COLUMN IF NOT EXISTS offline_local_id TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_devoluciones_offline_local_id
  ON devoluciones (offline_local_id)
  WHERE offline_local_id IS NOT NULL;

COMMENT ON COLUMN devoluciones.offline_local_id IS
  'ID generado en el dispositivo (crypto.randomUUID()) cuando la devolución '
  'se originó en una acción encolada offline por el chofer. Evita duplicar '
  'la devolución (y su nota de débito automática) si el outbox reintenta.';

-- ── registrar_cobro_completo: idempotencia (el cobro asociado a una
--    entrega puede ejecutarse y el handler fallar en un paso posterior,
--    antes de guardar entregas.offline_local_id) ───────────────────────

ALTER TABLE cobros
  ADD COLUMN IF NOT EXISTS offline_local_id TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cobros_offline_local_id
  ON cobros (offline_local_id)
  WHERE offline_local_id IS NOT NULL;

COMMENT ON COLUMN cobros.offline_local_id IS
  'ID generado en el dispositivo (crypto.randomUUID()) cuando el cobro se '
  'originó en una confirmación de entrega encolada offline por el chofer. '
  'Evita duplicar el cobro si el outbox reintenta la misma acción.';

-- DROP explícito: agregar p_offline_local_id con CREATE OR REPLACE crea un
-- overload (firma distinta: 10 args en vez de 9), no reemplaza la función
-- vieja — hay que sacarla primero o quedan las dos.
DROP FUNCTION IF EXISTS public.registrar_cobro_completo(uuid, uuid, numeric, text, text, text, uuid, uuid, jsonb);

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
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  -- ── Fast path: reintento de sync offline ya procesado ──────────────
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
  'Crea cobro + movimiento en cta_cte de forma atómica, reevalúa el bloqueo por deuda del cliente, opcionalmente (p_factura_id / p_facturas_aplicadas) aplica el cobro a una o varias facturas puntuales, y opcionalmente (p_offline_local_id) es idempotente ante reintentos del outbox offline del chofer — devuelve el cobro ya existente en vez de duplicarlo.';

COMMIT;
