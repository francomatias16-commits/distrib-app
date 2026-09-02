-- ============================================================
-- 20260831000002_568_fix_dispositivos_push_token_index_no_partial.sql
--
-- Fix de 567: el índice único de 567 (idx_dispositivos_push_token) se
-- creó PARCIAL (WHERE token_push IS NOT NULL), pero el upsert real de
-- upsertDispositivoPush() en lib/repos/notif.js usa:
--   .from('dispositivos_push').upsert(datos, { onConflict: 'token_push' })
-- sin repetir el predicado del WHERE. Postgres no resuelve un ON CONFLICT
-- simple contra un índice único parcial salvo que el INSERT ... ON
-- CONFLICT incluya el mismo WHERE — con onConflict:'token_push' a secas
-- seguía fallando con el mismo error que 567 debía resolver:
--   "there is no unique or exclusion constraint matching the
--    ON CONFLICT specification"
--
-- Fix: reemplazar el índice único parcial por uno no parcial. Los NULL
-- en token_push (filas viejas Web Push, sin FCM) son compatibles con un
-- índice único común en Postgres — NULL nunca choca contra NULL — así
-- que sacar el WHERE no reintroduce el problema que 567 quiso evitar.
-- ============================================================

DROP INDEX IF EXISTS public.idx_dispositivos_push_token;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispositivos_push_token
  ON public.dispositivos_push(token_push);

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260831000002_568_fix_dispositivos_push_token_index_no_partial.sql',
  '568',
  'claude_assistant',
  'Fix de 567: el índice único era PARCIAL (WHERE token_push IS NOT NULL), y Postgres no lo usa para resolver ON CONFLICT (token_push) simple sin repetir el predicado. Reemplazado por índice único no parcial (los NULL ya son compatibles con un índice único común en Postgres).'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
