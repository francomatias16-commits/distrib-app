-- 316_etapa_notif_fix_columnas_notif_log_y_reintento_email.sql
-- Hallazgo 2 (auditoría de notificaciones, "reenvío manual de emails"):
--
-- Al investigar por qué el botón de reenvío no tenía nada consistente para
-- reenviar, se encontró que notif_log.entregada y notif_log.motivo ya
-- existen en la base real de producción (se verificó con
-- information_schema.columns), pero NUNCA se agregaron con una migración
-- versionada — se aplicaron a mano en algún momento. El repo quedó
-- inconsistente: cualquiera que reconstruya la base desde cero con
-- `supabase/migrations/*.sql` (incluida 005_notif_log.sql, que solo tiene
-- las columnas originales) termina con una tabla notif_log a la que le
-- faltan estas dos columnas, y todo el código que las usa (pedidos.js,
-- proveedores.js, notif.js, notif-log.js) empieza a fallar en inserts o
-- selects.
--
-- Esta migración:
--   1. Agrega entregada/motivo de forma idempotente (IF NOT EXISTS), así
--      no rompe nada si ya existen (como en producción).
--   2. Deja el default de `entregada` en TRUE, igual al que ya tiene la
--      base real, para no romper los pocos inserts legados que no la
--      seteaban explícitamente.
--
-- Además, esta etapa corrige tres bugs de logueo de emails que dejaban a
-- ese "reenvío" sin nada real para reenviar (ver CHANGELOG correspondiente
-- para el detalle de cada uno):
--   - notificarDespachoPorEmail() (pedidos.js) nunca logueaba resultado.
--   - proveedores.js insertaba una columna resend_id que no existe en
--     notif_log (typo — la columna real es message_id) y el insert fallaba
--     en silencio porque el error de Supabase no se revisaba.
--   - handleEstadoCuenta() (notif.js) solo logueaba en email_log (tabla sin
--     entregada/motivo) y solo cuando el envío tenía éxito.

ALTER TABLE public.notif_log
  ADD COLUMN IF NOT EXISTS entregada BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.notif_log
  ADD COLUMN IF NOT EXISTS motivo TEXT;

COMMENT ON COLUMN public.notif_log.entregada IS
  'true = el envío fue confirmado por el proveedor (Meta/Resend/push); false = falló y motivo debería estar seteado. Ver Hallazgo 2, auditoría de notificaciones.';
COMMENT ON COLUMN public.notif_log.motivo IS
  'Motivo corto (código interno, no para mostrar tal cual) cuando entregada=false. Ej: sin_email, sin_telefono, error_envio, error_red.';

-- Índice para el filtro típico del panel de reintentos: emails fallidos de
-- la propia empresa, ordenados por fecha.
CREATE INDEX IF NOT EXISTS idx_notif_log_email_fallidos
  ON public.notif_log (empresa_id, created_at DESC)
  WHERE canal = 'email' AND entregada = false;
