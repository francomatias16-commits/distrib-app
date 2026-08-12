-- FIX: no había ningún vínculo en la base entre un cheque marcado
-- 'entregado_proveedor' y el pago real que representa. La trazabilidad
-- dependía 100% de la disciplina de carga (un texto libre en `referencia`).
-- Esto agrega la columna cheque_id + constraint que impide que el mismo
-- cheque se use para pagar dos facturas a la vez, y actualiza
-- registrar_pago_proveedor para: validar que el cheque exista, pertenezca a
-- la empresa y esté en un estado entregable, lockearlo (FOR UPDATE) contra
-- carga simultánea, marcarlo 'entregado_proveedor' y dejar la referencia
-- guardada automáticamente (banco + número) si no se pasó una manual.

ALTER TABLE public.pagos_proveedor
  ADD COLUMN cheque_id uuid REFERENCES public.cheques(id);

-- Un cheque solo puede respaldar UN pago a proveedor a la vez.
CREATE UNIQUE INDEX uq_pagos_proveedor_cheque_id
  ON public.pagos_proveedor (cheque_id)
  WHERE cheque_id IS NOT NULL;

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

  -- ── Si el pago se respalda con un cheque recibido de un cliente ──────────
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
    p_monto, p_medio, p_fecha, v_referencia, p_notas, p_usuario_id, p_cheque_id
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
