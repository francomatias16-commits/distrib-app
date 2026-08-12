-- 413_cta_cte_incluye_deuda_sin_comprobante.sql
--
-- Bug detectado en producción (Coty SRL / EL COTYLLON): desde "¿A quién
-- llamo hoy?" el botón "Cobrar" cambia a la pestaña "Saldos por cliente"
-- pero no abre la ficha del cliente. No es un bug de UI: abrirCliente()
-- (cta-cte.js) busca al cliente en `todosClientes`, que sale de
-- fn_cta_cte_lista(). Esa función quedó afuera cuando 411/412 ampliaron
-- el resto de Cobranzas para incluir:
--   a) facturas en estado 'pendiente'/'error_afip' (sin CAE de ARCA/AFIP)
--   b) deuda de cta_cte sin ningún comprobante (clientes.saldo_deuda no
--      cubierto por ninguna factura)
-- fn_cta_cte_kpis()/fn_cta_cte_lista() (migración 266) siguieron
-- filtrando solo estado IN ('emitida','parcial') y no conocen la deuda
-- sin comprobante en absoluto. Un cliente cuya única deuda sea de esos
-- dos tipos (como EL COTYLLON) directamente no aparece en la lista que
-- alimenta "Saldos por cliente" -> abrirCliente() no lo encuentra y
-- corta en silencio.
--
-- Mismo criterio que 411/412, aplicado acá:
--   1) Ampliar el filtro de estado de facturas a ('emitida','parcial',
--      'pendiente','error_afip').
--   2) Sumar la deuda sin comprobante (saldo_deuda - cubierto) a cada
--      cliente. No tiene fecha de vencimiento propia -> se trata como
--      vencida (mismo tratamiento que la fila sintética "Sin
--      comprobante" en fn_cobranzas_facturas / v_cobranza_priorizada).
--   3) A diferencia de 411 (que solo suma un total), acá hay que poder
--      generar una fila de cliente aunque NO tenga ninguna factura que
--      pase el filtro (caso "solo deuda sin comprobante") -> FULL JOIN
--      contra clientes en vez de partir siempre de facturas.

-- ============================================================
-- fn_cta_cte_kpis
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
    WITH por_cliente_facturas AS (
        SELECT
            f.cliente_id,
            SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)) AS deuda_facturas,
            SUM(CASE
                  WHEN f.vencimiento IS NOT NULL AND f.vencimiento < CURRENT_DATE
                  THEN GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)
                  ELSE 0
                END) AS deuda_vencida_facturas,
            SUM(CASE
                  WHEN f.vencimiento IS NOT NULL
                   AND f.vencimiento >= CURRENT_DATE
                   AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days'
                  THEN GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)
                  ELSE 0
                END) AS deuda_por_vencer_facturas
        FROM facturas f
        WHERE f.empresa_id = v_empresa_id
          AND f.estado IN ('emitida', 'parcial', 'pendiente', 'error_afip')
          AND GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0
        GROUP BY f.cliente_id
    ),
    sin_comprobante AS (
        SELECT
            c.id AS cliente_id,
            GREATEST(c.saldo_deuda - COALESCE(pcf.deuda_facturas, 0), 0) AS deuda_sc
        FROM clientes c
        LEFT JOIN por_cliente_facturas pcf ON pcf.cliente_id = c.id
        WHERE c.empresa_id = v_empresa_id
          AND COALESCE(c.saldo_deuda, 0) > 0
          AND GREATEST(c.saldo_deuda - COALESCE(pcf.deuda_facturas, 0), 0) > 0
    ),
    por_cliente AS (
        SELECT
            COALESCE(pcf.cliente_id, sc.cliente_id) AS cliente_id,
            COALESCE(pcf.deuda_facturas, 0) + COALESCE(sc.deuda_sc, 0) AS deuda_total,
            COALESCE(pcf.deuda_vencida_facturas, 0) + COALESCE(sc.deuda_sc, 0) AS deuda_vencida,
            COALESCE(pcf.deuda_por_vencer_facturas, 0) AS deuda_por_vencer
        FROM por_cliente_facturas pcf
        FULL JOIN sin_comprobante sc ON sc.cliente_id = pcf.cliente_id
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
-- fn_cta_cte_lista
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
    WITH por_cliente_facturas AS (
        SELECT
            f.cliente_id,
            SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)) AS deuda_facturas,
            SUM(CASE
                  WHEN f.vencimiento IS NOT NULL AND f.vencimiento < CURRENT_DATE
                  THEN GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)
                  ELSE 0
                END) AS deuda_vencida_facturas,
            SUM(CASE
                  WHEN f.vencimiento IS NOT NULL
                   AND f.vencimiento >= CURRENT_DATE
                   AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days'
                  THEN GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)
                  ELSE 0
                END) AS deuda_por_vencer_facturas,
            COUNT(*) AS facturas_pendientes
        FROM facturas f
        WHERE f.empresa_id = v_empresa_id
          AND f.estado IN ('emitida', 'parcial', 'pendiente', 'error_afip')
          AND GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0
        GROUP BY f.cliente_id
    ),
    sin_comprobante AS (
        SELECT
            c.id AS cliente_id,
            GREATEST(c.saldo_deuda - COALESCE(pcf.deuda_facturas, 0), 0) AS deuda_sc
        FROM clientes c
        LEFT JOIN por_cliente_facturas pcf ON pcf.cliente_id = c.id
        WHERE c.empresa_id = v_empresa_id
          AND COALESCE(c.saldo_deuda, 0) > 0
          AND GREATEST(c.saldo_deuda - COALESCE(pcf.deuda_facturas, 0), 0) > 0
    ),
    por_cliente AS (
        SELECT
            COALESCE(pcf.cliente_id, sc.cliente_id) AS cliente_id,
            c.razon_social,
            c.nombre_fantasia,
            COALESCE(pcf.deuda_facturas, 0) + COALESCE(sc.deuda_sc, 0) AS deuda_total,
            COALESCE(pcf.deuda_vencida_facturas, 0) + COALESCE(sc.deuda_sc, 0) AS deuda_vencida,
            COALESCE(pcf.deuda_por_vencer_facturas, 0) AS deuda_por_vencer,
            COALESCE(pcf.facturas_pendientes, 0) AS facturas_pendientes
        FROM por_cliente_facturas pcf
        FULL JOIN sin_comprobante sc ON sc.cliente_id = pcf.cliente_id
        JOIN clientes c ON c.id = COALESCE(pcf.cliente_id, sc.cliente_id)
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

-- Grants ya aplicados desde 267 (mismo nombre y firma) — CREATE OR REPLACE
-- los conserva, pero se repiten por las dudas.
GRANT EXECUTE ON FUNCTION public.fn_cta_cte_kpis() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cta_cte_lista(text, text, integer, integer) TO authenticated, service_role;
