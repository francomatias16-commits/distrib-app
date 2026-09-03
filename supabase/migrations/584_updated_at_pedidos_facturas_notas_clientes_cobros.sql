-- 584_updated_at_pedidos_facturas_notas_clientes_cobros.sql
-- Regla de negocio: en las pantallas de listado del admin, el ítem
-- modificado/creado debe subir al tope (orden por updated_at DESC).
-- Primer lote: pedidos, facturas, notas_credito, clientes, cobros.
--
-- Estado previo (auditado 1 a 1 contra prod vía MCP):
--   - pedidos, notas_credito, clientes: YA tenían columna updated_at
--     pero NINGÚN trigger la mantenía al día — dependía de que cada
--     endpoint la seteara a mano en el UPDATE (inconsistente, la
--     mayoría no lo hacía). Solo se agrega el trigger.
--   - facturas, cobros: NO tenían columna updated_at. Se agrega,
--     se hace backfill desde la fecha de referencia existente
--     (fecha_emision / fecha) para no romper el orden histórico,
--     y se agrega el trigger.
--
-- Reutiliza la función genérica set_updated_at() (existe desde
-- 006_logistica.sql, search_path ya fijado en 126_fix_search_path).
--
-- Aplicada en producción vía Supabase MCP el 2026-09-03. Este archivo es
-- el registro para el repo — no volver a ejecutar contra la misma base
-- (los ALTER TABLE / DROP+CREATE TRIGGER son idempotentes igual, por las
-- dudas, gracias a IF NOT EXISTS / DROP TRIGGER IF EXISTS).

-- ── facturas: agregar columna + backfill + trigger ──────────────────────────
ALTER TABLE public.facturas ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.facturas
SET updated_at = COALESCE(fecha_emision, now())
WHERE updated_at IS NULL;

ALTER TABLE public.facturas
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS trg_facturas_updated_at ON public.facturas;
CREATE TRIGGER trg_facturas_updated_at
  BEFORE UPDATE ON public.facturas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── cobros: agregar columna + backfill + trigger ────────────────────────────
ALTER TABLE public.cobros ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.cobros
SET updated_at = COALESCE(fecha, now())
WHERE updated_at IS NULL;

ALTER TABLE public.cobros
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DROP TRIGGER IF EXISTS trg_cobros_updated_at ON public.cobros;
CREATE TRIGGER trg_cobros_updated_at
  BEFORE UPDATE ON public.cobros
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── pedidos: columna ya existía, solo faltaba el trigger ────────────────────
DROP TRIGGER IF EXISTS trg_pedidos_updated_at ON public.pedidos;
CREATE TRIGGER trg_pedidos_updated_at
  BEFORE UPDATE ON public.pedidos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── notas_credito: columna ya existía, solo faltaba el trigger ──────────────
DROP TRIGGER IF EXISTS trg_notas_credito_updated_at ON public.notas_credito;
CREATE TRIGGER trg_notas_credito_updated_at
  BEFORE UPDATE ON public.notas_credito
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── clientes: columna ya existía, solo faltaba el trigger ───────────────────
DROP TRIGGER IF EXISTS trg_clientes_updated_at ON public.clientes;
CREATE TRIGGER trg_clientes_updated_at
  BEFORE UPDATE ON public.clientes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Registro manual de versionado (mismo patrón que el resto del proyecto)
INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '584_updated_at_pedidos_facturas_notas_clientes_cobros.sql',
  '584',
  'claude-session',
  'Regla "ítem modificado sube al tope": agrega updated_at+backfill a facturas y cobros (no existía), y agrega trigger set_updated_at() faltante en pedidos, notas_credito y clientes (la columna ya existía pero nada la mantenía al día). Primer lote de la migración global a orden por updated_at DESC en todas las pantallas del admin.'
);
-- Nota: schema_migrations_registry no tiene UNIQUE sobre (archivo), así que
-- si corrés este archivo dos veces vas a duplicar la fila de registro. No
-- afecta el resto de la migración (todo lo demás es idempotente).
