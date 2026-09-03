-- 586_updated_at_rutas_cheques_proveedores_oc_presupuestos_devoluciones.sql
-- Segundo lote de la regla de negocio: en las pantallas de listado del
-- admin, el ítem modificado/creado debe subir al tope (orden por
-- updated_at DESC). Segundo lote: rutas, cheques, proveedores,
-- ordenes_compra, presupuestos, devoluciones.
--
-- Estado previo (auditado 1 a 1 contra prod vía MCP):
--   - proveedores, ordenes_compra, presupuestos: YA tenían columna
--     updated_at pero NINGÚN trigger la mantenía al día. Solo se agrega
--     el trigger.
--   - rutas, cheques, devoluciones: NO tenían columna updated_at. Se
--     agrega, se hace backfill desde created_at (no había una fecha de
--     referencia "de negocio" más apropiada, mismo criterio que se usó
--     con cobros en la migración 584), y se agrega el trigger.
--
-- Reutiliza la función genérica set_updated_at() (existe desde
-- 006_logistica.sql, search_path ya fijado en 126_fix_search_path).
--
-- El ORDER BY de fn_cheques_lista queda SIN CAMBIAR a propósito: ordena
-- por fecha de vencimiento (uso operativo distinto — ver primero lo que
-- vence antes), y cambiarlo a "último modificado" le haría perder esa
-- utilidad. El trigger de todos modos se agrega, por si en el futuro se
-- necesita para otra pantalla.
--
-- Aplicada en producción vía Supabase MCP el 2026-09-03. Este archivo es
-- el registro para el repo — no volver a ejecutar contra la misma base
-- (los ALTER TABLE / DROP+CREATE TRIGGER son idempotentes igual, por las
-- dudas, gracias a IF NOT EXISTS / DROP TRIGGER IF EXISTS; la única parte
-- NO idempotente es el INSERT de registro del final).

-- ── rutas: agregar columna + backfill + trigger ─────────────────────────────
ALTER TABLE public.rutas ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.rutas
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE public.rutas
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS trg_rutas_updated_at ON public.rutas;
CREATE TRIGGER trg_rutas_updated_at
  BEFORE UPDATE ON public.rutas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── cheques: agregar columna + backfill + trigger ───────────────────────────
ALTER TABLE public.cheques ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.cheques
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE public.cheques
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS trg_cheques_updated_at ON public.cheques;
CREATE TRIGGER trg_cheques_updated_at
  BEFORE UPDATE ON public.cheques
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── devoluciones: agregar columna + backfill + trigger ──────────────────────
ALTER TABLE public.devoluciones ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.devoluciones
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE public.devoluciones
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS trg_devoluciones_updated_at ON public.devoluciones;
CREATE TRIGGER trg_devoluciones_updated_at
  BEFORE UPDATE ON public.devoluciones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── proveedores: columna ya existía, solo faltaba el trigger ────────────────
DROP TRIGGER IF EXISTS trg_proveedores_updated_at ON public.proveedores;
CREATE TRIGGER trg_proveedores_updated_at
  BEFORE UPDATE ON public.proveedores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── ordenes_compra: columna ya existía, solo faltaba el trigger ─────────────
DROP TRIGGER IF EXISTS trg_ordenes_compra_updated_at ON public.ordenes_compra;
CREATE TRIGGER trg_ordenes_compra_updated_at
  BEFORE UPDATE ON public.ordenes_compra
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── presupuestos: columna ya existía, solo faltaba el trigger ───────────────
DROP TRIGGER IF EXISTS trg_presupuestos_updated_at ON public.presupuestos;
CREATE TRIGGER trg_presupuestos_updated_at
  BEFORE UPDATE ON public.presupuestos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Registro manual de versionado (mismo patrón que el resto del proyecto)
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '586_updated_at_rutas_cheques_proveedores_oc_presupuestos_devoluciones.sql',
  '586',
  'claude-session',
  'Segundo lote de la regla "ítem modificado sube al tope": agrega updated_at+backfill a rutas/cheques/devoluciones (no existía), y trigger set_updated_at() faltante en proveedores/ordenes_compra/presupuestos. El ORDER BY de fn_cheques_lista queda sin cambiar a propósito (ordena por vencimiento, uso operativo distinto).'
);
-- Nota: esta fila YA fue insertada en producción cuando se aplicó este
-- lote (2026-09-03). Si bajás este archivo a supabase/migrations/ tal
-- cual y alguna vez lo volvés a correr contra la MISMA base de prod, vas
-- a duplicar esta fila de registro (no tiene UNIQUE sobre `archivo`). No
-- afecta el resto de la migración (todo lo demás es idempotente). Contra
-- una base nueva (otro entorno) no hay problema, corre una sola vez.
