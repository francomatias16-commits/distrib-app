-- 411_cobranzas_incluye_deuda_sin_comprobante.sql
--
-- Bug detectado en producción (Coty SRL / EL COTYLLON): saldo_deuda del
-- cliente = $16.981,14 (correcto, viene del trigger sync_saldo_deuda_cliente()
-- sobre cta_cte), pero /admin/cobranzas mostraba $0 para ese cliente porque
-- fn_cobranzas_kpis()/fn_cobranzas_facturas() solo miran la tabla `facturas`
-- con estado IN ('emitida','parcial'). Dos ventas POS a cuenta corriente de
-- ese cliente no entraban en ese filtro:
--   - Venta POS-20260720-00021 ($10.890): generó factura pero quedó en
--     estado 'pendiente' — nunca consiguió CAE (falta config ARCA/AFIP de
--     la empresa, notas_error lo confirma). Excluida por el filtro de estado.
--   - Venta POS-20260720-00019 ($6.091,14): venta completada, generó el
--     movimiento de deuda en cta_cte, pero no generó ninguna fila en
--     `facturas`. No hay ningún registro que Cobranzas pueda leer.
--
-- Fix en dos partes:
--   1) Ampliar el filtro de estado de facturas a ('emitida','parcial',
--      'pendiente','error_afip') — cualquier factura con saldo pendiente
--      real, esté o no emitida ante ARCA, salvo 'anulada'.
--   2) Agregar la diferencia entre clientes.saldo_deuda (fuente de verdad,
--      mantenida por sync_saldo_deuda_cliente()) y lo ya cubierto por esas
--      facturas: esa diferencia es deuda real sin ningún comprobante en
--      absoluto. Se suma al balde "vencidas" (no tiene fecha de
--      vencimiento propia, así que se trata como ya vencida/urgente) y
--      aparece en el listado como una fila sintética "Sin comprobante"
--      por cliente — al tocar "Cobrar" abre igual la ficha del cliente
--      (abrirCobroFactura() en cobranzas.js no usa el id de factura para
--      nada más que eso).
--
-- La configuración de ARCA/AFIP de la empresa queda pendiente aparte —
-- esto no la arregla, solo evita que la deuda real quede invisible
-- mientras tanto.

-- ============================================================
-- fn_cobranzas_kpis
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
  v_hoy_monto numeric; v_hoy_n bigint;
  v_sem_monto numeric; v_sem_n bigint;
  v_venc_monto numeric; v_venc_n bigint;
  v_sc_monto numeric; v_sc_n bigint;
BEGIN
    SELECT
        COALESCE(SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0))
                  FILTER (WHERE f.vencimiento = CURRENT_DATE), 0),
        COUNT(*) FILTER (WHERE f.vencimiento = CURRENT_DATE),
        COALESCE(SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0))
                  FILTER (WHERE f.vencimiento > CURRENT_DATE AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days'), 0),
        COUNT(*) FILTER (WHERE f.vencimiento > CURRENT_DATE AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days'),
        COALESCE(SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0))
                  FILTER (WHERE f.vencimiento < CURRENT_DATE OR f.vencimiento IS NULL), 0),
        COUNT(*) FILTER (WHERE f.vencimiento < CURRENT_DATE OR f.vencimiento IS NULL)
    INTO v_hoy_monto, v_hoy_n, v_sem_monto, v_sem_n, v_venc_monto, v_venc_n
    FROM facturas f
    WHERE f.empresa_id = v_empresa_id
      AND f.estado IN ('emitida', 'parcial', 'pendiente', 'error_afip')
      AND GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0;

    -- Deuda de cta_cte no cubierta por ninguna factura (ni siquiera
    -- pendiente/error_afip): ventas a cuenta corriente sin comprobante.
    SELECT
        COALESCE(SUM(GREATEST(c.saldo_deuda - COALESCE(fc.cubierto, 0), 0)), 0),
        COUNT(*) FILTER (WHERE GREATEST(c.saldo_deuda - COALESCE(fc.cubierto, 0), 0) > 0)
    INTO v_sc_monto, v_sc_n
    FROM clientes c
    LEFT JOIN (
        SELECT f.cliente_id, SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)) AS cubierto
        FROM facturas f
        WHERE f.empresa_id = v_empresa_id
          AND f.estado IN ('emitida', 'parcial', 'pendiente', 'error_afip')
        GROUP BY f.cliente_id
    ) fc ON fc.cliente_id = c.id
    WHERE c.empresa_id = v_empresa_id
      AND COALESCE(c.saldo_deuda, 0) > 0;

    RETURN QUERY SELECT
        v_hoy_monto, v_hoy_n,
        v_sem_monto, v_sem_n,
        v_venc_monto + v_sc_monto, v_venc_n + v_sc_n;
END;
$function$;

-- ============================================================
-- fn_cobranzas_facturas
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
    WITH facturas_bucket AS (
        SELECT
            f.id, f.numero, f.total, f.total_cobrado,
            GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) AS pendiente,
            f.vencimiento, f.cliente_id,
            COALESCE(c.nombre_fantasia, c.razon_social) AS cliente_nombre
        FROM facturas f
        JOIN clientes c ON c.id = f.cliente_id
        WHERE f.empresa_id = v_empresa_id
          AND f.estado IN ('emitida', 'parcial', 'pendiente', 'error_afip')
          AND GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0) > 0
          AND (
                (p_bucket = 'hoy'      AND f.vencimiento = CURRENT_DATE)
             OR (p_bucket = 'semana'   AND f.vencimiento > CURRENT_DATE AND f.vencimiento <= CURRENT_DATE + INTERVAL '7 days')
             OR (p_bucket = 'vencidas' AND (f.vencimiento < CURRENT_DATE OR f.vencimiento IS NULL))
              )
    ),
    -- Deuda real de cta_cte sin ningún comprobante que la respalde. Solo
    -- aplica al balde "vencidas": no tiene fecha de vencimiento propia,
    -- así que se trata como ya vencida.
    sin_comprobante AS (
        SELECT
            c.id, 'Sin comprobante'::text AS numero,
            GREATEST(c.saldo_deuda - COALESCE(fc.cubierto, 0), 0) AS total,
            0::numeric AS total_cobrado,
            GREATEST(c.saldo_deuda - COALESCE(fc.cubierto, 0), 0) AS pendiente,
            NULL::date AS vencimiento,
            c.id AS cliente_id,
            COALESCE(c.nombre_fantasia, c.razon_social) AS cliente_nombre
        FROM clientes c
        LEFT JOIN (
            SELECT f.cliente_id, SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0), 0)) AS cubierto
            FROM facturas f
            WHERE f.empresa_id = v_empresa_id
              AND f.estado IN ('emitida', 'parcial', 'pendiente', 'error_afip')
            GROUP BY f.cliente_id
        ) fc ON fc.cliente_id = c.id
        WHERE c.empresa_id = v_empresa_id
          AND p_bucket = 'vencidas'
          AND GREATEST(c.saldo_deuda - COALESCE(fc.cubierto, 0), 0) > 0
    ),
    combinado AS (
        SELECT * FROM facturas_bucket
        UNION ALL
        SELECT * FROM sin_comprobante
    )
    SELECT
        co.id, co.numero, co.total, co.total_cobrado, co.pendiente,
        co.vencimiento, co.cliente_id, co.cliente_nombre,
        COUNT(*) OVER() AS total_count
    FROM combinado co
    ORDER BY co.vencimiento ASC NULLS FIRST
    LIMIT p_limit OFFSET p_offset;
END;
$function$;

-- Los GRANT/REVOKE ya están aplicados sobre estas dos funciones desde la
-- migración 267 (mismo nombre y firma) — CREATE OR REPLACE los conserva.
