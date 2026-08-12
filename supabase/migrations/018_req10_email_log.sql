-- ── REQ-10: Tabla de log de emails enviados ─────────────────────────────────
-- Archivo: db/018_req10_email_log.sql
-- Registra cada email enviado para historial y auditoría.
-- La columna resend_id permite rastrear el estado en Resend si fuera necesario.

CREATE TABLE IF NOT EXISTS email_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id    UUID REFERENCES clientes(id) ON DELETE SET NULL,
  tipo          TEXT NOT NULL,          -- 'estado_cuenta' | 'confirmacion_pedido' | etc.
  destinatario  TEXT NOT NULL,
  asunto        TEXT,
  resend_id     TEXT,                   -- ID de Resend para tracking
  enviado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Índices útiles para consultas de historial
CREATE INDEX IF NOT EXISTS idx_email_log_empresa   ON email_log(empresa_id);
CREATE INDEX IF NOT EXISTS idx_email_log_cliente   ON email_log(cliente_id);
CREATE INDEX IF NOT EXISTS idx_email_log_tipo      ON email_log(tipo);
CREATE INDEX IF NOT EXISTS idx_email_log_created   ON email_log(created_at DESC);

-- RLS: solo usuarios de la misma empresa pueden ver sus logs
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_log_empresa" ON email_log
  FOR ALL USING (
    empresa_id = (
      SELECT empresa_id FROM usuarios WHERE id = auth.uid()
    )
  );

-- ── Comentarios descriptivos ────────────────────────────────────────────────
COMMENT ON TABLE email_log IS 'Log de todos los emails transaccionales enviados por la app.';
COMMENT ON COLUMN email_log.tipo IS 'Tipo de email: estado_cuenta, confirmacion_pedido, despacho, reset_password, etc.';
COMMENT ON COLUMN email_log.resend_id IS 'ID del mensaje en Resend API para tracking de entrega.';
