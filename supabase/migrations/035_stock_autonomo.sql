-- ═══════════════════════════════════════════════════════════════════════════
-- REQ-4: Stock Vivo con Reposición Autónoma
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE productos ADD COLUMN IF NOT EXISTS lead_time_dias       INT DEFAULT 7;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS stock_minimo         NUMERIC(12,3) DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS stock_objetivo       NUMERIC(12,3) DEFAULT 0;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS proveedor_id_default UUID REFERENCES proveedores(id);

-- Ampliar constraint de estados de ordenes_compra
ALTER TABLE ordenes_compra DROP CONSTRAINT IF EXISTS ordenes_compra_estado_check;
ALTER TABLE ordenes_compra ADD CONSTRAINT ordenes_compra_estado_check
  CHECK (estado IN ('borrador','pendiente_aprobacion','enviada','confirmada',
                    'recibida_parcial','recibida','cancelada'));

ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS auto_generada            BOOLEAN DEFAULT false;
ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS velocidad_venta_snapshot JSONB;

CREATE TABLE IF NOT EXISTS alertas_stock (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id     UUID NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  dias_restantes  NUMERIC(6,1),
  orden_compra_id UUID REFERENCES ordenes_compra(id),
  resuelta        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(producto_id, tipo, resuelta)
);

ALTER TABLE alertas_stock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alertas_empresa ON alertas_stock;
CREATE POLICY alertas_empresa ON alertas_stock
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- ─── Función: analizar stock con proyección de agotamiento ─────────────────
CREATE OR REPLACE FUNCTION analizar_stock_autonomo(p_empresa_id UUID)
RETURNS TABLE (
  producto_id       UUID,
  nombre            TEXT,
  stock_actual      NUMERIC,
  velocidad_dia     NUMERIC,
  dias_restantes    NUMERIC,
  lead_time         INT,
  necesita_reponer  BOOLEAN,
  cantidad_sugerida NUMERIC,
  proveedor_id      UUID
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH ventas_30d AS (
    SELECT pi2.producto_id,
           SUM(pi2.cantidad) / 30.0 AS vel_dia
    FROM pedido_items pi2
    JOIN pedidos ped ON ped.id = pi2.pedido_id
    WHERE ped.empresa_id = p_empresa_id
      AND ped.estado IN ('entregado','despachado','confirmado')
      AND ped.fecha_pedido >= now() - INTERVAL '30 days'
    GROUP BY pi2.producto_id
  )
  SELECT
    p.id,
    p.nombre,
    COALESCE(s.cantidad - s.cantidad_reservada, 0),
    COALESCE(v.vel_dia, 0),
    CASE WHEN COALESCE(v.vel_dia, 0) > 0
      THEN COALESCE(s.cantidad - s.cantidad_reservada, 0) / v.vel_dia
      ELSE 999
    END,
    COALESCE(p.lead_time_dias, 7),
    (COALESCE(s.cantidad - s.cantidad_reservada, 0) <= p.stock_minimo),
    GREATEST(0,
      COALESCE(p.stock_objetivo,
        COALESCE(v.vel_dia, 0) * 30, 0)
      - COALESCE(s.cantidad - s.cantidad_reservada, 0)
    ),
    p.proveedor_id_default
  FROM productos p
  LEFT JOIN stock s ON s.producto_id = p.id
  LEFT JOIN ventas_30d v ON v.producto_id = p.id
  WHERE p.empresa_id = p_empresa_id AND p.activo = true
  ORDER BY 5 ASC;
END;
$$;
