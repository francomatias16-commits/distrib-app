-- ─────────────────────────────────────────────────────────────────────────
-- 268_rpc_cobranzas_kpis_y_facturas_server_side.sql
-- AUDITORIA_FILTROS_v280, sección 5 (mediano plazo) — módulo Cobranzas
-- (pestaña "¿A quién llamo hoy?" de /admin/cobranzas, cobranzas.js).
--
-- No confundir con cta-cte.js / fn_cta_cte_* (migración 266/267) — esa es
-- la pestaña "Saldos por cliente" de la misma pantalla, ya resuelta.
--
-- Problema: cargarDatos() traía TODAS las facturas en estado
-- ('emitida','parcial') con un .limit(500) "tope de seguridad" y
-- después las repartía en 3 baldes (hoy/semana/vencidas) con
-- Array.filter() en JS, sin paginación en ninguno de los 3 tabs. Si un
-- tenant supera las 500 facturas abiertas, los KPIs "Vence hoy" y
-- "Total vencido" empiezan a subcontar — mismo tipo de bug que el
-- .limit(200) ya corregido en Pedidos (migración 257).
--
-- La pestaña "Priorizada" NO se toca: sigue usando /api/score (score de
-- cobrabilidad, lógica propia fuera de este alcance).
--
-- Se agregan:
--   fn_cobranzas_kpis()       -> deuda + conteo de facturas de los 3
--                                 baldes (hoy / próximos 7 días / vencidas),
--                                 agregados en SQL, sin tope arbitrario.
--   fn_cobranzas_facturas()   -> página de un balde puntual (p_bucket),
--                                 con LIMIT/OFFSET real y total_count vía
--                                 COUNT(*) OVER().
--
-- Misma lógica de deuda que fn_cta_cte_kpis/resumen_cta_cte:
-- GREATEST(total - total_cobrado, 0) sobre facturas en estado
-- ('emitida','parcial'). Buckets por fecha de vencimiento:
--   hoy      -> vencimiento = CURRENT_DATE
--   semana   -> vencimiento > CURRENT_DATE AND <= CURRENT_DATE + 7 días
--   vencidas -> vencimiento < CURRENT_DATE
-- (mismo criterio que usaba el filtro en JS: facturasSemana excluía hoy).

-- ============================================================
-- fn_cobranzas_kpis: deuda + conteo de los 3 baldes, en una sola fila
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_cobranzas_kpis()
RETURNS TABLE (
    pendiente_hoy      numeric,
    facturas_hoy        bigint,
    pendiente_semana   numeric,
    facturas_semana     bigint,
    total_vencido      numeric,
    facturas_vencidas   bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0))
                  FILTER (WHERE f.vencimiento = CURRENT_DATE), 0),
        COUNT(*) FILTER (WHERE f.vencimiento = CURRENT_DATE),
        COALESCE(SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0))
                  FILTER (WHERE f.vencimiento > CURRENT_DATE AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days'), 0),
        COUNT(*) FILTER (WHERE f.vencimiento > CURRENT_DATE AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days'),
        COALESCE(SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0))
                  FILTER (WHERE f.vencimiento < CURRENT_DATE), 0),
        COUNT(*) FILTER (WHERE f.vencimiento < CURRENT_DATE)
    FROM facturas f
    WHERE f.empresa_id = v_empresa_id
      AND f.estado IN ('emitida', 'parcial')
      AND GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0;
END;
$function$;

-- ============================================================
-- fn_cobranzas_facturas: página de un balde (hoy/semana/vencidas)
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_cobranzas_facturas(
    p_bucket text,            -- 'hoy' | 'semana' | 'vencidas'
    p_limit  integer DEFAULT 50,
    p_offset integer DEFAULT 0
)
RETURNS TABLE (
    id                uuid,
    numero            text,
    total             numeric,
    total_cobrado     numeric,
    pendiente         numeric,
    vencimiento       date,
    cliente_id        uuid,
    cliente_nombre    text,
    total_count       bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
    RETURN QUERY
    SELECT
        f.id, f.numero, f.total, f.total_cobrado,
        GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) AS pendiente,
        f.vencimiento, f.cliente_id,
        COALESCE(c.nombre_fantasia, c.razon_social) AS cliente_nombre,
        COUNT(*) OVER() AS total_count
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    WHERE f.empresa_id = v_empresa_id
      AND f.estado IN ('emitida', 'parcial')
      AND GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0
      AND (
            (p_bucket = 'hoy'      AND f.vencimiento = CURRENT_DATE)
         OR (p_bucket = 'semana'   AND f.vencimiento > CURRENT_DATE AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days')
         OR (p_bucket = 'vencidas' AND f.vencimiento < CURRENT_DATE)
          )
    ORDER BY f.vencimiento ASC
    LIMIT p_limit OFFSET p_offset;
END;
$function$;

-- ============================================================
-- Grants — sin PUBLIC/anon desde el vamos (lección de la 267)
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.fn_cobranzas_kpis() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_cobranzas_facturas(text, integer, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_cobranzas_kpis() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cobranzas_facturas(text, integer, integer) TO authenticated, service_role;
