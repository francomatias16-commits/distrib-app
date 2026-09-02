-- ════════════════════════════════════════════════════════════════════
-- 20260828070000_549_pref_nuevo_pedido_whatsapp_estancado_configurable.sql
--
-- Continuación de la 548: de los 3 tipos de push disparados por trigger
-- SQL directo a través de pushInternoHandler (api/notif/index.js) —
-- stock_critico, nuevo_pedido, whatsapp_estancado — la 548 cerró el caso
-- de stock_critico. Esta migración cierra los otros dos, mismo patrón:
--
--   nuevo_pedido (trigger_push_nuevo_pedido, migración 016): avisa a
--   dueño/admin/vendedor en cada pedido nuevo, sin excepción. En una
--   empresa con mucho volumen es ruido constante que nadie podía silenciar.
--
--   whatsapp_estancado (cron whatsapp_avisar_conversaciones_estancadas,
--   migración 437, corre cada 10 min): avisa cuando una conversación de
--   WhatsApp queda colgada 40+ min con un pedido en borrador. Tampoco
--   tenía forma de desactivarse.
--
-- Cambios:
--   a) notif_prefs_auto.pedido_nuevo_recibido (BOOLEAN, default TRUE) —
--      gatea nuevo_pedido.
--   b) notif_prefs_auto.whatsapp_conversacion_estancada (BOOLEAN, default
--      TRUE) — gatea whatsapp_estancado.
--   c) El chequeo en sí (pushInternoHandler → obtenerPrefsAuto, mapa
--      PREF_POR_TIPO_PUSH_INTERNO) y los toggles en /admin/automatizacion
--      van en el código de la app (ver lib/handlers/notif.js,
--      lib/handlers/automatizacion.js, frontend/admin/automatizacion.html)
--      — misma división que en la 548.
--
-- El umbral fijo de 40 min del cron de whatsapp_estancado queda tal cual
-- (no configurable por empresa) — fuera de alcance de esta migración,
-- que solo agrega el on/off. Ver PLAN_ERP_SINCRONIZACION_2026.md si se
-- retoma como mejora futura.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.notif_prefs_auto
  ADD COLUMN IF NOT EXISTS pedido_nuevo_recibido BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.notif_prefs_auto
  ADD COLUMN IF NOT EXISTS whatsapp_conversacion_estancada BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.notif_prefs_auto.pedido_nuevo_recibido IS
  '549: habilita/deshabilita el push de nuevo_pedido (trigger_push_nuevo_pedido, migración 016), disparado vía pushInternoHandler en api/notif/index.js. Default TRUE para no cambiar el comportamiento de empresas existentes.';

COMMENT ON COLUMN public.notif_prefs_auto.whatsapp_conversacion_estancada IS
  '549: habilita/deshabilita el push de whatsapp_estancado (cron whatsapp_avisar_conversaciones_estancadas, migración 437), disparado vía pushInternoHandler en api/notif/index.js. Default TRUE para no cambiar el comportamiento de empresas existentes.';

INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260828070000_549_pref_nuevo_pedido_whatsapp_estancado_configurable.sql',
  '549',
  'claude_assistant',
  '549: agrega notif_prefs_auto.pedido_nuevo_recibido y notif_prefs_auto.whatsapp_conversacion_estancada. Completa, junto con la 548, los 3 tipos de push disparados vía pushInternoHandler (api/notif/index.js) que no consultaban notif_prefs_auto — ahora los 3 (stock_critico, nuevo_pedido, whatsapp_estancado) respetan el toggle, igual que los tipos del motor notifAuto.'
)
ON CONFLICT DO NOTHING;
