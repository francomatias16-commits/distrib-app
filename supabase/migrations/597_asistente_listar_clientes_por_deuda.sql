-- =============================================================
-- 597_asistente_listar_clientes_por_deuda.sql
--
-- Motivo: el asistente respondía "No tengo una forma de consultar eso
-- todavía" ante preguntas como "¿cuántos clientes tienen más de $150.000
-- en deuda?". No es un bug del selector de tools (lib/asistente-tools/
-- index.js elige bien entre las 98 tools existentes) — es que ninguna
-- tool de clientes hacía una consulta AGREGADA sobre saldo_deuda: la
-- única existente, consultar_bloqueo_cliente, busca UN cliente puntual
-- por nombre y devuelve su deuda individual. No había forma de
-- filtrar/contar/sumar sobre TODOS los clientes de la empresa a la vez.
--
-- Esta migración agrega esa pieza: una RPC de solo lectura, mismo
-- patrón que listar_cheques_alerta/listar_lotes_por_vencer (203), que
-- cuenta y suma TODOS los clientes con saldo_deuda >= p_monto_minimo
-- (no solo los que se muestran) y devuelve hasta 20 filas ordenadas de
-- mayor a menor deuda.
-- =============================================================

CREATE OR REPLACE FUNCTION public.listar_clientes_por_deuda(
  p_empresa_id    UUID,
  p_monto_minimo  NUMERIC DEFAULT 0,
  p_solo_activos  BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT
      c.id,
      COALESCE(c.nombre_fantasia, c.razon_social) AS nombre,
      c.saldo_deuda,
      c.limite_credito,
      c.bloqueado,
      c.activo
    FROM public.clientes c
    WHERE c.empresa_id = p_empresa_id
      AND c.saldo_deuda >= GREATEST(p_monto_minimo, 0)
      AND (NOT p_solo_activos OR c.activo)
  ), top AS (
    SELECT * FROM filas ORDER BY saldo_deuda DESC LIMIT 20
  )
  SELECT jsonb_build_object(
    'monto_minimo', p_monto_minimo,
    'total_clientes', (SELECT COUNT(*) FROM filas),
    'clientes_mostrados', (SELECT COUNT(*) FROM top),
    'deuda_total_acumulada', (SELECT COALESCE(SUM(saldo_deuda), 0) FROM filas),
    'clientes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'cliente', nombre,
        'deuda', saldo_deuda,
        'limite_credito', limite_credito,
        'bloqueado', bloqueado,
        'activo', activo
      ) ORDER BY saldo_deuda DESC) FROM top
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.listar_clientes_por_deuda(UUID, NUMERIC, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_clientes_por_deuda(UUID, NUMERIC, BOOLEAN) TO service_role;

COMMENT ON FUNCTION public.listar_clientes_por_deuda IS
  'Tool del asistente: clientes con deuda (saldo_deuda) mayor o igual a un monto dado, scopeada por empresa. total_clientes y deuda_total_acumulada son sobre TODOS los que matchean, no solo los 20 mostrados.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '597_asistente_listar_clientes_por_deuda.sql', '597', 'claude-session',
        'Nueva tool de solo lectura para el asistente: listar_clientes_por_deuda. Cubre consultas agregadas de deuda de clientes ("cuántos clientes deben más de $X", "quiénes son los que más deben") que antes ninguna tool resolvía porque consultar_bloqueo_cliente solo busca UN cliente por nombre.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
