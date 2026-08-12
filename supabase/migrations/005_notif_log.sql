-- 005_notif_log.sql
-- Registro de notificaciones enviadas por WhatsApp / email.
-- Permite auditoría y control de cooldown para no spamear al cliente.

CREATE TABLE notif_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   UUID REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_id   UUID REFERENCES clientes(id) ON DELETE SET NULL,
  pedido_id    UUID REFERENCES pedidos(id)  ON DELETE SET NULL,
  tipo         TEXT NOT NULL,   -- 'confirmacion_pedido' | 'pedido_despachado' | 'pedido_cancelado' | 'deuda_vencida'
  canal        TEXT NOT NULL DEFAULT 'whatsapp',  -- 'whatsapp' | 'email'
  telefono     TEXT,
  email        TEXT,
  message_id   TEXT,           -- ID del mensaje devuelto por Meta API
  payload      JSONB,          -- params usados en el template (para debug)
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Índices para el control de cooldown y auditoría
CREATE INDEX idx_notif_log_cliente_tipo ON notif_log (cliente_id, tipo, created_at DESC);
CREATE INDEX idx_notif_log_pedido       ON notif_log (pedido_id);
CREATE INDEX idx_notif_log_empresa      ON notif_log (empresa_id, created_at DESC);

-- RLS: solo el service_role puede insertar (las funciones serverless usan service_role)
ALTER TABLE notif_log ENABLE ROW LEVEL SECURITY;

-- El admin/dueño puede ver el log de su empresa
CREATE POLICY "ver notif_log propia empresa"
  ON notif_log FOR SELECT
  USING (
    empresa_id IN (
      SELECT empresa_id FROM usuarios WHERE id = auth.uid()
    )
  );
