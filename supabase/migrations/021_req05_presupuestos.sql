-- db/021_req05_presupuestos.sql
-- REQ-05: Módulo de presupuestos
-- Ejecutar en orden después de 020_dt02_puntos.sql

-- ── Tabla presupuestos ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presupuestos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id        UUID NOT NULL REFERENCES clientes(id),
  vendedor_id       UUID REFERENCES usuarios(id),
  numero            TEXT NOT NULL,
  estado            TEXT NOT NULL DEFAULT 'borrador'
                    CHECK (estado IN ('borrador','enviado','aprobado','rechazado','expirado','convertido')),
  subtotal          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total             NUMERIC(14,2) NOT NULL DEFAULT 0,
  notas             TEXT,
  fecha_vencimiento TIMESTAMPTZ,
  pedido_id         UUID REFERENCES pedidos(id),   -- rellenado al convertir
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Tabla presupuesto_items ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presupuesto_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  presupuesto_id   UUID NOT NULL REFERENCES presupuestos(id) ON DELETE CASCADE,
  producto_id      UUID REFERENCES productos(id),
  descripcion      TEXT NOT NULL DEFAULT '',
  cantidad         NUMERIC(12,3) NOT NULL DEFAULT 1,
  precio_unitario  NUMERIC(14,2) NOT NULL DEFAULT 0,
  descuento        NUMERIC(5,2)  NOT NULL DEFAULT 0,
  subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0
);

-- ── Campo presupuesto_id en pedidos ──────────────────────────────────────
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS presupuesto_id UUID REFERENCES presupuestos(id);

-- ── Config: vigencia por defecto en empresas ─────────────────────────────
-- Se guarda en empresas.config JSONB como { "presupuestos_vigencia_dias": 2 }
-- No requiere migración de columna (config ya existe como JSONB)

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE presupuestos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE presupuesto_items ENABLE ROW LEVEL SECURITY;

-- Admin y vendedor: acceso total a su empresa
CREATE POLICY "presupuestos_empresa" ON presupuestos
  FOR ALL TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE POLICY "presupuesto_items_empresa" ON presupuesto_items
  FOR ALL TO authenticated
  USING (
    presupuesto_id IN (
      SELECT id FROM presupuestos
      WHERE empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    )
  );

-- ── Índices ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_presupuestos_empresa  ON presupuestos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_presupuestos_cliente  ON presupuestos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_presupuestos_estado   ON presupuestos(estado);
CREATE INDEX IF NOT EXISTS idx_presupuestos_venc     ON presupuestos(fecha_vencimiento);
CREATE INDEX IF NOT EXISTS idx_pres_items_pres       ON presupuesto_items(presupuesto_id);

-- ── Trigger: marcar expirados ─────────────────────────────────────────────
-- Se llama desde el endpoint GET para marcar vencidos sin cron
CREATE OR REPLACE FUNCTION marcar_presupuestos_expirados(p_empresa_id UUID)
RETURNS void AS $$
  UPDATE presupuestos
  SET    estado = 'expirado', updated_at = now()
  WHERE  empresa_id        = p_empresa_id
    AND  estado            = 'enviado'
    AND  fecha_vencimiento < now();
$$ LANGUAGE sql;
