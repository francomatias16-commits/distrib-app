-- ============================================================================
-- 494_fn_reportes_stock_valorizacion.sql
--
-- Etapa 6 (auditoría funcional, v775) — cierre del pendiente real de
-- reportes-stock.js: cargarValorizacion() traía TODA la tabla `stock` de la
-- empresa (sin .range() ni límite) más TODOS los `depositos`, solo para
-- agrupar y sumar en JS — el mismo cuello de botella que ya se había
-- identificado y corregido para "Estado de Stock" y "Productos Críticos" en
-- este mismo archivo, pero que había quedado afuera de esa pasada.
--
-- fn_reportes_stock_valorizacion agrupa y suma en SQL, igual patrón que
-- fn_reportes_stock_distribucion (200) y fn_reportes_stock_kpis (441).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_reportes_stock_valorizacion()
RETURNS TABLE (
  deposito_id uuid,
  deposito_nombre text,
  cantidad_productos bigint,
  unidades numeric,
  costo_total numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  SELECT
    d.id                                    AS deposito_id,
    COALESCE(d.nombre, 'Sin nombre')        AS deposito_nombre,
    COUNT(*)                                AS cantidad_productos,
    COALESCE(SUM(s.cantidad), 0)            AS unidades,
    COALESCE(SUM(s.cantidad * s.costo_promedio), 0) AS costo_total
  FROM public.stock s
  JOIN public.depositos d ON d.id = s.deposito_id
  WHERE d.empresa_id = v_empresa_id
  GROUP BY d.id, d.nombre
  ORDER BY costo_total DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_reportes_stock_valorizacion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_reportes_stock_valorizacion() TO authenticated, service_role;

-- Registro en la tabla de tracking de migraciones del proyecto
INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '494_fn_reportes_stock_valorizacion.sql',
  '494',
  'claude_assistant',
  'Etapa 6 (v775): fn_reportes_stock_valorizacion agrupa y suma en SQL por depósito, reemplazando el fetch client-side de TODA la tabla stock que hacía cargarValorizacion() en reportes-stock.js.'
)
ON CONFLICT DO NOTHING;
