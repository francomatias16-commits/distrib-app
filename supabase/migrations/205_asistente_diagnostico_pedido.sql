-- =============================================================
-- 205_asistente_diagnostico_pedido.sql
-- Tool de diagnóstico para el asistente: "¿por qué no facturó
-- tal pedido?", "¿qué pasó con el pedido de tal cliente?".
--
-- Mismo criterio de seguridad que 203_asistente_tools_lectura.sql:
--   - SECURITY DEFINER + SET search_path = public
--   - p_empresa_id siempre lo inyecta el handler desde el perfil ya
--     verificado, nunca sale del texto libre del usuario.
--   - REVOKE de PUBLIC/anon/authenticated, GRANT solo a service_role.
--   - No arma SQL dinámico, no recibe columnas/tablas como parámetro.
--
-- Búsqueda del pedido: acepta el UUID completo o los 6 caracteres
-- finales tal como se muestran en el panel (ej. "#A1B2C3" en la tabla
-- de pedidos → frontend/admin/js/pedidos.js, p.id.slice(-6)). Si hay
-- 0 o 2+ candidatos, devuelve eso explícito (encontrado=false /
-- ambiguo=true) para que el asistente le pida al usuario que aclare,
-- en vez de adivinar cuál pedido es.
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
  -- Match por UUID completo o por los 6 caracteres finales mostrados en el panel.
  SELECT jsonb_agg(jsonb_build_object(
           'id', p.id,
           'referencia_corta', UPPER(RIGHT(p.id::text, 6)),
           'cliente', COALESCE(c.nombre_fantasia, c.razon_social),
           'fecha', p.fecha_pedido,
           'total', p.total
         ))
    INTO v_candidatos
  FROM public.pedidos p
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

  -- Siempre se ejecuta (aunque v_factura.id sea NULL, la condición del WHERE
  -- simplemente no matchea nada): un RECORD que nunca corrió un SELECT INTO,
  -- ni siquiera uno de 0 filas, no se puede leer más adelante en PL/pgSQL
  -- ("record ... is not assigned yet"). Ejecutarla siempre lo deja en un
  -- estado válido (NULL) en vez de "sin asignar".
  SELECT cc.id, cc.monto, cc.fecha INTO v_asiento
  FROM public.cta_cte cc
  WHERE cc.factura_id = v_factura.id
  LIMIT 1;

  -- Resumen en texto plano de "qué está pasando", para que el modelo no
  -- tenga que inferirlo él mismo a partir de los campos sueltos.
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

REVOKE ALL ON FUNCTION public.diagnosticar_pedido(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diagnosticar_pedido(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.diagnosticar_pedido IS
  'Tool de diagnóstico del asistente: estado de un pedido puntual (facturación, asiento en cta_cte) buscado por UUID completo o por los 6 caracteres finales mostrados en el panel. Llamada desde lib/asistente-tools.js con la service role key.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '205_asistente_diagnostico_pedido.sql', '205', 'claude-session',
        'RPC diagnosticar_pedido() para el tool calling del asistente: por qué no facturó un pedido, estado de facturación y cta_cte.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
