-- 007_finanzas_fix.sql — Adaptar schema a los scripts de la Etapa 4

-- 1. Adaptar tabla cheques
-- Los scripts esperan: vencimiento, fecha_recepcion, observaciones
-- El schema tiene: fecha_vto, notas
ALTER TABLE cheques RENAME COLUMN fecha_vto TO vencimiento;
ALTER TABLE cheques RENAME COLUMN notas TO observaciones;
ALTER TABLE cheques ADD COLUMN IF NOT EXISTS fecha_recepcion DATE;

-- 2. Adaptar tabla cta_cte
-- Los scripts esperan: importe, medio_pago, nro_comprobante, descripcion
-- El schema tiene: monto
ALTER TABLE cta_cte RENAME COLUMN monto TO importe;
ALTER TABLE cta_cte ADD COLUMN IF NOT EXISTS medio_pago TEXT;
ALTER TABLE cta_cte ADD COLUMN IF NOT EXISTS nro_comprobante TEXT;
ALTER TABLE cta_cte ADD COLUMN IF NOT EXISTS descripcion TEXT;

-- 3. Función para resumen de cuenta corriente (utilizada en cta-cte.js)
CREATE OR REPLACE FUNCTION resumen_cta_cte()
RETURNS TABLE (
    cliente_id UUID,
    razon_social TEXT,
    nombre_fantasia TEXT,
    deuda_total NUMERIC,
    deuda_vencida NUMERIC,
    deuda_por_vencer NUMERIC,
    ultimo_pago TIMESTAMPTZ,
    facturas_pendientes BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH saldos AS (
        SELECT 
            c.id as cid,
            c.razon_social,
            c.nombre_fantasia,
            COALESCE(SUM(CASE WHEN ct.tipo = 'factura' THEN ct.importe ELSE -ct.importe END), 0) as saldo_actual
        FROM clientes c
        LEFT JOIN cta_cte ct ON c.id = ct.cliente_id
        GROUP BY c.id, c.razon_social, c.nombre_fantasia
    ),
    vencimientos AS (
        SELECT 
            f.cliente_id,
            SUM(CASE WHEN f.vencimiento < CURRENT_DATE THEN (f.total - f.total_cobrado) ELSE 0 END) as vencido,
            SUM(CASE WHEN f.vencimiento >= CURRENT_DATE AND f.vencimiento <= (CURRENT_DATE + INTERVAL '7 days') THEN (f.total - f.total_cobrado) ELSE 0 END) as por_vencer,
            COUNT(*) as cant_facturas
        FROM facturas f
        WHERE f.estado IN ('emitida', 'parcial')
        GROUP BY f.cliente_id
    ),
    pagos AS (
        SELECT 
            cliente_id,
            MAX(fecha) as ultimo
        FROM cobros
        GROUP BY cliente_id
    )
    SELECT 
        s.cid,
        s.razon_social,
        s.nombre_fantasia,
        s.saldo_actual,
        COALESCE(v.vencido, 0),
        COALESCE(v.por_vencer, 0),
        p.ultimo,
        COALESCE(v.cant_facturas, 0)
    FROM saldos s
    LEFT JOIN vencimientos v ON s.cid = v.cliente_id
    LEFT JOIN pagos p ON s.cid = p.cliente_id
    WHERE s.saldo_actual != 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
