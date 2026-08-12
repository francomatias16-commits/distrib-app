-- 270_rpc_puntos_kpis_y_lista_server_side.sql
-- Continuación AUDITORIA_FILTROS_v280 §4 y §6.3 — Puntos.
--
-- Antes: puntos.js traía TODOS los clientes con saldo (vista
-- v_puntos_clientes, sin .limit/.range — hasta 2.510 filas, una por
-- cliente activo) y filtraba por nombre/email con Array.filter() en cada
-- tecla, sin debounce. Los 3 KPIs de las tarjetas también se sumaban en
-- JS sobre ese array completo.
--
-- Mismo patrón que fn_cta_cte_kpis/fn_cta_cte_lista (266) y
-- fn_cobranzas_kpis/facturas (268):
--   fn_puntos_kpis()   → los 3 totales de las tarjetas en una sola fila.
--   fn_puntos_lista()  → página filtrada por nombre/email, LIMIT/OFFSET
--                        real, total_count vía COUNT(*) OVER().
--
-- NOTA — fix de tipos aplicado antes de producción: el primer borrador
-- declaraba saldo/total_ganado/total_canjeado como integer y updated_at
-- como timestamptz. saldo_puntos.puntos_disponibles/puntos_totales/
-- puntos_canjeados son en realidad numeric, y ultimo_movimiento es
-- timestamp sin zona horaria (confirmado con information_schema.columns).
-- Se corrigieron los tipos de retorno para que coincidan exactamente con
-- las columnas de origen.
--
-- NOTA — mismo fix de grants que la 267: CREATE FUNCTION deja EXECUTE
-- abierto a PUBLIC (y por lo tanto a anon) por defecto. Se revoca
-- explícitamente antes de otorgar solo a authenticated/service_role.
--
-- Aplicada y probada en vivo contra jgiquzjwoedmzwqgzubr simulando el JWT
-- de un usuario real (set_config('request.jwt.claims', ...)).

CREATE OR REPLACE FUNCTION public.fn_puntos_kpis()
RETURNS TABLE (
    total_puntos         numeric,
    clientes_con_puntos  bigint,
    total_canjeado       numeric
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
        COALESCE(SUM(sp.puntos_disponibles), 0)                    AS total_puntos,
        COUNT(*) FILTER (WHERE sp.puntos_disponibles > 0)          AS clientes_con_puntos,
        COALESCE(SUM(sp.puntos_canjeados), 0)                      AS total_canjeado
    FROM public.saldo_puntos sp
    WHERE sp.empresa_id = v_empresa_id;
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_puntos_lista(text, integer, integer);

CREATE OR REPLACE FUNCTION public.fn_puntos_lista(
    p_busqueda text    DEFAULT NULL,
    p_limit    integer DEFAULT 50,
    p_offset   integer DEFAULT 0
)
RETURNS TABLE (
    cliente_id      uuid,
    cliente_nombre  text,
    cliente_email   text,
    saldo           numeric,
    total_ganado    numeric,
    total_canjeado  numeric,
    updated_at      timestamp,
    total_count     bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
    RETURN QUERY
    WITH base AS (
        SELECT
            sp.cliente_id,
            COALESCE(c.razon_social, c.nombre_fantasia, 'Sin nombre') AS cliente_nombre,
            c.email                                                   AS cliente_email,
            sp.puntos_disponibles                                     AS saldo,
            sp.puntos_totales                                         AS total_ganado,
            sp.puntos_canjeados                                       AS total_canjeado,
            sp.ultimo_movimiento                                      AS updated_at
        FROM public.saldo_puntos sp
        JOIN public.clientes c ON c.id = sp.cliente_id
        WHERE sp.empresa_id = v_empresa_id
          AND (
                p_busqueda IS NULL OR p_busqueda = ''
                OR COALESCE(c.razon_social, c.nombre_fantasia, '') ILIKE '%' || p_busqueda || '%'
                OR COALESCE(c.email, '')                            ILIKE '%' || p_busqueda || '%'
              )
    )
    SELECT
        b.cliente_id, b.cliente_nombre, b.cliente_email,
        b.saldo, b.total_ganado, b.total_canjeado, b.updated_at,
        COUNT(*) OVER() AS total_count
    FROM base b
    ORDER BY b.saldo DESC
    LIMIT p_limit OFFSET p_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_puntos_kpis() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_puntos_kpis() FROM anon;
REVOKE ALL ON FUNCTION public.fn_puntos_lista(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_puntos_lista(text, integer, integer) FROM anon;

GRANT EXECUTE ON FUNCTION public.fn_puntos_kpis() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_puntos_lista(text, integer, integer) TO authenticated, service_role;
