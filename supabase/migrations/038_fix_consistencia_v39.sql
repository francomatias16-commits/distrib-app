-- =============================================================================
-- 038_fix_consistencia_v39.sql
-- Fix de consistencia detectado en el reporte estático v39
--
-- Cambios:
--   1. cta_cte.empresa_id  — columna faltante (CRÍTICO)
--   2. facturas.vencimiento — alias de fecha_vencimiento (ALTO)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. cta_cte — agregar empresa_id
--    El frontend filtra /rest/v1/cta_cte?empresa_id=eq.X pero la columna
--    no existía. Sin ella Supabase devuelve error o todos los registros.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE cta_cte
  ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);

-- Backfill: derivar empresa_id desde el cliente dueño del movimiento
UPDATE cta_cte cc
SET    empresa_id = c.empresa_id
FROM   clientes c
WHERE  c.id = cc.cliente_id
  AND  cc.empresa_id IS NULL;

-- A partir de ahora la columna es obligatoria
ALTER TABLE cta_cte
  ALTER COLUMN empresa_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cta_cte_empresa ON cta_cte (empresa_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Actualizar las tres funciones que insertan en cta_cte para que siempre
-- incluyan empresa_id, derivándolo del cliente.
-- ─────────────────────────────────────────────────────────────────────────────

-- fn: registrar_cobro  (011_fase1_transacciones.sql)
CREATE OR REPLACE FUNCTION registrar_cobro(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_monto       NUMERIC,
  p_medio       TEXT,
  p_referencia  TEXT DEFAULT NULL,
  p_notas       TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cobro_id UUID;
  v_nro      TEXT;
BEGIN
  -- Número de comprobante secuencial por empresa
  SELECT 'COB-' || LPAD(COALESCE(MAX(CAST(regexp_replace(nro_comprobante,'[^0-9]','','g') AS INT)),0)::TEXT,'6','0')
  INTO   v_nro
  FROM   cobros
  WHERE  empresa_id = p_empresa_id;

  INSERT INTO cobros (empresa_id, cliente_id, monto, medio_pago, referencia, notas)
  VALUES (p_empresa_id, p_cliente_id, p_monto, p_medio, p_referencia, p_notas)
  RETURNING id INTO v_cobro_id;

  INSERT INTO cta_cte
    (empresa_id, cliente_id, tipo, importe, cobro_id, nro_comprobante, descripcion, medio_pago)
  VALUES
    (p_empresa_id, p_cliente_id, 'cobro', p_monto, v_cobro_id, v_nro,
     'Cobro ' || p_medio || COALESCE(' — ' || p_referencia, ''), p_medio);

  RETURN json_build_object('ok', true, 'cobro_id', v_cobro_id);
END;
$$;

-- fn: registrar_movimiento_cta_cte  (011_fase1_transacciones.sql)
CREATE OR REPLACE FUNCTION registrar_movimiento_cta_cte(
  p_empresa_id  UUID,
  p_cliente_id  UUID,
  p_tipo        TEXT,
  p_importe     NUMERIC,
  p_descripcion TEXT DEFAULT NULL,
  p_fecha       TIMESTAMPTZ DEFAULT now()
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cta_id UUID;
  v_nro    TEXT;
BEGIN
  SELECT 'MOV-' || LPAD(COALESCE(MAX(CAST(regexp_replace(nro_comprobante,'[^0-9]','','g') AS INT)),0)::TEXT,'6','0')
  INTO   v_nro
  FROM   cta_cte
  WHERE  empresa_id = p_empresa_id;

  INSERT INTO cta_cte
    (empresa_id, cliente_id, tipo, importe, nro_comprobante, descripcion, fecha)
  VALUES
    (p_empresa_id, p_cliente_id, p_tipo, p_importe, v_nro,
     COALESCE(p_descripcion, 'Nota de ' || replace(p_tipo, '_', ' ')), p_fecha)
  RETURNING id INTO v_cta_id;

  RETURN json_build_object('ok', true, 'cta_cte_id', v_cta_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: política de lectura para cta_cte usa empresa_id (ya existía por cliente_id).
-- Agregar política adicional filtrando por empresa.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS cta_cte_empresa_select ON cta_cte;
CREATE POLICY cta_cte_empresa_select ON cta_cte
  FOR SELECT
  USING (
    empresa_id = (
      SELECT empresa_id FROM usuarios WHERE id = auth.uid()
    )
  );


-- =============================================================================
-- 2. facturas.vencimiento — columna generada como alias de fecha_vencimiento
--
--    008_facturas_fix.sql ya agregó la columna `vencimiento DATE`.
--    033_cierre_financiero.sql agregó `fecha_vencimiento DATE`.
--    Ambas existen pero el código SQL interno usa fecha_vencimiento
--    y el frontend REST usa vencimiento.
--    Solución: mantener `vencimiento` como columna real (ya existe desde 008)
--    y sincronizarla con fecha_vencimiento vía trigger para que ambos nombres
--    sean equivalentes.
-- =============================================================================

-- Backfill: igualar vencimiento ← fecha_vencimiento donde vencimiento es NULL
UPDATE facturas
SET    vencimiento = fecha_vencimiento
WHERE  vencimiento IS NULL
  AND  fecha_vencimiento IS NOT NULL;

-- Trigger: cuando se escribe fecha_vencimiento, actualizar vencimiento también
CREATE OR REPLACE FUNCTION sync_factura_vencimiento()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Siempre mantener ambas columnas sincronizadas
  IF NEW.fecha_vencimiento IS DISTINCT FROM OLD.fecha_vencimiento THEN
    NEW.vencimiento := NEW.fecha_vencimiento;
  END IF;
  IF NEW.vencimiento IS DISTINCT FROM OLD.vencimiento THEN
    NEW.fecha_vencimiento := NEW.vencimiento;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_factura_vencimiento ON facturas;
CREATE TRIGGER trg_sync_factura_vencimiento
  BEFORE INSERT OR UPDATE ON facturas
  FOR EACH ROW EXECUTE FUNCTION sync_factura_vencimiento();

-- Índice para queries REST ?order=vencimiento.asc (ya existe en 028 para fecha_vencimiento)
CREATE INDEX IF NOT EXISTS idx_facturas_vencimiento ON facturas (vencimiento ASC)
  WHERE vencimiento IS NOT NULL;
