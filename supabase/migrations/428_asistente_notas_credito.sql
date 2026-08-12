-- 428_asistente_notas_credito.sql
-- Tool del asistente: listar_notas_credito
-- Cierra brecha funcional: el asistente ya tiene una tool que EMITE
-- notas de crédito (ver lib/asistente-tools.js, generación automática
-- ligada a facturas), pero no tenía ninguna tool para CONSULTAR el
-- historial de notas de crédito ya emitidas.
--
-- Scope de seguridad: notas_credito tiene empresa_id propio (igual que
-- ordenes_compra/movimientos_caja/conteos_stock/cobros), no hace falta
-- resolver vía join. Cap de 20 filas mostradas; total_notas es el
-- conteo real.
-- Estados válidos (constraint notas_credito_estado_check): pendiente,
-- emitida, aplicada, anulada, error_afip.
-- Tipos válidos (constraint notas_credito_tipo_check): A, B, C, M
-- (letra de comprobante AFIP).
-- clientes no tiene columna 'nombre' (mismo patrón detectado en v527
-- y v530): se resuelve con COALESCE(nombre_fantasia, razon_social).

CREATE OR REPLACE FUNCTION public.listar_notas_credito(
  p_empresa_id UUID,
  p_cliente    TEXT DEFAULT NULL,
  p_estado     TEXT DEFAULT NULL,
  p_dias       INT  DEFAULT 30
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT
      nc.id, nc.tipo, nc.numero, nc.motivo, nc.estado,
      nc.neto, nc.iva, nc.total, nc.fecha_emision, nc.created_at,
      nc.notas_error,
      COALESCE(cl.nombre_fantasia, cl.razon_social) AS cliente_nombre,
      f.numero AS factura_original_numero
    FROM public.notas_credito nc
    JOIN public.clientes cl ON cl.id = nc.cliente_id
    LEFT JOIN public.facturas f ON f.id = nc.factura_id
    WHERE nc.empresa_id = p_empresa_id
      AND nc.created_at >= CURRENT_DATE - GREATEST(p_dias, 0)
      AND (p_cliente IS NULL OR COALESCE(cl.nombre_fantasia, cl.razon_social) ILIKE '%' || p_cliente || '%')
      AND (p_estado IS NULL OR nc.estado = p_estado)
  ), top AS (
    SELECT * FROM filas ORDER BY created_at DESC LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_notas', (SELECT COUNT(*) FROM filas),
    'notas_mostradas', (SELECT COUNT(*) FROM top),
    'monto_total', (SELECT COALESCE(SUM(total), 0) FROM filas),
    'notas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'numero', numero,
        'tipo', tipo,
        'cliente', cliente_nombre,
        'factura_original', factura_original_numero,
        'motivo', motivo,
        'estado', estado,
        'neto', neto,
        'iva', iva,
        'total', total,
        'notas_error', notas_error,
        'fecha_emision', fecha_emision,
        'fecha', created_at
      ) ORDER BY created_at DESC) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── Grants: mismo criterio que el resto del asistente ───────────
REVOKE ALL ON FUNCTION public.listar_notas_credito(UUID, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_notas_credito(UUID, TEXT, TEXT, INT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.listar_notas_credito(UUID, TEXT, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.listar_notas_credito(UUID, TEXT, TEXT, INT) FROM authenticated;

COMMENT ON FUNCTION public.listar_notas_credito IS
  'Tool del asistente: historial de notas de crédito emitidas a clientes en los últimos N días, opcionalmente filtrado por cliente y/o estado (máx. 20 filas mostradas, total_notas es el real). Grants explícitos a anon/authenticated revocados en la misma migración por default privileges del proyecto.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '428_asistente_notas_credito.sql', '428', 'claude-session',
        'Cierra brecha funcional detectada: el asistente ya tiene una tool que emite notas de crédito pero no tenía ninguna para consultar el historial. Agrega RPC listar_notas_credito (scopeada por empresa_id directo, cap 20 filas, monto_total del período, incluye número de factura original vía join a facturas) y su entrada correspondiente en lib/asistente-tools.js. clientes usa COALESCE(nombre_fantasia, razon_social) (mismo patrón de v527/v530). Incluye revoke explícito de anon/authenticated desde el inicio (lección de 423b).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
