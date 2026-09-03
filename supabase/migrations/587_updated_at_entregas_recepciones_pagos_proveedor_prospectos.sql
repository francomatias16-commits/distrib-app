-- 587_updated_at_entregas_recepciones_pagos_proveedor_prospectos.sql
-- Tercer lote de la regla "ítem modificado sube al tope".
--
-- Cierra lo que quedaba pendiente del Grupo C original (entregas,
-- recepciones_mercaderia, pagos_proveedor) y suma prospectos_competencia
-- del Grupo B (columna ya existía, faltaba el trigger).
--
--   - entregas: NO tenía updated_at, ni tampoco created_at para
--     backfillear con el mismo criterio de siempre. Se usa
--     COALESCE(fecha_confirmacion, now()) — no hay pantalla de listado
--     propia (siempre se ve anidada dentro de una ruta), así que el
--     trigger queda para el día que exista una, sin cambio de código.
--   - recepciones_mercaderia: NO tenía updated_at. Backfill desde
--     created_at. Sí tiene pantalla de listado (Historial de
--     recepciones, con y sin OCR) — se corrigió el ORDER BY.
--   - pagos_proveedor: NO tenía updated_at. Backfill desde created_at.
--     Tiene un listado (pagos de una factura), pero es un listado
--     financiero por fecha de pago dentro del detalle de una factura, no
--     una pantalla de listado editable — se agrega el trigger por
--     consistencia con el resto, pero el ORDER BY por fecha_pago se deja
--     sin tocar a propósito.
--   - prospectos_competencia: columna ya existía, solo faltaba el
--     trigger. Sí tiene pantalla de listado (bandeja de prospectos) —
--     se corrigió el ORDER BY.
--
-- Reutiliza la función genérica set_updated_at() (existe desde
-- 006_logistica.sql, search_path ya fijado en 126_fix_search_path).
--
-- Aplicada en producción vía Supabase MCP el 2026-09-03 (esta vez sí con
-- apply_migration, queda trackeada en el historial interno de Supabase
-- desde el vamos). Este archivo es el registro para el repo — no volver a
-- ejecutar contra la misma base (los ALTER TABLE / DROP+CREATE TRIGGER
-- son idempotentes; el INSERT de registro del final no lo es).

-- ── entregas: agregar columna + backfill + trigger ──────────────────────────
ALTER TABLE public.entregas ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.entregas
SET updated_at = COALESCE(fecha_confirmacion, now())
WHERE updated_at IS NULL;

ALTER TABLE public.entregas
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS trg_entregas_updated_at ON public.entregas;
CREATE TRIGGER trg_entregas_updated_at
  BEFORE UPDATE ON public.entregas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── recepciones_mercaderia: agregar columna + backfill + trigger ───────────
ALTER TABLE public.recepciones_mercaderia ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.recepciones_mercaderia
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE public.recepciones_mercaderia
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS trg_recepciones_mercaderia_updated_at ON public.recepciones_mercaderia;
CREATE TRIGGER trg_recepciones_mercaderia_updated_at
  BEFORE UPDATE ON public.recepciones_mercaderia
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── pagos_proveedor: agregar columna + backfill + trigger ───────────────────
ALTER TABLE public.pagos_proveedor ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.pagos_proveedor
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE public.pagos_proveedor
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS trg_pagos_proveedor_updated_at ON public.pagos_proveedor;
CREATE TRIGGER trg_pagos_proveedor_updated_at
  BEFORE UPDATE ON public.pagos_proveedor
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── prospectos_competencia: columna ya existía, solo faltaba el trigger ────
DROP TRIGGER IF EXISTS trg_prospectos_competencia_updated_at ON public.prospectos_competencia;
CREATE TRIGGER trg_prospectos_competencia_updated_at
  BEFORE UPDATE ON public.prospectos_competencia
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Registro manual de versionado (mismo patrón que el resto del proyecto)
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '587_updated_at_entregas_recepciones_pagos_proveedor_prospectos.sql',
  '587',
  'claude-session',
  'Tercer lote de la regla "ítem modificado sube al tope": agrega updated_at+backfill a entregas/recepciones_mercaderia/pagos_proveedor (no existía), y trigger set_updated_at() faltante en prospectos_competencia. Cierra el Grupo C original (entregas, recepciones_mercaderia, pagos_proveedor). ORDER BY corregido en recepciones_mercaderia y prospectos_competencia; entregas no tiene listado propio (queda el trigger por consistencia); pagos_proveedor mantiene el orden por fecha_pago a propósito.'
);
