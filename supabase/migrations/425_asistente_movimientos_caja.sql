-- 425_asistente_movimientos_caja.sql
-- Tool del asistente: listar_movimientos_caja
-- Cierra brecha funcional: movimientos_caja registra sangrías, refuerzos
-- y retiros finales de caja (POS), pero el asistente no tenía tool para
-- consultarla.
--
-- Scope de seguridad: movimientos_caja tiene empresa_id propio (igual
-- que ordenes_compra), no hace falta resolver vía join a turnos_caja.
-- Cap de 20 filas mostradas; total_movimientos es el conteo real.
-- Tipos válidos (constraint movimientos_caja_tipo_check): sangria,
-- refuerzo, retiro_final.

CREATE OR REPLACE FUNCTION public.listar_movimientos_caja(
  p_empresa_id UUID,
  p_tipo       TEXT DEFAULT NULL,
  p_usuario    TEXT DEFAULT NULL,
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
      mc.id, mc.tipo, mc.monto, mc.concepto, mc.created_at,
      mc.turno_id,
      u.nombre AS usuario_nombre
    FROM public.movimientos_caja mc
    LEFT JOIN public.usuarios u ON u.id = mc.usuario_id
    WHERE mc.empresa_id = p_empresa_id
      AND mc.created_at >= CURRENT_DATE - GREATEST(p_dias, 0)
      AND (p_tipo IS NULL OR mc.tipo = p_tipo)
      AND (p_usuario IS NULL OR u.nombre ILIKE '%' || p_usuario || '%')
  ), top AS (
    SELECT * FROM filas ORDER BY created_at DESC LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_movimientos', (SELECT COUNT(*) FROM filas),
    'movimientos_mostrados', (SELECT COUNT(*) FROM top),
    'total_sangrias', (SELECT COALESCE(SUM(monto), 0) FROM filas WHERE tipo = 'sangria'),
    'total_refuerzos', (SELECT COALESCE(SUM(monto), 0) FROM filas WHERE tipo = 'refuerzo'),
    'total_retiros_finales', (SELECT COALESCE(SUM(monto), 0) FROM filas WHERE tipo = 'retiro_final'),
    'movimientos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'tipo', tipo,
        'monto', monto,
        'concepto', concepto,
        'usuario', usuario_nombre,
        'turno_id', turno_id,
        'fecha', created_at
      ) ORDER BY created_at DESC) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── Grants: mismo criterio que el resto del asistente ───────────
REVOKE ALL ON FUNCTION public.listar_movimientos_caja(UUID, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_movimientos_caja(UUID, TEXT, TEXT, INT) TO service_role;

-- Fix de grants por default privileges (mismo problema que motivó 423b):
-- este proyecto auto-otorga EXECUTE a anon/authenticated en funciones
-- nuevas de public. Se revoca explícito en la misma migración esta vez.
REVOKE EXECUTE ON FUNCTION public.listar_movimientos_caja(UUID, TEXT, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.listar_movimientos_caja(UUID, TEXT, TEXT, INT) FROM authenticated;

COMMENT ON FUNCTION public.listar_movimientos_caja IS
  'Tool del asistente: historial de movimientos de caja (sangrías, refuerzos, retiros finales) en los últimos N días, opcionalmente filtrado por tipo y/o usuario (máx. 20 filas mostradas, total_movimientos es el real). Grants explícitos a anon/authenticated revocados en la misma migración por default privileges del proyecto.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '425_asistente_movimientos_caja.sql', '425', 'claude-session',
        'Cierra brecha funcional detectada: movimientos_caja (sangrías/refuerzos/retiros_final de POS) se usa en el sistema pero el asistente no tenía tool para consultarla. Agrega RPC listar_movimientos_caja (scopeada por empresa_id directo, cap 20 filas, totales por tipo) y su entrada correspondiente en lib/asistente-tools.js. Incluye revoke explícito de anon/authenticated desde el inicio (lección de 423b).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
