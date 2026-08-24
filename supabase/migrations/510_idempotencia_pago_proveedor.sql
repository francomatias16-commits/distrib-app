-- ============================================================
-- 510_idempotencia_pago_proveedor.sql
--
-- Auditoría pre-lanzamiento 2026 — Punto 7 (Fase A).
--
-- CONTEXTO: registrar_pago_proveedor() no tenía ningún mecanismo de
-- idempotencia. A diferencia de ajustar_stock/registrar_conteo_stock/
-- transferir_stock (punto 5, migración 508) y registrar_cobro_completo
-- (punto 6, migración 509), esta RPC hoy solo se llama desde el panel
-- admin (lib/handlers/cc_proveedores.js, accion=pago) — no hay outbox
-- offline todavía para pagos a proveedores. Aun así, es la misma clase
-- de bug potencial: un reintento de red (doble click, timeout del
-- fetch, retry automático del cliente) puede duplicar un pago real.
-- Se agrega el mismo patrón usado en cobros/ajustes de stock para que
-- quede cerrado de una vez, y listo para cuando el outbox offline
-- (offline-core.js) cubra también el portal de pagos a proveedores.
--
-- FIX:
--  1) Columna pagos_proveedor.offline_local_id + índice único
--     (empresa_id, offline_local_id) parcial, mismo patrón que
--     cobros.offline_local_id (idx_cobros_offline_local_id).
--  2) registrar_pago_proveedor(): nuevo parámetro p_offline_local_id.
--     Tenant/rol se validan PRIMERO (ya estaba así, no se toca), y el
--     fast-path de idempotencia corre INMEDIATAMENTE DESPUÉS de esas
--     validaciones y ANTES de tocar factura/cheque — mismo orden que
--     dejó cerrado el punto 6 en registrar_cobro_completo (509).
-- ============================================================

BEGIN;

ALTER TABLE public.pagos_proveedor
  ADD COLUMN IF NOT EXISTS offline_local_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_proveedor_offline_local_id
  ON public.pagos_proveedor (empresa_id, offline_local_id)
  WHERE (offline_local_id IS NOT NULL);

-- El nuevo parámetro p_offline_local_id vuelve esto un overload distinto
-- para CREATE OR REPLACE (los tipos de parámetros no coinciden con la
-- firma vieja) — hay que dropear la firma vieja explícitamente primero,
-- si no queda un overload fantasma y REVOKE/GRANT/COMMENT sin firma
-- quedan ambiguos.
DROP FUNCTION IF EXISTS public.registrar_pago_proveedor(
  uuid, uuid, uuid, numeric, text, date, text, text, uuid, uuid
);

CREATE OR REPLACE FUNCTION public.registrar_pago_proveedor(
  p_empresa_id        uuid,
  p_proveedor_id      uuid,
  p_factura_id        uuid,
  p_monto             numeric,
  p_medio             text DEFAULT 'transferencia'::text,
  p_fecha             date DEFAULT CURRENT_DATE,
  p_referencia        text DEFAULT NULL::text,
  p_notas             text DEFAULT NULL::text,
  p_usuario_id        uuid DEFAULT NULL::uuid,
  p_cheque_id         uuid DEFAULT NULL::uuid,
  p_offline_local_id  text DEFAULT NULL::text
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
  v_existente_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN ('dueno','admin','contador') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
  END IF;

  -- Punto 7: fast-path idempotente, acotado por empresa_id, corriendo
  -- DESPUÉS de validar tenant/rol (mismo orden que el punto 6 dejó en
  -- registrar_cobro_completo) y ANTES de leer/bloquear la factura.
  IF p_offline_local_id IS NOT NULL THEN
    SELECT id INTO v_existente_id
      FROM public.pagos_proveedor
     WHERE empresa_id = p_empresa_id
       AND offline_local_id = p_offline_local_id
     LIMIT 1;

    IF v_existente_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'pago_id', v_existente_id, 'ya_existia', true);
    END IF;
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
    monto, medio_pago, fecha_pago, referencia, notas, usuario_id, cheque_id,
    offline_local_id
  ) VALUES (
    p_empresa_id, p_proveedor_id, p_factura_id,
    p_monto, p_medio, p_fecha, v_referencia, p_notas, COALESCE(p_usuario_id, auth.uid()), p_cheque_id,
    p_offline_local_id
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

EXCEPTION
  WHEN unique_violation THEN
    IF p_offline_local_id IS NOT NULL THEN
      SELECT id INTO v_existente_id
        FROM public.pagos_proveedor
       WHERE empresa_id = p_empresa_id
         AND offline_local_id = p_offline_local_id
       LIMIT 1;
      IF v_existente_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'pago_id', v_existente_id, 'ya_existia', true);
      END IF;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.registrar_pago_proveedor(
  uuid, uuid, uuid, numeric, text, date, text, text, uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_pago_proveedor(
  uuid, uuid, uuid, numeric, text, date, text, text, uuid, uuid, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.registrar_pago_proveedor(
  uuid, uuid, uuid, numeric, text, date, text, text, uuid, uuid, text
) IS
  'Registra un pago a proveedor contra una factura puntual (con opción de saldarla vía cheque), de forma atómica. Punto 7 (auditoría 2026): acepta p_offline_local_id opcional para ser idempotente ante reintentos, acotado por empresa_id (mismo patrón que registrar_cobro_completo / ajustar_stock), con el fast-path corriendo después de validar tenant/rol.';

COMMIT;
