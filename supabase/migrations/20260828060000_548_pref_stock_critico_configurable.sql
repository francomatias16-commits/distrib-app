-- ════════════════════════════════════════════════════════════════════
-- 20260828060000_548_pref_stock_critico_configurable.sql
--
-- Diagnóstico (2026-08-28, seguimiento de la 547): de los tipos de push
-- que dispara pushInternoHandler (api/notif/index.js) vía trigger SQL
-- directo — stock_critico, nuevo_pedido, whatsapp_estancado — ninguno
-- consulta notif_prefs_auto, a diferencia de los ~8 tipos que pasan por
-- notifAuto() (_auto-push.js) y sí respetan el toggle que el dueño ve en
-- /admin/automatizacion. Resultado: el dueño podía "apagar" la alerta de
-- stock crítico en la UI (si hubiera un toggle) y el push seguiría
-- llegando igual, porque el trigger de Postgres pega directo a
-- push-interno sin pasar por ninguna preferencia.
--
-- Este fix cierra el caso de stock_critico (el más directamente
-- relacionado con el trabajo de la 547 sobre ese mismo trigger).
-- nuevo_pedido y whatsapp_estancado quedan pendientes como mejora
-- futura, mismo patrón a seguir (agregar columna + mapear en
-- PREF_POR_TIPO_PUSH_INTERNO en lib/handlers/notif.js).
--
-- Cambios:
--   a) notif_prefs_auto.stock_critico_bajo (BOOLEAN, default TRUE) —
--      nueva columna, mismo patrón que stock_quiebre/stock_sin_proveedor
--      (migraciones 037/243).
--   b) El chequeo en sí (pushInternoHandler → obtenerPrefsAuto) y el
--      toggle en /admin/automatizacion van en el código de la app, no acá
--      (ver lib/handlers/notif.js, lib/handlers/automatizacion.js,
--      frontend/admin/automatizacion.html).
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.notif_prefs_auto
  ADD COLUMN IF NOT EXISTS stock_critico_bajo BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.notif_prefs_auto.stock_critico_bajo IS
  '548: habilita/deshabilita el push de stock_critico (trigger_push_stock_critico, migración 016/547, disparado vía pushInternoHandler en api/notif/index.js). Default TRUE para no cambiar el comportamiento de empresas existentes.';

INSERT INTO schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260828060000_548_pref_stock_critico_configurable.sql',
  '548',
  'claude_assistant',
  '548: agrega notif_prefs_auto.stock_critico_bajo. pushInternoHandler (api/notif/index.js) no consultaba notif_prefs_auto para ningún tipo disparado por trigger SQL directo (stock_critico, nuevo_pedido, whatsapp_estancado) — ahora stock_critico respeta el toggle, igual que los tipos del motor notifAuto. nuevo_pedido y whatsapp_estancado quedan pendientes, mismo patrón.'
)
ON CONFLICT DO NOTHING;
