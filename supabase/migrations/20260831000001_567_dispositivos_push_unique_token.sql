-- ============================================================
-- 20260831000001_567_dispositivos_push_unique_token.sql
--
-- lib/repos/notif.js → upsertDispositivoPush() hace:
--   .from('dispositivos_push').upsert(datos, { onConflict: 'token_push' })
-- (usado por POST /notif/push, registrarDispositivo — alta de token FCM
-- desde el frontend en cada login/renovación de token).
--
-- Pero dispositivos_push NUNCA tuvo un índice/constraint único sobre
-- token_push — 010_etapa7_fidelizacion.sql solo definió un índice NO
-- único sobre usuario_id, y 052/053 agregaron un índice único, pero
-- sobre `endpoint` (Web Push VAPID), no sobre `token_push` (FCM).
-- Como Postgres exige que el ON CONFLICT target matchee un índice
-- único/exclusion constraint existente, TODA alta de token FCM vía
-- este endpoint falla con:
--   "there is no unique or exclusion constraint matching the
--    ON CONFLICT specification"
-- (reproducido por test-integration.js T43).
--
-- Fix: índice único parcial sobre token_push (mismo patrón que el de
-- endpoint en 053) — parcial porque token_push puede repetirse como
-- NULL en filas viejas que solo tengan endpoint (Web Push).
-- ============================================================

DROP INDEX IF EXISTS public.idx_dispositivos_push_token;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispositivos_push_token
  ON public.dispositivos_push(token_push)
  WHERE token_push IS NOT NULL;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260831000001_567_dispositivos_push_unique_token.sql',
  '567',
  'claude_assistant',
  'Agrega índice único parcial dispositivos_push(token_push) WHERE NOT NULL — faltaba, y upsertDispositivoPush() en lib/repos/notif.js ya usaba onConflict:"token_push", lo que fallaba en producción para todo alta de token push FCM (mismo síntoma que test-integration.js T43).'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
