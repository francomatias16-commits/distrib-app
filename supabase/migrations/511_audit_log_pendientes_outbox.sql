-- Punto 8 (Fase A, auditoría financiera 2026): auditoría durable para
-- escrituras financieras (ventas POS, pagos a proveedores, cobros vía
-- Mercado Pago). `registrarAuditoriaSilenciosa` (lib/repos/audit.js)
-- descarta el error en silencio si el INSERT en `audit_log` falla — bien
-- para auditoría de UI (config, favoritos, promociones), pero para "dinero
-- real moviéndose" perder el registro de auditoría sin dejar rastro no es
-- aceptable.
--
-- `audit_log_pendientes` es el outbox: si `registrarAuditoriaFinancieraDurable`
-- (lib/repos/audit.js) no puede insertar directo en `audit_log`, encola acá
-- en vez de descartar. Mismo patrón de claim atómico + lease + tope de
-- reintentos que `eventos_negocio` (lib/eventos-dispatcher.js) y el outbox
-- de salientes de WhatsApp (`whatsapp_mensajes.metadata`, v657).
--
-- NOTA (reconstrucción): esta migración ya estaba aplicada en producción
-- pero el archivo no había quedado versionado en el repo. Se reconstruye
-- desde el esquema real (information_schema + pg_indexes) — mismo gap ya
-- documentado para la migración 509.

CREATE TABLE public.audit_log_pendientes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL,
  usuario_id       uuid,
  tabla            text NOT NULL,
  accion           text NOT NULL,
  registro_id      text,
  datos_antes      jsonb,
  datos_despues    jsonb,
  -- 'pendiente' → 'procesando' (claim con lease) → 'procesado' | 'error'
  -- (dead-letter tras agotar el tope de reintentos, mismo criterio que
  -- eventos_negocio.estado).
  estado           text NOT NULL DEFAULT 'pendiente',
  intentos         integer NOT NULL DEFAULT 1,
  procesando_desde timestamptz,
  ultimo_error     text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Barrido del cron de reproceso: candidatos por estado, ordenados por
-- antigüedad.
CREATE INDEX idx_audit_log_pendientes_estado_created
  ON public.audit_log_pendientes (estado, created_at);

-- Detección de leases vencidos (worker que tomó el claim y se cayó antes
-- de terminar) — parcial porque solo interesa mientras estado='procesando'.
CREATE INDEX idx_audit_log_pendientes_procesando_lease
  ON public.audit_log_pendientes (procesando_desde)
  WHERE estado = 'procesando';

-- Panel de auditoría / soporte: pendientes de una empresa puntual.
CREATE INDEX idx_audit_log_pendientes_empresa
  ON public.audit_log_pendientes (empresa_id, created_at DESC);

-- RLS habilitado sin políticas: acceso exclusivo vía service_role (bypassa
-- RLS), igual que audit_log — ni anon ni authenticated tienen grants sobre
-- la tabla ni motivo para leerla directo.
ALTER TABLE public.audit_log_pendientes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.audit_log_pendientes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.audit_log_pendientes TO service_role;
