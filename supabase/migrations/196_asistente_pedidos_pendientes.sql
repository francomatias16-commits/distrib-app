-- ============================================================================
-- 196_asistente_pedidos_pendientes.sql
--
-- RPC de solo lectura para que el asistente de ayuda (lib/handlers/asistente.js)
-- pueda responder "¿cuántos pedidos pendientes tengo?" con un dato real, sin
-- dejar que el modelo genere SQL libre.
--
-- Definición de "pendiente" (confirmada con el dueño del proyecto): todo
-- pedido que no llegó a 'entregado' ni fue 'cancelado' — incluye 'borrador',
-- 'confirmado', 'preparando', 'despachado' y 'sugerido'.
--
-- Igual patrón de seguridad que obtener_kpis_dashboard_v2 (076): recibe
-- p_empresa_id explícito, SECURITY INVOKER por default (no DEFINER), y solo
-- service_role puede ejecutarla — el handler ya valida el token y arma el
-- empresa_id a partir del perfil autenticado, nunca de un valor que mande
-- el usuario en el body del request.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.contar_pedidos_pendientes(p_empresa_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'total_pendientes', COALESCE(SUM(cant), 0),
    'por_estado', COALESCE(jsonb_object_agg(estado, cant) FILTER (WHERE estado IS NOT NULL), '{}'::jsonb)
  )
  FROM (
    SELECT estado, COUNT(*) AS cant
    FROM pedidos
    WHERE empresa_id = p_empresa_id
      AND estado NOT IN ('entregado', 'cancelado')
    GROUP BY estado
  ) x;
$$;

REVOKE ALL ON FUNCTION public.contar_pedidos_pendientes FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.contar_pedidos_pendientes TO service_role;
