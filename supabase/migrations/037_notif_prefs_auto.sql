-- 037_notif_prefs_auto.sql
-- Preferencias de notificaciones push para los motores de automatización.
-- Una fila por empresa; cada columna booleana controla un tipo de evento.

CREATE TABLE IF NOT EXISTS notif_prefs_auto (
  empresa_id              UUID        PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,

  -- REQ-1: Piloto Automático
  piloto_sugerencia       BOOLEAN     NOT NULL DEFAULT TRUE,   -- Nuevas sugerencias de pedido generadas

  -- REQ-2: Cierre Financiero
  cierre_cliente_bloqueado BOOLEAN    NOT NULL DEFAULT TRUE,   -- Cliente bloqueado por deuda
  cierre_error_cola        BOOLEAN    NOT NULL DEFAULT TRUE,   -- Error en la cola financiera

  -- REQ-4: Stock Autónomo
  stock_quiebre           BOOLEAN     NOT NULL DEFAULT TRUE,   -- Quiebre de stock detectado
  stock_orden_auto        BOOLEAN     NOT NULL DEFAULT TRUE,   -- Orden de compra auto-generada esperando aprobación

  -- REQ-5: Score Cliente
  score_caida_critica     BOOLEAN     NOT NULL DEFAULT TRUE,   -- Cliente cae a "riesgo" o "bloqueado"

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION set_notif_prefs_auto_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_notif_prefs_auto_updated ON notif_prefs_auto;
CREATE TRIGGER trg_notif_prefs_auto_updated
  BEFORE UPDATE ON notif_prefs_auto
  FOR EACH ROW EXECUTE FUNCTION set_notif_prefs_auto_updated();

-- RLS
ALTER TABLE notif_prefs_auto ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin accede a sus prefs notif"
  ON notif_prefs_auto FOR ALL
  USING (
    empresa_id IN (
      SELECT empresa_id FROM usuarios
      WHERE auth_uid = auth.uid() AND rol IN ('dueno', 'admin')
    )
  );

-- Índice (PK ya cubre empresa_id; no se necesita extra)

COMMENT ON TABLE notif_prefs_auto IS
  'Preferencias de notificaciones push por motor de automatización, una fila por empresa.';
