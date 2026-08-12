-- =============================================================
-- 207_asistente_diagnostico_cheque.sql
-- Cierra el flujo de diagnóstico de cheques que había quedado abierto
-- en la sesión anterior (ver notas en 203_asistente_tools_lectura.sql:
-- listar_cheques_alerta ya cubre "qué cheques están en riesgo", pero
-- faltaba el diagnóstico de UN cheque puntual).
--
-- A diferencia de pedido/presupuesto/venta_pos, un cheque no tiene un
-- ID corto visible en la UI (ver frontend/admin/js/cheques.js), así
-- que la búsqueda es por nombre de cliente + número de cheque opcional
-- para desambiguar, con el mismo patrón de "ambiguo" que el resto.
--
-- No cubre verificación BCRA (eso es una llamada externa a la API del
-- Banco Central vía /api/bcra + lib/handlers/bcra.js, no es un dato
-- de la base y no puede resolverse desde una RPC SECURITY DEFINER).
-- Cubre los 7 estados reales del constraint cheques_estado_check
-- (077_critical_rls_y_politicas.sql): pendiente, en_cartera, cobrado,
-- depositado, rechazado, entregado_proveedor, anulado.
--
-- Nota de datos: la tabla tiene DOS columnas de fecha (fecha_vto,
-- la original de 001_schema.sql, y vencimiento, la que usa el
-- frontend actual en cheques.js). En producción hay cheques donde
-- difieren y 3 casos con vencimiento NULL pero fecha_vto cargado —
-- se usa COALESCE(vencimiento, fecha_vto) para no perder datos
-- reales, mostrando siempre lo que el frontend mostraría o, si no
-- hay, el dato legacy.

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
           'id', ch.id,
           'cliente', COALESCE(c.nombre_fantasia, c.razon_social),
           'banco', ch.banco,
           'numero', ch.numero,
           'monto', ch.monto,
           'vencimiento', COALESCE(ch.vencimiento, ch.fecha_vto),
           'estado', ch.estado
         ))
    INTO v_candidatos
  FROM public.cheques ch
  LEFT JOIN public.clientes c ON c.id = ch.cliente_id
  WHERE ch.empresa_id = p_empresa_id
    AND (c.razon_social ILIKE '%' || p_cliente_nombre || '%' OR c.nombre_fantasia ILIKE '%' || p_cliente_nombre || '%')
    AND (p_numero IS NULL OR ch.numero = p_numero)
  LIMIT 6;

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

REVOKE ALL ON FUNCTION public.diagnosticar_cheque(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.diagnosticar_cheque(UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.diagnosticar_cheque IS
  'Tool de diagnóstico del asistente: estado de un cheque puntual de un cliente (en cartera, depositado, cobrado, rechazado, endosado a proveedor o anulado), buscado por nombre de cliente y opcionalmente número de cheque para desambiguar. Llamada desde lib/asistente-tools.js con la service role key. No incluye verificación BCRA (dato externo, ver /api/bcra).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '207_asistente_diagnostico_cheque.sql', '207', 'claude-session',
        'RPC diagnosticar_cheque() para el tool calling del asistente: cierra la paridad con diagnosticar_pedido/presupuesto/venta_pos, cubriendo los 7 estados del constraint cheques_estado_check.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
