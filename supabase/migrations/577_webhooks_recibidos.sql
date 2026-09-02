-- 577_webhooks_recibidos.sql
-- Motor de Integraciones/Webhooks — generalización.
--
-- CONTEXTO (auditoría de código, no de memoria): Mercado Pago y WhatsApp ya
-- tenían webhooks entrantes sólidos por separado — verificación de firma
-- HMAC (x-signature / x-hub-signature-256, fail-closed) e idempotencia
-- puntual (CAS sobre transacciones_pago, UNIQUE sobre wa_message_id). Lo que
-- faltaba no era seguridad ni idempotencia — era un lugar ÚNICO para ver
-- todos los webhooks recibidos entre integraciones, con reintentos cuando
-- el procesamiento posterior a la firma falla (ej: un insert que revienta
-- por un problema transitorio de DB no debería perder el evento).
--
-- Esta tabla NO reemplaza la idempotencia específica de cada integración
-- (payment_id, wa_message_id) — esa sigue siendo la fuente de verdad para
-- "¿ya lo procesé de negocio?". webhooks_recibidos es la capa de
-- observabilidad + dedupe genérico + cola de reintento por encima de eso.
-- ARCA/AFIP queda afuera a propósito: no recibe webhooks entrantes (la
-- integración es 100% saliente, nosotros llamamos a sus servicios).

CREATE TABLE IF NOT EXISTS webhooks_recibidos (
  id                 BIGSERIAL   PRIMARY KEY,
  integracion        TEXT        NOT NULL CHECK (integracion IN ('mercadopago', 'whatsapp')),
  evento_externo_id  TEXT        NOT NULL,   -- payment_id / order_id (MP) o wa_message_id (WhatsApp)
  tipo               TEXT,                   -- 'payment' | 'order' | 'mensaje' | 'account_update' | etc.
  empresa_id         UUID        REFERENCES empresas(id) ON DELETE SET NULL,
  payload            JSONB       NOT NULL,
  headers            JSONB,
  firma_valida       BOOLEAN     NOT NULL DEFAULT true,
  estado             TEXT        NOT NULL DEFAULT 'procesado' CHECK (estado IN ('procesado', 'error')),
  intentos           INT         NOT NULL DEFAULT 1,
  ultimo_error       TEXT,
  recibido_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Dedupe genérico a nivel de base: si el proveedor reintenta el mismo
  -- evento (Meta y MP los dos reintentan ante timeouts), el segundo insert
  -- choca acá — el handler lo trata como "ya recibido" sin duplicar trabajo.
  UNIQUE (integracion, evento_externo_id)
);

CREATE INDEX IF NOT EXISTS idx_webhooks_recibidos_error
  ON webhooks_recibidos (integracion, recibido_at)
  WHERE estado = 'error';

CREATE INDEX IF NOT EXISTS idx_webhooks_recibidos_empresa
  ON webhooks_recibidos (empresa_id, recibido_at DESC)
  WHERE empresa_id IS NOT NULL;

-- ─────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────
ALTER TABLE webhooks_recibidos ENABLE ROW LEVEL SECURITY;

-- Solo dueno/admin de la empresa pueden ver sus propios eventos.
-- Filas sin empresa_id resuelta (ej: webhook de MP sin user_id resoluble)
-- quedan visibles solo para service_role (no matchean ninguna policy de
-- usuario), consistente con que son datos de diagnóstico de plataforma.
CREATE POLICY "webhooks_recibidos_select" ON webhooks_recibidos
  FOR SELECT
  USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- Las escrituras las hace únicamente el backend con la service key (que
-- bypassea RLS) — no hay policy de INSERT/UPDATE para roles de usuario,
-- y no hay policy de DELETE en absoluto (append-only, igual que audit_log).

-- ─────────────────────────────────────────────
-- FUNCIÓN HELPER: marcar error + incrementar intentos (atómico)
-- ─────────────────────────────────────────────
-- Evita el race de leer intentos en JS, sumar 1 y escribir de vuelta —
-- con dos reintentos casi simultáneos del mismo evento (poco probable
-- pero posible) uno pisaría el conteo del otro.
CREATE OR REPLACE FUNCTION fn_webhook_marcar_error(p_id BIGINT, p_error TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE webhooks_recibidos
  SET estado = 'error',
      intentos = intentos + 1,
      ultimo_error = p_error,
      actualizado_at = now()
  WHERE id = p_id;
$$;

COMMENT ON TABLE webhooks_recibidos IS
  'Log genérico + dedupe + cola de reintento para webhooks entrantes de '
  'integraciones externas (Mercado Pago, WhatsApp). Ver lib/utils/webhooks-log.js. '
  'No reemplaza la idempotencia de negocio de cada integración, la complementa.';
