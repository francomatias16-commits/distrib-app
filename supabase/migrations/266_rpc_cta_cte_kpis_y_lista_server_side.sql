-- 266_rpc_cta_cte_kpis_y_lista_server_side.sql
-- AUDITORIA_FILTROS_v280, seguimiento sobre cta-cte.js / cobranzas.html
-- (pestaña "Saldos por cliente").
--
-- NOTA IMPORTANTE: el borrador original de esta migración (mismo número
-- 266) asumía que resumen_cta_cte() tenía un bug de aislamiento
-- multi-tenant, basado en el archivo supabase/migrations/007_finanzas_fix.sql
-- del zip entregado para la auditoría. Al conectar contra el proyecto real
-- (jgiquzjwoedmzwqgzubr) se confirmó que:
--   a) esa migración 007 no existe en el historial real del proyecto
--      (supabase_migrations.schema_migrations no tiene nada numerado
--      001-109 con esos nombres);
--   b) la función resumen_cta_cte() real (aplicada como 109_rpc_resumen_cta_cte,
--      2026-06-25) SÍ filtra correctamente por empresa_id y usa
--      facturas+clientes directo, no clientes+cta_cte+cobros como asumía
--      el zip.
-- Conclusión: no hay bug de seguridad en producción. El zip auditado tenía
-- una carpeta supabase/migrations/ desincronizada de la base real para el
-- rango 001-109 (la cola 255-265 sí está sincronizada). Esta migración NO
-- toca resumen_cta_cte() — queda como está, correcta — y agrega las dos
-- funciones de performance sobre el esquema real verificado por
-- information_schema.columns.
--
-- ── Performance (mismo criterio que 262_rpc_facturas_lista_server_side) ──
-- cta-cte.js traía el listado completo de deudores (vía resumen_cta_cte,
-- sin paginar) y sumaba los 4 KPIs en JS sobre ese array completo. Se
-- agregan:
--
--   fn_cta_cte_kpis()   -> los 4 totales + conteos, agregados en SQL
--                          (una sola fila, no una fila por cliente).
--   fn_cta_cte_lista()  -> página filtrada (búsqueda, estado) con
--                          LIMIT/OFFSET real y total_count via
--                          COUNT(*) OVER(). Incluye ultimo_pago (tabla
--                          cobros, confirmada en el esquema real con las
--                          mismas columnas: empresa_id, cliente_id, fecha).
--
-- Misma lógica de deuda que resumen_cta_cte(): GREATEST(total - total_cobrado, 0)
-- sobre facturas en estado ('emitida','parcial'), vencida si vencimiento <
-- hoy, por vencer si vencimiento está entre hoy y +7 días.

-- ============================================================
-- fn_cta_cte_kpis: los 4 totales de las tarjetas, en una sola fila
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_cta_cte_kpis()
RETURNS TABLE (
    deuda_total         numeric,
    deuda_vencida       numeric,
    deuda_por_vencer    numeric,
    deuda_al_dia        numeric,
    clientes_total      bigint,
    clientes_vencido    bigint,
    clientes_por_vencer bigint,
    clientes_al_dia     bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
    RETURN QUERY
    WITH por_cliente AS (
        SELECT
            f.cliente_id,
            SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)) AS deuda_total,
            SUM(CASE
                  WHEN f.vencimiento IS NOT NULL AND f.vencimiento < CURRENT_DATE
                  THEN GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)
                  ELSE 0
                END) AS deuda_vencida,
            SUM(CASE
                  WHEN f.vencimiento IS NOT NULL
                   AND f.vencimiento >= CURRENT_DATE
                   AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days'
                  THEN GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)
                  ELSE 0
                END) AS deuda_por_vencer
        FROM facturas f
        WHERE f.empresa_id = v_empresa_id
          AND f.estado IN ('emitida', 'parcial')
          AND GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0
        GROUP BY f.cliente_id
    )
    SELECT
        COALESCE(SUM(p.deuda_total), 0),
        COALESCE(SUM(p.deuda_vencida), 0),
        COALESCE(SUM(p.deuda_por_vencer), 0),
        COALESCE(SUM(p.deuda_total) - SUM(p.deuda_vencida) - SUM(p.deuda_por_vencer), 0),
        COUNT(*),
        COUNT(*) FILTER (WHERE p.deuda_vencida > 0),
        COUNT(*) FILTER (WHERE p.deuda_vencida = 0 AND p.deuda_por_vencer > 0),
        COUNT(*) FILTER (WHERE p.deuda_vencida = 0 AND p.deuda_por_vencer = 0)
    FROM por_cliente p;
END;
$function$;

-- ============================================================
-- fn_cta_cte_lista: página filtrada + paginada para la tabla
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_cta_cte_lista(
    p_busqueda text    DEFAULT NULL,
    p_estado   text    DEFAULT NULL, -- 'vencido' | 'por_vencer' | 'al_dia' | NULL (todos)
    p_limit    integer DEFAULT 50,
    p_offset   integer DEFAULT 0
)
RETURNS TABLE (
    cliente_id           uuid,
    razon_social         text,
    nombre_fantasia      text,
    deuda_total          numeric,
    deuda_vencida        numeric,
    deuda_por_vencer     numeric,
    ultimo_pago          timestamptz,
    facturas_pendientes  bigint,
    total_count          bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
    RETURN QUERY
    WITH por_cliente AS (
        SELECT
            f.cliente_id,
            c.razon_social,
            c.nombre_fantasia,
            SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)) AS deuda_total,
            SUM(CASE
                  WHEN f.vencimiento IS NOT NULL AND f.vencimiento < CURRENT_DATE
                  THEN GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)
                  ELSE 0
                END) AS deuda_vencida,
            SUM(CASE
                  WHEN f.vencimiento IS NOT NULL
                   AND f.vencimiento >= CURRENT_DATE
                   AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days'
                  THEN GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)
                  ELSE 0
                END) AS deuda_por_vencer,
            COUNT(*) AS facturas_pendientes
        FROM facturas f
        JOIN clientes c ON c.id = f.cliente_id
        WHERE f.empresa_id = v_empresa_id
          AND f.estado IN ('emitida', 'parcial')
          AND GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0
        GROUP BY f.cliente_id, c.razon_social, c.nombre_fantasia
    ),
    pagos AS (
        SELECT cb.cliente_id, MAX(cb.fecha) AS ultimo
        FROM cobros cb
        WHERE cb.empresa_id = v_empresa_id
        GROUP BY cb.cliente_id
    ),
    base AS (
        SELECT
            pc.cliente_id, pc.razon_social, pc.nombre_fantasia,
            pc.deuda_total, pc.deuda_vencida, pc.deuda_por_vencer,
            pg.ultimo, pc.facturas_pendientes
        FROM por_cliente pc
        LEFT JOIN pagos pg ON pg.cliente_id = pc.cliente_id
        WHERE (
                p_busqueda IS NULL OR p_busqueda = ''
                OR pc.razon_social ILIKE '%' || p_busqueda || '%'
                OR pc.nombre_fantasia ILIKE '%' || p_busqueda || '%'
              )
          AND (
                p_estado IS NULL OR p_estado = ''
                OR (p_estado = 'vencido'    AND pc.deuda_vencida > 0)
                OR (p_estado = 'por_vencer' AND pc.deuda_vencida = 0 AND pc.deuda_por_vencer > 0)
                OR (p_estado = 'al_dia'     AND pc.deuda_vencida = 0 AND pc.deuda_por_vencer = 0)
              )
    )
    SELECT
        b.cliente_id, b.razon_social, b.nombre_fantasia,
        b.deuda_total, b.deuda_vencida, b.deuda_por_vencer,
        b.ultimo, b.facturas_pendientes,
        COUNT(*) OVER() AS total_count
    FROM base b
    ORDER BY b.deuda_vencida DESC, b.deuda_total DESC
    LIMIT p_limit OFFSET p_offset;
END;
$function$;

-- ============================================================
-- Grants (mismo criterio que 258_fix_grants_fn_productos_lista_contadores)
-- ============================================================
GRANT EXECUTE ON FUNCTION public.fn_cta_cte_kpis() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cta_cte_lista(text, text, integer, integer) TO authenticated, service_role;
