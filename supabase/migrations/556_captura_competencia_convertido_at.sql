-- =============================================================
-- 556_captura_competencia_convertido_at.sql
--
-- PLAN_CAPTURA_COMPETENCIA.md, 1.7 (Entregable Fase 1) — métrica de
-- éxito del piloto: % de capturas que terminan en pedido convertido, y
-- tiempo promedio foto→cierre. Lo primero se calcula contando estados
-- (fecha_captura ya existe, migración 551); lo segundo necesita un
-- timestamp de cuándo se convirtió, que hoy no existe.
--
-- Se fija en marcarCapturaConvertida() (lib/repos/captura-competencia.js),
-- no en el handler, para que quede escrito por la misma fila que ya
-- pasa estado -> 'convertido_pedido' — no hay forma de que uno se
-- actualice sin el otro.
-- =============================================================

ALTER TABLE public.captura_competencia
  ADD COLUMN IF NOT EXISTS convertido_at timestamptz;

COMMENT ON COLUMN public.captura_competencia.convertido_at IS
  'Timestamp en que la captura pasó a estado convertido_pedido. Usado '
  'para la métrica de éxito del piloto (tiempo promedio foto->cierre = '
  'convertido_at - fecha_captura). Null mientras no esté convertida.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '556_captura_competencia_convertido_at.sql', '556', 'claude-session',
  'Backfill de Fase 1 (plan 1.7): la columna convertido_at nunca se había aplicado en producción -- el 553 real de producción fue captura_competencia_pedido_id, no este archivo. Renumerado de 553 a 556 para no chocar con la numeración ya usada en producción (551-554 ya existen con otro contenido/nombres).')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
