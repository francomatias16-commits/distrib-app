-- db/022_req06_lotes.sql
-- REQ-06: Control de lotes y vencimientos
-- Ejecutar después de 021_req05_presupuestos.sql

-- ── Tabla lotes ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lotes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id         UUID NOT NULL REFERENCES productos(id),
  deposito_id         UUID REFERENCES depositos(id),
  numero_lote         TEXT,
  cantidad            NUMERIC(12,3) NOT NULL DEFAULT 0,
  cantidad_reservada  NUMERIC(12,3) NOT NULL DEFAULT 0,
  fecha_vencimiento   DATE,
  fecha_fabricacion   DATE,
  costo_unitario      NUMERIC(14,2),
  estado              TEXT NOT NULL DEFAULT 'vigente'
                      CHECK (estado IN ('vigente','por_vencer','vencido','agotado','dado_de_baja')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE lotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lotes_empresa" ON lotes
  FOR ALL TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- ── Índices ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lotes_empresa    ON lotes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_lotes_producto   ON lotes(producto_id);
CREATE INDEX IF NOT EXISTS idx_lotes_deposito   ON lotes(deposito_id);
CREATE INDEX IF NOT EXISTS idx_lotes_venc       ON lotes(fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_lotes_estado     ON lotes(estado);

-- ── Función: actualizar estado automáticamente ────────────────────────────
-- Llamada desde la API al listar para mantener estados sincronizados.
CREATE OR REPLACE FUNCTION actualizar_estado_lotes(p_empresa_id UUID)
RETURNS void AS $$
  -- Marcar vencidos
  UPDATE lotes
  SET    estado = 'vencido', updated_at = now()
  WHERE  empresa_id       = p_empresa_id
    AND  estado           = 'vigente'
    AND  fecha_vencimiento < CURRENT_DATE
    AND  cantidad         > 0;

  -- Marcar por_vencer (próximos 7 días)
  UPDATE lotes
  SET    estado = 'por_vencer', updated_at = now()
  WHERE  empresa_id       = p_empresa_id
    AND  estado           = 'vigente'
    AND  fecha_vencimiento BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '7 days')
    AND  cantidad         > 0;

  -- Marcar agotados
  UPDATE lotes
  SET    estado = 'agotado', updated_at = now()
  WHERE  empresa_id = p_empresa_id
    AND  estado NOT IN ('agotado', 'dado_de_baja')
    AND  cantidad   = 0;
$$ LANGUAGE sql;
