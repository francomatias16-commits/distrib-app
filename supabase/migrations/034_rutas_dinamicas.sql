-- ═══════════════════════════════════════════════════════════════════════════
-- REQ-3: Inteligencia de Ruta Dinámica con Re-Optimización en Vivo
-- Ejecutar en Supabase SQL Editor
-- Habilitar Realtime para tablas 'rutas' y 'entregas' en:
--   Dashboard → Database → Replication
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE entregas ADD COLUMN IF NOT EXISTS ubicacion_entrega  JSONB;
ALTER TABLE entregas ADD COLUMN IF NOT EXISTS duracion_minutos   INT;
ALTER TABLE entregas ADD COLUMN IF NOT EXISTS distancia_km       NUMERIC(8,2);

ALTER TABLE rutas ADD COLUMN IF NOT EXISTS chofer_lat         NUMERIC(10,7);
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS chofer_lng         NUMERIC(10,7);
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS chofer_actualizado TIMESTAMPTZ;

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS lat NUMERIC(10,7);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS lng NUMERIC(10,7);

CREATE TABLE IF NOT EXISTS reportes_ruta (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruta_id          UUID NOT NULL REFERENCES rutas(id) ON DELETE CASCADE UNIQUE,
  empresa_id       UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chofer_id        UUID REFERENCES usuarios(id),
  total_paradas    INT DEFAULT 0,
  entregadas       INT DEFAULT 0,
  no_entregadas    INT DEFAULT 0,
  km_estimados     NUMERIC(8,2),
  tiempo_total_min INT,
  pct_completitud  NUMERIC(5,2),
  generado_en      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE reportes_ruta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rr_empresa ON reportes_ruta;
CREATE POLICY rr_empresa ON reportes_ruta
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

-- Índices para consultas de rutas en vivo
CREATE INDEX IF NOT EXISTS idx_rutas_empresa_activas ON rutas(empresa_id, estado)
  WHERE estado IN ('asignada', 'en_curso');
CREATE INDEX IF NOT EXISTS idx_entregas_ruta_estado ON entregas(ruta_id, estado, orden);
