-- 426_asistente_conteos_stock.sql
-- Tool del asistente: listar_conteos_stock
-- Cierra brecha funcional: conteos_stock registra conteos físicos de
-- inventario (cantidad_sistema vs cantidad_contada, con diferencia y
-- motivo), pero el asistente no tenía tool para consultarla.
--
-- Scope de seguridad: conteos_stock tiene empresa_id propio (igual que
-- ordenes_compra y movimientos_caja), no hace falta resolver vía join.
-- Cap de 20 filas mostradas; total_conteos es el conteo real.
-- No hay CHECK constraint sobre motivo (texto libre).

CREATE OR REPLACE FUNCTION public.listar_conteos_stock(
  p_empresa_id     UUID,
  p_producto       TEXT DEFAULT NULL,
  p_solo_con_dif   BOOLEAN DEFAULT FALSE,
  p_dias           INT  DEFAULT 30
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filas AS (
    SELECT
      cs.id, cs.cantidad_sistema, cs.cantidad_contada, cs.diferencia,
      cs.motivo, cs.notas, cs.created_at,
      p.nombre AS producto_nombre, p.codigo AS producto_codigo,
      d.nombre AS deposito_nombre,
      u.nombre AS usuario_nombre
    FROM public.conteos_stock cs
    JOIN public.productos p ON p.id = cs.producto_id
    JOIN public.depositos d ON d.id = cs.deposito_id
    LEFT JOIN public.usuarios u ON u.id = cs.usuario_id
    WHERE cs.empresa_id = p_empresa_id
      AND cs.created_at >= CURRENT_DATE - GREATEST(p_dias, 0)
      AND (p_producto IS NULL OR p.nombre ILIKE '%' || p_producto || '%')
      AND (p_solo_con_dif IS NOT TRUE OR cs.diferencia <> 0)
  ), top AS (
    SELECT * FROM filas ORDER BY created_at DESC LIMIT 20
  )
  SELECT jsonb_build_object(
    'dias', p_dias,
    'total_conteos', (SELECT COUNT(*) FROM filas),
    'conteos_mostrados', (SELECT COUNT(*) FROM top),
    'total_con_diferencia', (SELECT COUNT(*) FROM filas WHERE diferencia <> 0),
    'suma_diferencias', (SELECT COALESCE(SUM(diferencia), 0) FROM filas),
    'conteos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'producto', producto_nombre,
        'codigo', producto_codigo,
        'deposito', deposito_nombre,
        'cantidad_sistema', cantidad_sistema,
        'cantidad_contada', cantidad_contada,
        'diferencia', diferencia,
        'motivo', motivo,
        'notas', notas,
        'usuario', usuario_nombre,
        'fecha', created_at
      ) ORDER BY created_at DESC) FROM top
    ), '[]'::jsonb)
  );
$$;

-- ── Grants: mismo criterio que el resto del asistente ───────────
REVOKE ALL ON FUNCTION public.listar_conteos_stock(UUID, TEXT, BOOLEAN, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listar_conteos_stock(UUID, TEXT, BOOLEAN, INT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.listar_conteos_stock(UUID, TEXT, BOOLEAN, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.listar_conteos_stock(UUID, TEXT, BOOLEAN, INT) FROM authenticated;

COMMENT ON FUNCTION public.listar_conteos_stock IS
  'Tool del asistente: historial de conteos físicos de inventario (cantidad de sistema vs contada, diferencia y motivo) en los últimos N días, opcionalmente filtrado por producto y/o solo con diferencia (máx. 20 filas mostradas, total_conteos es el real). Grants explícitos a anon/authenticated revocados en la misma migración por default privileges del proyecto.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '426_asistente_conteos_stock.sql', '426', 'claude-session',
        'Cierra brecha funcional detectada: conteos_stock (conteos físicos de inventario, cantidad_sistema vs cantidad_contada) se usa en el sistema pero el asistente no tenía tool para consultarla. Agrega RPC listar_conteos_stock (scopeada por empresa_id directo, cap 20 filas, filtro solo_con_dif y suma de diferencias) y su entrada correspondiente en lib/asistente-tools.js. Incluye revoke explícito de anon/authenticated desde el inicio (lección de 423b).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
