-- =============================================================
-- 208_fix_limit_candidatos_diagnostico.sql
-- Fix de un bug heredado en las 4 tools de diagnóstico del asistente
-- (diagnosticar_pedido 205, diagnosticar_presupuesto/venta_pos 206,
-- diagnosticar_cheque 207).
--
-- Bug: la consulta de "candidatos" (usada para la rama 'ambiguo') tenía
-- la forma:
--
--   SELECT jsonb_agg(jsonb_build_object(...))
--     INTO v_candidatos
--   FROM tabla
--   WHERE ...
--   LIMIT 6;
--
-- jsonb_agg() sin GROUP BY colapsa el resultado a una sola fila de
-- salida, y el LIMIT 6 se aplica DESPUÉS de la agregación sobre esa
-- única fila — no limita cuántas filas de la tabla entran al array.
-- En la práctica esto pasó inadvertido en pedido/presupuesto/venta_pos
-- porque matchean por UUID completo o por sufijo de 6 caracteres
-- (colisiones son estadísticamente raras), pero quedó expuesto al
-- probar diagnosticar_cheque contra datos reales: buscar por un
-- apellido/nombre común devolvió decenas de candidatos en vez de 6.
--
-- Fix: limitar las filas ANTES de agregar, con una subconsulta.
-- =============================================================

CREATE OR REPLACE FUNCTION public.diagnosticar_pedido(
  p_empresa_id  UUID,
  p_referencia  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref        TEXT := UPPER(TRIM(p_referencia));
  v_candidatos JSONB;
  v_count      INT;
  v_pedido     RECORD;
  v_factura    RECORD;
  v_items      INT;
  v_asiento    RECORD;
  v_resumen    TEXT;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'id', sub.id,
           'referencia_corta', sub.referencia_corta,
           'cliente', sub.cliente,
           'fecha', sub.fecha,
           'total', sub.total
         ))
    INTO v_candidatos
  FROM (
    SELECT p.id, UPPER(RIGHT(p.id::text, 6)) AS referencia_corta,
           COALESCE(c.nombre_fantasia, c.razon_social) AS cliente,
           p.fecha_pedido AS fecha, p.total
    FROM public.pedidos p
    LEFT JOIN public.clientes c ON c.id = p.cliente_id
    WHERE p.empresa_id = p_empresa_id
      AND (p.id::text = p_referencia OR UPPER(RIGHT(p.id::text, 6)) = v_ref)
    LIMIT 6
  ) sub;

  v_count := COALESCE(jsonb_array_length(v_candidatos), 0);

  IF v_count = 0 THEN
    RETURN jsonb_build_object('encontrado', false);
  ELSIF v_count > 1 THEN
    RETURN jsonb_build_object('encontrado', false, 'ambiguo', true, 'candidatos', v_candidatos);
  END IF;

  SELECT p.id, p.estado, p.fecha_pedido, p.fecha_entrega, p.total,
         COALESCE(c.nombre_fantasia, c.razon_social) AS cliente
    INTO v_pedido
  FROM public.pedidos p
  LEFT JOIN public.clientes c ON c.id = p.cliente_id
  WHERE p.empresa_id = p_empresa_id
    AND (p.id::text = p_referencia OR UPPER(RIGHT(p.id::text, 6)) = v_ref)
  LIMIT 1;

  SELECT COUNT(*) INTO v_items FROM public.pedido_items WHERE pedido_id = v_pedido.id;

  SELECT f.id, f.estado, f.numero, f.cae, f.notas_error, f.fecha_emision
    INTO v_factura
  FROM public.facturas f
  WHERE f.pedido_id = v_pedido.id
  ORDER BY f.fecha_emision DESC NULLS LAST
  LIMIT 1;

  SELECT cc.id, cc.monto, cc.fecha INTO v_asiento
  FROM public.cta_cte cc
  WHERE cc.factura_id = v_factura.id
  LIMIT 1;

  v_resumen := CASE
    WHEN v_factura.id IS NULL THEN
      'El pedido no tiene ninguna factura generada todavía (nunca se apretó "Facturar" o el pedido no llegó a ese paso).'
    WHEN v_factura.estado = 'error_afip' THEN
      'Se intentó facturar pero ARCA/AFIP rechazó el comprobante. Motivo registrado: ' || COALESCE(v_factura.notas_error, 'sin detalle guardado') || '.'
    WHEN v_factura.estado = 'pendiente' THEN
      'Hay una factura creada pero todavía no se emitió contra ARCA. Motivo registrado: ' || COALESCE(v_factura.notas_error, 'sin detalle guardado') || '.'
    WHEN v_factura.estado = 'emitida' AND v_asiento.id IS NULL THEN
      'La factura se emitió correctamente (CAE ' || COALESCE(v_factura.cae, '—') || ') pero el asiento en la cuenta corriente del cliente no se registró — revisar manualmente.'
    WHEN v_factura.estado = 'emitida' THEN
      'La factura se emitió correctamente (CAE ' || COALESCE(v_factura.cae, '—') || ') y ya está asentada en la cuenta corriente del cliente.'
    WHEN v_factura.estado = 'anulada' THEN
      'La factura de este pedido fue anulada.'
    ELSE 'Estado de facturación no reconocido.'
  END;

  RETURN jsonb_build_object(
    'encontrado', true,
    'pedido_id', v_pedido.id,
    'referencia_corta', UPPER(RIGHT(v_pedido.id::text, 6)),
    'cliente', v_pedido.cliente,
    'estado_pedido', v_pedido.estado,
    'fecha_pedido', v_pedido.fecha_pedido,
    'fecha_entrega', v_pedido.fecha_entrega,
    'total', v_pedido.total,
    'cantidad_items', v_items,
    'tiene_factura', v_factura.id IS NOT NULL,
    'factura_estado', v_factura.estado,
    'factura_numero', v_factura.numero,
    'factura_cae', v_factura.cae,
    'factura_error', v_factura.notas_error,
    'asentado_en_cta_cte', v_asiento.id IS NOT NULL,
    'resumen', v_resumen
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.diagnosticar_presupuesto(
  p_empresa_id  UUID,
  p_referencia  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref        TEXT := UPPER(TRIM(p_referencia));
  v_candidatos JSONB;
  v_count      INT;
  v_pres       RECORD;
  v_pedido     RECORD;
  v_resumen    TEXT;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'id', sub.id,
           'referencia_corta', sub.referencia_corta,
           'cliente', sub.cliente,
           'fecha', sub.fecha,
           'total', sub.total
         ))
    INTO v_candidatos
  FROM (
    SELECT p.id, UPPER(RIGHT(p.id::text, 6)) AS referencia_corta,
           COALESCE(c.nombre_fantasia, c.razon_social) AS cliente,
           p.created_at AS fecha, p.total
    FROM public.presupuestos p
    LEFT JOIN public.clientes c ON c.id = p.cliente_id
    WHERE p.empresa_id = p_empresa_id
      AND (p.id::text = p_referencia OR UPPER(RIGHT(p.id::text, 6)) = v_ref)
    LIMIT 6
  ) sub;

  v_count := COALESCE(jsonb_array_length(v_candidatos), 0);

  IF v_count = 0 THEN
    RETURN jsonb_build_object('encontrado', false);
  ELSIF v_count > 1 THEN
    RETURN jsonb_build_object('encontrado', false, 'ambiguo', true, 'candidatos', v_candidatos);
  END IF;

  SELECT p.id, p.estado, p.total, p.fecha_vencimiento, p.pedido_id, p.created_at,
         COALESCE(c.nombre_fantasia, c.razon_social) AS cliente
    INTO v_pres
  FROM public.presupuestos p
  LEFT JOIN public.clientes c ON c.id = p.cliente_id
  WHERE p.empresa_id = p_empresa_id
    AND (p.id::text = p_referencia OR UPPER(RIGHT(p.id::text, 6)) = v_ref)
  LIMIT 1;

  SELECT pe.id, pe.estado INTO v_pedido
  FROM public.pedidos pe
  WHERE pe.id = v_pres.pedido_id;

  v_resumen := CASE
    WHEN v_pres.estado = 'borrador' THEN
      'Todavía está en borrador: no se envió al cliente.'
    WHEN v_pres.estado = 'enviado' AND v_pres.fecha_vencimiento IS NOT NULL AND v_pres.fecha_vencimiento < CURRENT_DATE THEN
      'Se envió al cliente pero la fecha de vencimiento (' || v_pres.fecha_vencimiento || ') ya pasó sin respuesta.'
    WHEN v_pres.estado = 'enviado' THEN
      'Se envió al cliente y está esperando respuesta (aceptar/rechazar).'
    WHEN v_pres.estado = 'aceptado' AND v_pres.pedido_id IS NULL THEN
      'Quedó marcado como aceptado pero NO se generó el pedido — revisar manualmente, puede haber fallado a mitad del proceso "Aceptar y generar pedido".'
    WHEN v_pres.estado = 'aceptado' AND v_pedido.id IS NOT NULL THEN
      'Se aceptó y generó el pedido #' || UPPER(RIGHT(v_pedido.id::text, 6)) || ' (estado actual del pedido: ' || v_pedido.estado || ').'
    WHEN v_pres.estado = 'rechazado' THEN
      'El cliente lo rechazó.'
    WHEN v_pres.estado = 'vencido' THEN
      'Venció sin respuesta del cliente.'
    ELSE 'Estado no reconocido: ' || COALESCE(v_pres.estado, '(sin estado)')
  END;

  RETURN jsonb_build_object(
    'encontrado', true,
    'presupuesto_id', v_pres.id,
    'referencia_corta', UPPER(RIGHT(v_pres.id::text, 6)),
    'cliente', v_pres.cliente,
    'estado', v_pres.estado,
    'total', v_pres.total,
    'fecha_vencimiento', v_pres.fecha_vencimiento,
    'fecha_creacion', v_pres.created_at,
    'pedido_generado', v_pedido.id IS NOT NULL,
    'pedido_referencia_corta', CASE WHEN v_pedido.id IS NOT NULL THEN UPPER(RIGHT(v_pedido.id::text, 6)) ELSE NULL END,
    'pedido_estado', v_pedido.estado,
    'resumen', v_resumen
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.diagnosticar_venta_pos(
  p_empresa_id  UUID,
  p_referencia  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref        TEXT := UPPER(TRIM(p_referencia));
  v_candidatos JSONB;
  v_count      INT;
  v_venta      RECORD;
  v_factura    RECORD;
  v_resumen    TEXT;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'id', sub.id,
           'referencia_corta', sub.referencia_corta,
           'cliente', sub.cliente,
           'fecha', sub.fecha,
           'total', sub.total
         ))
    INTO v_candidatos
  FROM (
    SELECT v.id, UPPER(RIGHT(v.id::text, 6)) AS referencia_corta,
           COALESCE(c.nombre_fantasia, c.razon_social, 'Consumidor final') AS cliente,
           v.created_at AS fecha, v.total
    FROM public.ventas_pos v
    LEFT JOIN public.clientes c ON c.id = v.cliente_id
    WHERE v.empresa_id = p_empresa_id
      AND (v.id::text = p_referencia OR UPPER(RIGHT(v.id::text, 6)) = v_ref)
    LIMIT 6
  ) sub;

  v_count := COALESCE(jsonb_array_length(v_candidatos), 0);

  IF v_count = 0 THEN
    RETURN jsonb_build_object('encontrado', false);
  ELSIF v_count > 1 THEN
    RETURN jsonb_build_object('encontrado', false, 'ambiguo', true, 'candidatos', v_candidatos);
  END IF;

  SELECT v.id, v.estado, v.total, v.created_at, v.factura_id,
         COALESCE(c.nombre_fantasia, c.razon_social, 'Consumidor final') AS cliente
    INTO v_venta
  FROM public.ventas_pos v
  LEFT JOIN public.clientes c ON c.id = v.cliente_id
  WHERE v.empresa_id = p_empresa_id
    AND (v.id::text = p_referencia OR UPPER(RIGHT(v.id::text, 6)) = v_ref)
  LIMIT 1;

  SELECT f.id, f.estado, f.numero, f.cae, f.notas_error INTO v_factura
  FROM public.facturas f
  WHERE f.id = v_venta.factura_id;

  v_resumen := CASE
    WHEN v_venta.estado = 'anulada' THEN
      'La venta fue anulada.'
    WHEN v_venta.factura_id IS NULL THEN
      'La venta está completa pero no tiene ninguna factura generada (no se facturó esta venta de mostrador, o el pedido no llegó a ese paso).'
    WHEN v_factura.estado = 'error_afip' THEN
      'Se intentó facturar pero ARCA/AFIP rechazó el comprobante. Motivo registrado: ' || COALESCE(v_factura.notas_error, 'sin detalle guardado') || '.'
    WHEN v_factura.estado = 'pendiente' THEN
      'Hay una factura creada pero todavía no se emitió contra ARCA. Motivo registrado: ' || COALESCE(v_factura.notas_error, 'sin detalle guardado') || '.'
    WHEN v_factura.estado = 'emitida' THEN
      'La factura se emitió correctamente (CAE ' || COALESCE(v_factura.cae, '—') || ').'
    WHEN v_factura.estado = 'anulada' THEN
      'La factura de esta venta fue anulada.'
    ELSE 'Estado de facturación no reconocido.'
  END;

  RETURN jsonb_build_object(
    'encontrado', true,
    'venta_id', v_venta.id,
    'referencia_corta', UPPER(RIGHT(v_venta.id::text, 6)),
    'cliente', v_venta.cliente,
    'estado_venta', v_venta.estado,
    'total', v_venta.total,
    'fecha', v_venta.created_at,
    'tiene_factura', v_factura.id IS NOT NULL,
    'factura_estado', v_factura.estado,
    'factura_numero', v_factura.numero,
    'factura_cae', v_factura.cae,
    'factura_error', v_factura.notas_error,
    'resumen', v_resumen
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.diagnosticar_cheque(
  p_empresa_id      UUID,
  p_cliente_nombre  TEXT,
  p_numero          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidatos JSONB;
  v_count      INT;
  v_cheque     RECORD;
  v_resumen    TEXT;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'id', sub.id,
           'cliente', sub.cliente,
           'banco', sub.banco,
           'numero', sub.numero,
           'monto', sub.monto,
           'vencimiento', sub.vencimiento,
           'estado', sub.estado
         ))
    INTO v_candidatos
  FROM (
    SELECT ch.id, COALESCE(c.nombre_fantasia, c.razon_social) AS cliente,
           ch.banco, ch.numero, ch.monto,
           COALESCE(ch.vencimiento, ch.fecha_vto) AS vencimiento, ch.estado
    FROM public.cheques ch
    LEFT JOIN public.clientes c ON c.id = ch.cliente_id
    WHERE ch.empresa_id = p_empresa_id
      AND (c.razon_social ILIKE '%' || p_cliente_nombre || '%' OR c.nombre_fantasia ILIKE '%' || p_cliente_nombre || '%')
      AND (p_numero IS NULL OR ch.numero = p_numero)
    LIMIT 6
  ) sub;

  v_count := COALESCE(jsonb_array_length(v_candidatos), 0);

  IF v_count = 0 THEN
    RETURN jsonb_build_object('encontrado', false);
  ELSIF v_count > 1 THEN
    RETURN jsonb_build_object('encontrado', false, 'ambiguo', true, 'candidatos', v_candidatos);
  END IF;

  SELECT ch.id, ch.banco, ch.numero, ch.monto, COALESCE(ch.vencimiento, ch.fecha_vto) AS vencimiento, ch.estado, ch.notas, ch.cobro_id,
         COALESCE(c.nombre_fantasia, c.razon_social) AS cliente
    INTO v_cheque
  FROM public.cheques ch
  LEFT JOIN public.clientes c ON c.id = ch.cliente_id
  WHERE ch.empresa_id = p_empresa_id
    AND (c.razon_social ILIKE '%' || p_cliente_nombre || '%' OR c.nombre_fantasia ILIKE '%' || p_cliente_nombre || '%')
    AND (p_numero IS NULL OR ch.numero = p_numero)
  LIMIT 1;

  v_resumen := CASE
    WHEN v_cheque.estado = 'pendiente' THEN
      'Está pendiente de registrarse en cartera (recién recibido, todavía no confirmado).'
    WHEN v_cheque.estado = 'en_cartera' AND v_cheque.vencimiento IS NOT NULL AND v_cheque.vencimiento < CURRENT_DATE THEN
      'Está en cartera y la fecha de vencimiento (' || v_cheque.vencimiento || ') ya pasó sin depositarse ni cobrarse — revisar.'
    WHEN v_cheque.estado = 'en_cartera' THEN
      'Está en cartera, todavía no se depositó (vence el ' || v_cheque.vencimiento || ').'
    WHEN v_cheque.estado = 'depositado' THEN
      'Fue depositado en el banco y está pendiente de acreditación definitiva.'
    WHEN v_cheque.estado = 'cobrado' THEN
      'Se cobró/acreditó correctamente.' ||
        CASE WHEN v_cheque.cobro_id IS NOT NULL THEN ' Quedó asentado en un cobro.' ELSE '' END
    WHEN v_cheque.estado = 'rechazado' THEN
      'El banco lo rechazó.' || CASE WHEN v_cheque.notas IS NOT NULL AND v_cheque.notas <> '' THEN ' Nota registrada: ' || v_cheque.notas || '.' ELSE ' No hay notas adicionales cargadas sobre el motivo.' END
    WHEN v_cheque.estado = 'entregado_proveedor' THEN
      'Fue entregado/endosado a un proveedor como forma de pago; ya no está en la cartera de la empresa.'
    WHEN v_cheque.estado = 'anulado' THEN
      'Fue anulado.'
    ELSE 'Estado no reconocido: ' || COALESCE(v_cheque.estado, '(sin estado)')
  END;

  RETURN jsonb_build_object(
    'encontrado', true,
    'cheque_id', v_cheque.id,
    'cliente', v_cheque.cliente,
    'banco', v_cheque.banco,
    'numero', v_cheque.numero,
    'monto', v_cheque.monto,
    'vencimiento', v_cheque.vencimiento,
    'estado', v_cheque.estado,
    'notas', v_cheque.notas,
    'tiene_cobro_asociado', v_cheque.cobro_id IS NOT NULL,
    'resumen', v_resumen
  );
END;
$$;

-- Los permisos (REVOKE/GRANT) y comentarios ya están aplicados por las
-- migraciones 205/206/207 y no se ven afectados por CREATE OR REPLACE.

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '208_fix_limit_candidatos_diagnostico.sql', '208', 'claude-session',
        'Fix de bug heredado: LIMIT aplicado después de jsonb_agg() no limitaba filas antes de agregar. Corregido en diagnosticar_pedido, diagnosticar_presupuesto, diagnosticar_venta_pos y diagnosticar_cheque con subconsulta LIMIT. Detectado al probar diagnosticar_cheque contra datos reales (match por nombre devolvía decenas de candidatos en vez de 6).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
