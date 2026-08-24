-- =============================================================
-- 20260818_sync06_eventos_negocio_claim_atomico_outbox.sql
-- Auditoría Integral 2026 — SYNC-06
--
-- Problema (ver Matriz de hallazgos — Auditoría Integral 2026):
--   - despacharPendientes() lee eventos 'pendiente' con un SELECT y los
--     procesa uno por uno en un loop; no hay ningún claim atómico. Dos
--     barridos concurrentes (dos requests que disparan el despacho
--     inmediato casi al mismo tiempo, o un futuro cron superpuesto con un
--     despacho inmediato) pueden leer el mismo evento antes de que
--     cualquiera de los dos termine de procesarlo, y ejecutar sus
--     listeners/reglas dos veces.
--   - No existe reintento durable ni dead-letter: un evento que queda en
--     'error' se vuelve a intentar entero (con incluirErrores=true) para
--     siempre, sin backoff ni límite, o se ignora para siempre si nadie
--     pasa incluirErrores=true — no hay un punto intermedio.
--
-- Esta migración agrega lo mínimo de esquema para que el código pueda
-- reclamar un evento de forma atómica (UPDATE condicional, no SELECT+UPDATE)
-- y llevar la cuenta de intentos con un lease por si un worker se cae a
-- mitad de camino con el evento en 'procesando'.

ALTER TABLE public.eventos_negocio
  DROP CONSTRAINT IF EXISTS eventos_negocio_estado_check;

ALTER TABLE public.eventos_negocio
  ADD CONSTRAINT eventos_negocio_estado_check
  CHECK (estado IN ('pendiente', 'procesando', 'procesado', 'error'));

ALTER TABLE public.eventos_negocio
  ADD COLUMN IF NOT EXISTS intentos INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS procesando_desde TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ultimo_error TEXT;

COMMENT ON COLUMN public.eventos_negocio.intentos IS
  'Cantidad de veces que se intentó despachar este evento. Usado para backoff simple: por arriba de EVENTOS_MAX_INTENTOS (lib/eventos-dispatcher.js) el evento queda en error terminal y despacharPendientes(incluirErrores=true) deja de recogerlo.';
COMMENT ON COLUMN public.eventos_negocio.procesando_desde IS
  'Timestamp del claim atómico que puso este evento en estado procesando. Si pasa el lease (EVENTOS_LEASE_MS) sin volver a pendiente/procesado/error, se considera un worker caído y vuelve a quedar disponible para reclamar.';
COMMENT ON COLUMN public.eventos_negocio.ultimo_error IS
  'Mensaje del último error de despacho, para diagnóstico en el panel de observabilidad. No reemplaza el detalle por-listener que ya se loguea con console.error.';

CREATE INDEX IF NOT EXISTS idx_eventos_negocio_procesando_lease
  ON public.eventos_negocio(procesando_desde)
  WHERE estado = 'procesando';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '20260818_sync06_eventos_negocio_claim_atomico_outbox.sql', '20260818b', 'claude-session',
        'SYNC-06 (Auditoría Integral 2026): agrega estado procesando + columnas intentos/procesando_desde/ultimo_error a eventos_negocio para que el despachador (lib/eventos-dispatcher.js) pueda reclamar eventos con UPDATE condicional en vez de SELECT+loop, y reintentar con límite/lease en vez de para siempre o nunca.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
