-- 423_asistente_movimientos_stock.sql
-- Tool del asistente: listar_movimientos_stock
-- Cierra brecha funcional: movimientos_stock (kardex de ingresos/egresos/
-- ajustes/transferencias/reservas/liberaciones) existía y se usaba en
-- varios handlers del sistema, pero el asistente no tenía ninguna tool
-- para consultarla.
--
-- Scope de seguridad: la tabla movimientos_stock no tiene empresa_id
-- propio, se resuelve vía deposito_id -> depositos.empresa_id.
-- Cap de 20 filas mostradas; total_movimientos es el conteo real.
--
-- NOTA: aplicada en producción (proyecto jgiquzjwoedmzwqgzubr) el
-- 2026-07-31. Ver también 423b para el fix de grants por default
-- privileges (anon/authenticated).

CREATE OR REPLACE FUNCTION public.listar_movimientos_stock(
  p_empresa_id UUID,
  p_producto   TEXT DEFAULT NULL,
  p_tipo       TEXT DEFAULT NULL,
  p_dias       INT  DEFAULT 7
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT
      m.id, m.tipo, m.cantidad, m.referencia, m.notas, m.created_at,
      pr.nombre  AS producto_nombre,
      d.nombre   AS deposito_nombre,
      u.nombre   AS usuario_nombre
    FROM public.movimientos_stock m
    JOIN public.depositos d ON d.id = m.deposito_id
    LEFT JOIN public.productos pr ON pr.id = m.producto_id
    LEFT JOIN public.usuarios  u  ON u.id = m.usuario_id
    WHERE d.empresa_id = p_empresa_id
      AND m.created_at >= CURRENT_DATE - GREATEST(p_dias, 0)
      AND (p_producto IS NULL OR pr.nombre ILIKE '%' || p_producto || '%')
      AND (p_tipo IS NULL OR m.tipo::TEXT = p_tipo)
  ), top AS (
    SELECT * FROM filas ORDER BY created_at DESC LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_movimientos', (SELECT COUNT(*) FROM filas),
    'movimientos_mostrados', (SELECT COUNT(*) FROM top),
    'movimientos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'producto', producto_nombre,
        'deposito', deposito_nombre,
        'tipo', tipo,
        'cantidad', cantidad,
        'referencia', referencia,
        'notas', notas,
        'usuario', usuario_nombre,
        'fecha', created_at
      ) ORDER BY created_at DESC) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── Grants: mismo criterio que el resto del asistente ───────────
REVOKE ALL ON FUNCTION public.listar_movimientos_stock(UUID, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_movimientos_stock(UUID, TEXT, TEXT, INT) TO service_role;

COMMENT ON FUNCTION public.listar_movimientos_stock IS
  'Tool del asistente: historial de movimientos de stock (ingresos/egresos/ajustes/transferencias) en los últimos N días, opcionalmente filtrado por producto y/o tipo (máx. 20 filas mostradas, total_movimientos es el real).';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '423_asistente_movimientos_stock.sql', '423', 'claude-session',
        'Cierra brecha funcional detectada: movimientos_stock existía y se usaba en varios handlers pero el asistente no tenía tool para consultarla. Agrega RPC listar_movimientos_stock (scopeada vía deposito_id->empresa_id, cap 20 filas) y su entrada correspondiente en lib/asistente-tools.js.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
