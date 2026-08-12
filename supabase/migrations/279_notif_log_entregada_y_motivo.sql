-- 279_notif_log_entregada_y_motivo.sql
--
-- [reconstruido retroactivamente desde el estado real de producción — el
--  archivo original vivía en db/, carpeta ausente en los exports/zips del
--  repo. Columnas verificadas contra information_schema.columns de la
--  base viva: notif_log.entregada boolean NOT NULL default true,
--  notif_log.motivo text nullable.]
--
-- Fix blind spot detectado en simulación exhaustiva de alertas críticas
-- (2026-07-12): enviarPush() y notifAuto() solo logueaban en notif_log
-- cuando el envío tenía éxito. Un intento fallido (sin dispositivos, token
-- vencido, tipo deshabilitado) desaparecía sin dejar rastro. Se agregan
-- columnas entregada/motivo para loguear siempre.

BEGIN;

ALTER TABLE public.notif_log
  ADD COLUMN IF NOT EXISTS entregada boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS motivo    text;

COMMENT ON COLUMN public.notif_log.entregada IS
  'false cuando el intento de notificación no llegó a enviarse (sin '
  'dispositivos registrados, token vencido, tipo de notificación '
  'deshabilitado por el usuario, etc). Antes de esta migración esos '
  'intentos fallidos no dejaban ningún rastro en la tabla.';
COMMENT ON COLUMN public.notif_log.motivo IS
  'Motivo del fallo cuando entregada = false. NULL cuando entregada = true.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '279_notif_log_entregada_y_motivo.sql', '279', 'claude-session',
  'Fix blind spot detectado en simulación exhaustiva de alertas críticas (2026-07-12): '
  'enviarPush() y notifAuto() solo logueaban en notif_log cuando el envío tenía éxito. '
  'Un intento fallido (sin dispositivos, token vencido, tipo deshabilitado) desaparecía '
  'sin dejar rastro. Se agregan columnas entregada/motivo para loguear siempre.')
ON CONFLICT DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
