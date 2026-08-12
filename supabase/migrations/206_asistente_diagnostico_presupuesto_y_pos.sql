-- =============================================================
-- 206_asistente_diagnostico_presupuesto_y_pos.sql
-- Amplía el diagnóstico del asistente (ver 205_asistente_diagnostico_pedido.sql)
-- a los otros dos documentos comerciales del sistema: presupuestos y
-- ventas de mostrador (POS). Mismo criterio de seguridad y misma
-- convención de búsqueda por los 6 caracteres finales del ID.
-- =============================================================

-- ── 1. Diagnóstico de un presupuesto ────────────────────────────
-- Cubre: por qué sigue en borrador/enviado, si venció, y el caso
-- puntual de "se aceptó pero no generó el pedido" (el botón "Aceptar
-- y generar pedido" hace las dos cosas en un mismo paso — ver
-- frontend/admin/js/presupuestos.js:265 — así que si algo falla a
-- mitad de camino puede quedar aceptado sin pedido_id).
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
           'id', p.id,
           'referencia_corta', UPPER(RIGHT(p.id::text, 6)),
           'cliente', COALESCE(c.nombre_fantasia, c.razon_social),
           'fecha', p.created_at,
           'total', p.total
         ))
    INTO v_candidatos
  FROM public.presupuestos p
  LEFT JOIN public.clientes c ON c.id = p.cliente_id
  WHERE p.empresa_id = p_empresa_id
    AND (p.id::text = p_referencia OR UPPER(RIGHT(p.id::text, 6)) = v_ref)
  LIMIT 6;

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

  -- Siempre se ejecuta (aunque pedido_id sea NULL), por la misma razón que
  -- en diagnosticar_pedido: un RECORD sin ningún SELECT INTO ejecutado no
  -- se puede leer más adelante.
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

REVOKE ALL ON FUNCTION public.diagnosticar_presupuesto(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diagnosticar_presupuesto(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.diagnosticar_presupuesto IS
  'Tool de diagnóstico del asistente: estado de un presupuesto puntual (envío, vencimiento, conversión a pedido), buscado por UUID completo o por los 6 caracteres finales. Llamada desde lib/asistente-tools.js con la service role key.';

-- ── 2. Diagnóstico de una venta de mostrador (POS) ──────────────
-- Cubre: por qué una venta de mostrador no tiene factura asociada, y si la
-- tiene, el mismo detalle de estado ARCA/AFIP que diagnosticar_pedido.
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
           'id', v.id,
           'referencia_corta', UPPER(RIGHT(v.id::text, 6)),
           'cliente', COALESCE(c.nombre_fantasia, c.razon_social, 'Consumidor final'),
           'fecha', v.created_at,
           'total', v.total
         ))
    INTO v_candidatos
  FROM public.ventas_pos v
  LEFT JOIN public.clientes c ON c.id = v.cliente_id
  WHERE v.empresa_id = p_empresa_id
    AND (v.id::text = p_referencia OR UPPER(RIGHT(v.id::text, 6)) = v_ref)
  LIMIT 6;

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

  -- Siempre se ejecuta (misma razón que en las otras dos funciones: un
  -- RECORD sin SELECT INTO ejecutado ni una vez no se puede leer después).
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

REVOKE ALL ON FUNCTION public.diagnosticar_venta_pos(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diagnosticar_venta_pos(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.diagnosticar_venta_pos IS
  'Tool de diagnóstico del asistente: estado de una venta de mostrador (POS) y su facturación, buscada por UUID completo o por los 6 caracteres finales. Llamada desde lib/asistente-tools.js con la service role key.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '206_asistente_diagnostico_presupuesto_y_pos.sql', '206', 'claude-session',
        'RPCs diagnosticar_presupuesto() y diagnosticar_venta_pos() para el tool calling del asistente.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
