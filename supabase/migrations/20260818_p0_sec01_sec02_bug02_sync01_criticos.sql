-- ============================================================================
-- P0 — Fixes críticos, Auditoría Integral 2026.
-- Cubre: SEC-01, SEC-02, BUG-02, SYNC-01.
--
-- APLICADA en producción (jgiquzjwoedmzwqgzubr) — este archivo se agrega acá
-- para sincronizar el repo local. Contenido verificado directamente contra
-- pg_get_functiondef() en producción el 2026-08-18, NO copiado a ciegas de
-- ningún borrador ni de texto pegado en el chat. El borrador local previo
-- (mismo nombre lógico) tenía el bug de falta de bypass para service_role
-- en exportar_contable/transferir_stock_entre_depositos y quedó descartado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- SEC-01 (CRÍTICA) — exportar_contable
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.exportar_contable(uuid, text, date, date, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.exportar_contable(uuid, text, date, date, uuid, text) FROM public;

CREATE OR REPLACE FUNCTION public.exportar_contable(
  p_empresa_id uuid,
  p_tipo text,
  p_desde date,
  p_hasta date,
  p_usuario_id uuid,
  p_proveedor text DEFAULT 'generico_csv'::text
)
RETURNS TABLE(fecha date, comprobante text, cuenta text, descripcion text, debe numeric, haber numeric, origen_tipo text, origen_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
  v_usuario_id uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'No autorizado';
    END IF;
    IF p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
      RAISE EXCEPTION 'No autorizado';
    END IF;
    IF public.get_rol_usuario() NOT IN ('dueno','admin','contador') THEN
      RAISE EXCEPTION 'No autorizado: se requiere rol contable';
    END IF;
    v_usuario_id := auth.uid();
  ELSE
    v_usuario_id := p_usuario_id;
  END IF;

  IF p_tipo NOT IN ('ventas','compras','cobranzas') THEN
    RAISE EXCEPTION 'tipo inválido: % (debe ser ventas, compras o cobranzas)', p_tipo;
  END IF;

  CREATE TEMP TABLE _export_tmp ON COMMIT DROP AS
  SELECT * FROM (
    SELECT * FROM generar_asientos_ventas(p_empresa_id, p_desde, p_hasta) WHERE p_tipo = 'ventas'
    UNION ALL
    SELECT * FROM generar_asientos_compras(p_empresa_id, p_desde, p_hasta) WHERE p_tipo = 'compras'
    UNION ALL
    SELECT * FROM generar_asientos_cobranzas(p_empresa_id, p_desde, p_hasta) WHERE p_tipo = 'cobranzas'
  ) x;

  SELECT COUNT(*) INTO v_count FROM _export_tmp;

  INSERT INTO export_contable_log (id, empresa_id, proveedor, tipo, fecha_desde, fecha_hasta, cantidad_registros, usuario_id, archivo_nombre)
  VALUES (gen_random_uuid(), p_empresa_id, p_proveedor, p_tipo, p_desde, p_hasta, v_count, v_usuario_id,
          'export_contable_' || p_tipo || '_' || p_desde || '_' || p_hasta || '.csv');

  RETURN QUERY SELECT * FROM _export_tmp;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.exportar_contable(uuid, text, date, date, uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- SEC-02 (CRÍTICA) — transferir_stock_entre_depositos
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transferir_stock_entre_depositos(
  p_producto_id uuid,
  p_deposito_origen uuid,
  p_deposito_destino uuid,
  p_cantidad numeric,
  p_usuario_id uuid,
  p_notas text DEFAULT NULL::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_disponible_origen NUMERIC;
  v_costo_promedio    NUMERIC;
  v_empresa_id        UUID;
  v_empresa_destino   UUID;
  v_empresa_sesion    UUID;
  v_usuario_id        UUID;
  v_lote              RECORD;
  v_restante          NUMERIC;
  v_consumir          NUMERIC;
  v_mov_origen_id      UUID;
  v_mov_destino_id     UUID;
  v_lote_destino_id    UUID;
BEGIN
  IF p_deposito_origen = p_deposito_destino THEN
    RETURN json_build_object('ok', false, 'tipo', 'depositos_iguales',
      'error', 'El depósito de origen y destino no pueden ser el mismo');
  END IF;

  IF p_cantidad <= 0 THEN
    RETURN json_build_object('ok', false, 'tipo', 'cantidad_invalida',
      'error', 'La cantidad a transferir debe ser mayor a cero');
  END IF;

  SELECT empresa_id INTO v_empresa_id FROM depositos WHERE id = p_deposito_origen;
  SELECT empresa_id INTO v_empresa_destino FROM depositos WHERE id = p_deposito_destino;

  IF v_empresa_id IS NULL OR v_empresa_destino IS NULL THEN
    RETURN json_build_object('ok', false, 'tipo', 'deposito_invalido',
      'error', 'Depósito de origen o destino inexistente');
  END IF;

  IF v_empresa_id IS DISTINCT FROM v_empresa_destino THEN
    RETURN json_build_object('ok', false, 'tipo', 'deposito_otra_empresa',
      'error', 'El depósito de destino no pertenece a la misma empresa que el de origen');
  END IF;

  IF auth.role() <> 'service_role' THEN
    v_empresa_sesion := public.get_empresa_id();
    IF v_empresa_sesion IS NULL OR v_empresa_id IS DISTINCT FROM v_empresa_sesion THEN
      RETURN json_build_object('ok', false, 'tipo', 'no_autorizado',
        'error', 'No autorizado');
    END IF;
    IF public.get_rol_usuario() NOT IN ('dueno','admin','depositero') THEN
      RETURN json_build_object('ok', false, 'tipo', 'no_autorizado',
        'error', 'No autorizado: se requiere rol de depósito');
    END IF;
    v_usuario_id := auth.uid();
  ELSE
    v_usuario_id := p_usuario_id;
  END IF;

  SELECT cantidad, costo_promedio
    INTO v_disponible_origen, v_costo_promedio
    FROM stock
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_origen
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'tipo', 'sin_stock_origen',
      'error', 'No existe stock de este producto en el depósito de origen');
  END IF;

  IF v_disponible_origen < p_cantidad THEN
    RETURN json_build_object('ok', false, 'tipo', 'stock_insuficiente',
      'error', 'Stock insuficiente en origen. Disponible: ' || v_disponible_origen::TEXT);
  END IF;

  UPDATE stock
     SET cantidad            = cantidad - p_cantidad,
         updated_at          = NOW()
   WHERE producto_id = p_producto_id
     AND deposito_id = p_deposito_origen;

  INSERT INTO stock (producto_id, deposito_id, cantidad, costo_promedio)
  VALUES (p_producto_id, p_deposito_destino, p_cantidad, COALESCE(v_costo_promedio, 0))
  ON CONFLICT (producto_id, deposito_id) DO UPDATE
    SET cantidad            = stock.cantidad + EXCLUDED.cantidad,
        updated_at          = NOW();

  INSERT INTO movimientos_stock (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES (p_producto_id, p_deposito_origen, 'transferencia', -p_cantidad,
          'Transferencia a depósito ' || p_deposito_destino::TEXT, v_usuario_id, p_notas)
  RETURNING id INTO v_mov_origen_id;

  INSERT INTO movimientos_stock (producto_id, deposito_id, tipo, cantidad, referencia, usuario_id, notas)
  VALUES (p_producto_id, p_deposito_destino, 'transferencia', p_cantidad,
          'Transferencia desde depósito ' || p_deposito_origen::TEXT, v_usuario_id, p_notas)
  RETURNING id INTO v_mov_destino_id;

  v_restante := p_cantidad;

  FOR v_lote IN
    SELECT id, cantidad_disponible, costo_unitario, fecha_vencimiento, numero_lote, fecha_fabricacion
      FROM lotes
     WHERE producto_id = p_producto_id
       AND deposito_id = p_deposito_origen
       AND estado      = 'activo'
       AND cantidad_disponible > 0
     ORDER BY fecha_vencimiento ASC NULLS LAST, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_restante <= 0;

    v_consumir := LEAST(v_lote.cantidad_disponible, v_restante);

    UPDATE lotes
       SET cantidad            = GREATEST(0, cantidad - v_consumir),
           cantidad_disponible = GREATEST(0, cantidad_disponible - v_consumir),
           updated_at          = NOW()
     WHERE id = v_lote.id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_origen_id, v_lote.id, v_consumir, 'consumo');

    INSERT INTO lotes (
      empresa_id, producto_id, deposito_id,
      numero_lote, cantidad, cantidad_disponible,
      costo_unitario, fecha_fabricacion, fecha_vencimiento, estado
    ) VALUES (
      v_empresa_id, p_producto_id, p_deposito_destino,
      COALESCE(v_lote.numero_lote, 'TRANSF-' || TO_CHAR(now(), 'YYYYMMDD')),
      v_consumir, v_consumir,
      v_lote.costo_unitario, v_lote.fecha_fabricacion, v_lote.fecha_vencimiento,
      'activo'
    ) RETURNING id INTO v_lote_destino_id;

    INSERT INTO movimientos_stock_lotes (movimiento_stock_id, lote_id, cantidad, direccion)
    VALUES (v_mov_destino_id, v_lote_destino_id, v_consumir, 'alta');

    v_restante := v_restante - v_consumir;
  END LOOP;

  RETURN json_build_object('ok', true,
    'producto_id', p_producto_id,
    'cantidad', p_cantidad,
    'origen', p_deposito_origen,
    'destino', p_deposito_destino);

EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('ok', false, 'tipo', 'error_interno', 'error', SQLERRM);
END;
$function$;

-- ----------------------------------------------------------------------------
-- BUG-02 (ALTA) — registrar_pago_proveedor
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- SYNC-01 (MEDIA) — setup_inicial_empresa
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.setup_inicial_empresa(
  p_empresa_nombre text,
  p_empresa_cuit text,
  p_empresa_domicilio text DEFAULT NULL::text,
  p_empresa_telefono text DEFAULT NULL::text,
  p_empresa_email text DEFAULT NULL::text,
  p_usuario_id uuid DEFAULT NULL::uuid,
  p_usuario_nombre text DEFAULT NULL::text,
  p_usuario_email text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_empresa_id UUID; v_count INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('setup_inicial_empresa_singleton'));

  SELECT COUNT(*) INTO v_count FROM public.empresas;
  IF v_count > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'El sistema ya fue inicializado. Contactá al administrador.');
  END IF;
  IF p_empresa_nombre IS NULL OR trim(p_empresa_nombre) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El nombre de la empresa es requerido.');
  END IF;
  IF p_empresa_cuit IS NULL OR trim(p_empresa_cuit) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El CUIT es requerido.');
  END IF;
  IF p_usuario_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ID de usuario requerido.');
  END IF;
  IF p_usuario_nombre IS NULL OR trim(p_usuario_nombre) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El nombre del dueño es requerido.');
  END IF;
  IF p_usuario_email IS NULL OR trim(p_usuario_email) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El email del dueño es requerido.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_usuario_id) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'El usuario no existe en el sistema de autenticación.');
  END IF;
  INSERT INTO public.empresas (nombre, cuit, domicilio, telefono, email, activa)
  VALUES (trim(p_empresa_nombre), trim(p_empresa_cuit),
          p_empresa_domicilio, p_empresa_telefono, p_empresa_email, true)
  RETURNING id INTO v_empresa_id;
  INSERT INTO public.usuarios (id, empresa_id, nombre, email, rol, activo)
  VALUES (p_usuario_id, v_empresa_id, trim(p_usuario_nombre),
          trim(p_usuario_email), 'dueno', true);
  INSERT INTO public.depositos (empresa_id, nombre, es_principal)
  VALUES (v_empresa_id, 'Depósito Principal', true);
  INSERT INTO public.listas_precios (empresa_id, nombre, es_default)
  VALUES (v_empresa_id, 'Lista General', true);
  INSERT INTO public.contadores_empresa (empresa_id, tipo, ultimo_numero)
  VALUES (v_empresa_id, 'factura_b', 0),
         (v_empresa_id, 'remito', 0),
         (v_empresa_id, 'presupuesto', 0)
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'empresa_id', v_empresa_id,
    'mensaje', 'Sistema inicializado correctamente.');
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El CUIT ya está registrado.');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Error interno: ' || SQLERRM);
END;
$function$;
