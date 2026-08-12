-- ─────────────────────────────────────────────────────────────────────────
-- Sincronización automática cheques.vencimiento <-> cheques.fecha_vto
--
-- Mismo patrón que fn_facturas_sync_vencimiento (migración 094), pero para
-- 'cheques'. Hasta ahora esas dos columnas solo se mantenían sincronizadas
-- a mano en cheques.js (UI manual); el wizard de migración masiva
-- (migracion_confirmar_cheques_lote, migración 174) solo escribe
-- 'fecha_vto', dejando 'vencimiento' en NULL. Esto causaba que alertas y
-- reportes que filtraban por 'vencimiento' perdieran cheques cargados por
-- migración (ver CHANGELOG_v262).
--
-- Aplicada directamente en producción (proyecto jgiquzjwoedmzwqgzubr) el
-- 2026-07-09. Este archivo la deja versionada en el repo.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Backfill de filas existentes con las columnas desincronizadas
UPDATE public.cheques
SET vencimiento = fecha_vto
WHERE vencimiento IS NULL AND fecha_vto IS NOT NULL;

UPDATE public.cheques
SET fecha_vto = vencimiento
WHERE fecha_vto IS NULL AND vencimiento IS NOT NULL;

-- 2. Trigger de sincronización permanente (INSERT y UPDATE)
CREATE OR REPLACE FUNCTION public.fn_cheques_sync_vencimiento()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.vencimiento IS DISTINCT FROM OLD.vencimiento
     AND (NEW.fecha_vto IS NOT DISTINCT FROM OLD.fecha_vto) THEN
    NEW.fecha_vto := NEW.vencimiento;
  END IF;
  IF NEW.fecha_vto IS DISTINCT FROM OLD.fecha_vto
     AND (NEW.vencimiento IS NOT DISTINCT FROM OLD.vencimiento) THEN
    NEW.vencimiento := NEW.fecha_vto;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cheques_sync_vencimiento ON public.cheques;
CREATE TRIGGER trg_cheques_sync_vencimiento
  BEFORE INSERT OR UPDATE ON public.cheques
  FOR EACH ROW EXECUTE FUNCTION public.fn_cheques_sync_vencimiento();

COMMENT ON COLUMN public.cheques.fecha_vto IS
  'Columna original (NOT NULL, con índice). Sincronizada automáticamente '
  'con "vencimiento" vía trigger trg_cheques_sync_vencimiento (antes se '
  'sincronizaba a mano solo desde cheques.js).';

COMMENT ON COLUMN public.cheques.vencimiento IS
  'Alias legible de fecha_vto. Sincronizada automáticamente vía trigger '
  'trg_cheques_sync_vencimiento — ya no depende de que cada código de '
  'escritura (ej. el wizard de migración) la complete a mano.';
