-- 412_priorizada_incluye_deuda_sin_comprobante.sql
--
-- Continuación de 411: esa migración arregló fn_cobranzas_kpis() y
-- fn_cobranzas_facturas() (tarjetas + tabs hoy/semana/vencidas), pero la
-- pestaña que abre por default en /admin/cobranzas — "¿A quién llamo
-- hoy?" — NO usa esas funciones. Usa /api/score?accion=cobranza-priorizada
-- (lib/handlers/score.js), que lee directo de la vista
-- v_cobranza_priorizada, con su propio filtro independiente:
--   WHERE f.estado = ANY (ARRAY['emitida','parcial'])
-- Mismo problema de fondo, otro lugar del código: por eso las tarjetas de
-- arriba mostraban plata pero la lista de abajo aparecía vacía para esos
-- clientes.
--
-- Mismo criterio que 411:
--   1) Ampliar el filtro de estado a ('emitida','parcial','pendiente',
--      'error_afip').
--   2) Agregar una fila sintética "Sin comprobante" por cliente con
--      residual = saldo_deuda − lo ya cubierto por esas facturas, para que
--      la deuda sin ninguna factura generada también entre al scoring de
--      prioridad (se le pone fecha_vencimiento = hoy → dias_vencida = 0,
--      no hay fecha real que usar).

CREATE OR REPLACE VIEW public.v_cobranza_priorizada AS
WITH dias_pago_cliente AS (
    SELECT co.cliente_id,
           avg(EXTRACT(epoch FROM co.fecha - f.fecha_vencimiento::timestamp with time zone) / 86400.0) AS dias_prom
    FROM cobros co
    JOIN cta_cte cc ON cc.cobro_id = co.id
    JOIN facturas f ON f.id = cc.factura_id
    WHERE co.fecha >= (now() - '90 days'::interval)
    GROUP BY co.cliente_id
),
cheques_cliente AS (
    SELECT cheques.cliente_id,
           count(*) FILTER (WHERE cheques.estado = 'rechazado'::text) AS rechazados,
           count(*) AS total_cheques
    FROM cheques
    WHERE cheques.cliente_id IS NOT NULL
    GROUP BY cheques.cliente_id
),
cubierto_por_cliente AS (
    SELECT f.cliente_id, SUM(GREATEST(f.total - COALESCE(f.total_cobrado, 0::numeric), 0::numeric)) AS cubierto
    FROM facturas f
    WHERE f.estado = ANY (ARRAY['emitida'::estado_factura, 'parcial'::estado_factura, 'pendiente'::estado_factura, 'error_afip'::estado_factura])
    GROUP BY f.cliente_id
),
componentes AS (
    -- Rama 1: facturas reales (estado ampliado respecto al original)
    SELECT
        f.id AS factura_id,
        f.empresa_id,
        f.cliente_id,
        f.numero,
        f.total,
        f.total_cobrado,
        f.total - COALESCE(f.total_cobrado, 0::numeric) AS saldo_pendiente,
        f.fecha_vencimiento,
        GREATEST(0, CURRENT_DATE - f.fecha_vencimiento) AS dias_vencida,
        c.razon_social,
        c.nombre_fantasia,
        c.score_categoria,
        c.limite_credito,
        calcular_deuda_cliente(c.id) AS deuda_actual,
        CASE
            WHEN dp.dias_prom IS NULL THEN 20
            WHEN dp.dias_prom <= '-5'::integer::numeric THEN 40
            WHEN dp.dias_prom <= 0::numeric THEN 35
            WHEN dp.dias_prom <= 7::numeric THEN 25
            WHEN dp.dias_prom <= 15::numeric THEN 15
            WHEN dp.dias_prom <= 30::numeric THEN 5
            ELSE 0
        END AS pts_pagos,
        CASE
            WHEN COALESCE(ch.total_cheques, 0::bigint) = 0 THEN 18::numeric
            ELSE GREATEST(0::numeric, round(25::numeric - 25.0 * ch.rechazados::numeric / ch.total_cheques::numeric))
        END AS pts_cheques,
        CASE
            WHEN COALESCE(c.limite_credito, 0::numeric) = 0::numeric THEN 10
            WHEN calcular_deuda_cliente(c.id) <= 0::numeric THEN 20
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.3 THEN 16
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.6 THEN 10
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.9 THEN 4
            ELSE 0
        END AS pts_deuda,
        CASE c.score_categoria
            WHEN 'premium'::text THEN 15
            WHEN 'bueno'::text THEN 11
            WHEN 'normal'::text THEN 7
            WHEN 'riesgo'::text THEN 2
            WHEN 'bloqueado'::text THEN 0
            ELSE 7
        END AS pts_categoria
    FROM facturas f
    JOIN clientes c ON c.id = f.cliente_id
    LEFT JOIN dias_pago_cliente dp ON dp.cliente_id = f.cliente_id
    LEFT JOIN cheques_cliente ch ON ch.cliente_id = f.cliente_id
    WHERE (f.estado = ANY (ARRAY['emitida'::estado_factura, 'parcial'::estado_factura, 'pendiente'::estado_factura, 'error_afip'::estado_factura]))
      AND (f.total - COALESCE(f.total_cobrado, 0::numeric)) > 0::numeric

    UNION ALL

    -- Rama 2: deuda real de cta_cte (clientes.saldo_deuda) que ninguna
    -- factura cubre — sin comprobante en absoluto.
    SELECT
        NULL::uuid AS factura_id,
        c.empresa_id,
        c.id AS cliente_id,
        'Sin comprobante'::text AS numero,
        GREATEST(c.saldo_deuda - COALESCE(cc.cubierto, 0::numeric), 0::numeric) AS total,
        0::numeric AS total_cobrado,
        GREATEST(c.saldo_deuda - COALESCE(cc.cubierto, 0::numeric), 0::numeric) AS saldo_pendiente,
        CURRENT_DATE AS fecha_vencimiento,
        0 AS dias_vencida,
        c.razon_social,
        c.nombre_fantasia,
        c.score_categoria,
        c.limite_credito,
        calcular_deuda_cliente(c.id) AS deuda_actual,
        CASE
            WHEN dp.dias_prom IS NULL THEN 20
            WHEN dp.dias_prom <= '-5'::integer::numeric THEN 40
            WHEN dp.dias_prom <= 0::numeric THEN 35
            WHEN dp.dias_prom <= 7::numeric THEN 25
            WHEN dp.dias_prom <= 15::numeric THEN 15
            WHEN dp.dias_prom <= 30::numeric THEN 5
            ELSE 0
        END AS pts_pagos,
        CASE
            WHEN COALESCE(ch.total_cheques, 0::bigint) = 0 THEN 18::numeric
            ELSE GREATEST(0::numeric, round(25::numeric - 25.0 * ch.rechazados::numeric / ch.total_cheques::numeric))
        END AS pts_cheques,
        CASE
            WHEN COALESCE(c.limite_credito, 0::numeric) = 0::numeric THEN 10
            WHEN calcular_deuda_cliente(c.id) <= 0::numeric THEN 20
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.3 THEN 16
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.6 THEN 10
            WHEN (calcular_deuda_cliente(c.id) / c.limite_credito) <= 0.9 THEN 4
            ELSE 0
        END AS pts_deuda,
        CASE c.score_categoria
            WHEN 'premium'::text THEN 15
            WHEN 'bueno'::text THEN 11
            WHEN 'normal'::text THEN 7
            WHEN 'riesgo'::text THEN 2
            WHEN 'bloqueado'::text THEN 0
            ELSE 7
        END AS pts_categoria
    FROM clientes c
    LEFT JOIN cubierto_por_cliente cc ON cc.cliente_id = c.id
    LEFT JOIN dias_pago_cliente dp ON dp.cliente_id = c.id
    LEFT JOIN cheques_cliente ch ON ch.cliente_id = c.id
    WHERE COALESCE(c.saldo_deuda, 0::numeric) > 0::numeric
      AND GREATEST(c.saldo_deuda - COALESCE(cc.cubierto, 0::numeric), 0::numeric) > 0::numeric
)
SELECT
    factura_id,
    empresa_id,
    cliente_id,
    numero AS numero_factura,
    COALESCE(nombre_fantasia, razon_social) AS cliente_nombre,
    total,
    total_cobrado,
    saldo_pendiente,
    fecha_vencimiento,
    dias_vencida,
    score_categoria,
    deuda_actual,
    pts_pagos::numeric + pts_cheques + pts_deuda::numeric + pts_categoria::numeric AS score_cobrabilidad,
    CASE
        WHEN (pts_pagos::numeric + pts_cheques + pts_deuda::numeric + pts_categoria::numeric) < 30::numeric THEN 'accion_urgente'::text
        WHEN (pts_pagos::numeric + pts_cheques + pts_deuda::numeric + pts_categoria::numeric) < 55::numeric THEN 'seguimiento'::text
        ELSE 'cobro_probable'::text
    END AS prioridad
FROM componentes
ORDER BY (pts_pagos::numeric + pts_cheques + pts_deuda::numeric + pts_categoria::numeric), saldo_pendiente DESC, dias_vencida DESC;
