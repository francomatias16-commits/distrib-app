-- ═══════════════════════════════════════════════════════════════════════════
-- REQ-2: Cierre Financiero Encadenado Automático
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cola_financiera (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  referencia_id   UUID,
  estado          TEXT DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','procesando','completado','error','omitido')),
  intentos        INT DEFAULT 0,
  proximo_intento TIMESTAMPTZ DEFAULT now(),
  payload         JSONB DEFAULT '{}',
  error_msg       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cola_fin_pendiente ON cola_financiera(empresa_id, estado, proximo_intento)
  WHERE estado IN ('pendiente','error');

ALTER TABLE cola_financiera ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cola_fin_empresa ON cola_financiera;
CREATE POLICY cola_fin_empresa ON cola_financiera
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE TABLE IF NOT EXISTS bloqueos_cliente (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE UNIQUE,
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  motivo      TEXT NOT NULL,
  deuda_monto NUMERIC(12,2),
  activo      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bloqueos_cliente ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bloqueos_empresa ON bloqueos_cliente;
CREATE POLICY bloqueos_empresa ON bloqueos_cliente
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bloqueado        BOOLEAN DEFAULT false;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bloqueado_motivo TEXT;

ALTER TABLE facturas ADD COLUMN IF NOT EXISTS pedido_id         UUID REFERENCES pedidos(id);
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS notif_3d_enviada  BOOLEAN DEFAULT false;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS notif_7d_enviada  BOOLEAN DEFAULT false;
ALTER TABLE facturas ADD COLUMN IF NOT EXISTS notif_15d_enviada BOOLEAN DEFAULT false;

-- ─── Trigger: encadenar cierre financiero cuando se confirma una entrega ───
CREATE OR REPLACE FUNCTION fn_cierre_financiero_entrega()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pedido     RECORD;
  v_empresa_id UUID;
  v_dias_cred  INT;
BEGIN
  IF NEW.estado <> 'entregado' OR OLD.estado = 'entregado' THEN RETURN NEW; END IF;

  SELECT p.*, c.dias_credito, r.empresa_id INTO v_pedido
  FROM pedidos p
  JOIN rutas r ON r.id = NEW.ruta_id
  JOIN clientes c ON c.id = p.cliente_id
  WHERE p.id = NEW.pedido_id;

  IF NOT FOUND THEN RETURN NEW; END IF;

  v_empresa_id := v_pedido.empresa_id;
  v_dias_cred  := COALESCE(v_pedido.dias_credito, 0);

  -- Encolar facturación
  INSERT INTO cola_financiera (empresa_id, tipo, referencia_id, payload)
  VALUES (v_empresa_id, 'facturar', NEW.pedido_id,
    jsonb_build_object(
      'pedido_id',   NEW.pedido_id,
      'cliente_id',  v_pedido.cliente_id,
      'total',       v_pedido.total,
      'dias_credito', v_dias_cred,
      'vence_en',    (CURRENT_DATE + v_dias_cred)::TEXT
    ));

  -- Encolar notificación de vencimiento (si tiene crédito)
  IF v_dias_cred > 0 THEN
    INSERT INTO cola_financiera (empresa_id, tipo, referencia_id, proximo_intento, payload)
    VALUES (v_empresa_id, 'notif_vencimiento', v_pedido.cliente_id,
      now() + (v_dias_cred - 3) * INTERVAL '1 day',
      jsonb_build_object('dias_vencimiento', v_dias_cred));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_cierre_financiero ON entregas;
CREATE TRIGGER tg_cierre_financiero
  AFTER UPDATE ON entregas
  FOR EACH ROW
  EXECUTE FUNCTION fn_cierre_financiero_entrega();
