-- 449_cantidades_solo_enteros_paso2_stock.sql
-- Ya aplicada en producción el 2026-08-09 (Supabase migration
-- 20260809211845 "690_cantidades_solo_enteros_paso2_stock").
-- Se agrega al repo por trazabilidad; NO reaplicar manualmente.
--
-- Contexto: se elimina la excepción de decimales para productos
-- vendidos por peso (unidad='kg') introducida en la migración 165
-- (165_validacion_cantidad_entera_unidad.sql). A partir de acá TODAS
-- las cantidades del sistema son enteras, sin excepción. Verificado
-- contra la base real que no había datos fraccionarios cargados en
-- ninguna columna de cantidad antes de aplicar este cambio.

BEGIN;

-- Estos dos triggers de stock referencian la columna "cantidad" de forma
-- compilada (WHEN / UPDATE OF) y bloquean el ALTER TYPE. Se recrean
-- idénticos después del cambio.
DROP TRIGGER IF EXISTS trg_audit_stock ON public.stock;
DROP TRIGGER IF EXISTS trg_push_stock_critico ON public.stock;
DROP TRIGGER IF EXISTS trg_stock_cantidad_entera ON public.stock;

ALTER TABLE public.stock DROP COLUMN cantidad_disponible;

ALTER TABLE public.stock
  ALTER COLUMN cantidad          TYPE integer USING round(cantidad)::integer,
  ALTER COLUMN cantidad_reservada TYPE integer USING round(cantidad_reservada)::integer;

ALTER TABLE public.stock
  ADD COLUMN cantidad_disponible integer
  GENERATED ALWAYS AS (GREATEST(COALESCE(cantidad, 0) - COALESCE(cantidad_reservada, 0), 0)) STORED;

CREATE TRIGGER trg_audit_stock AFTER UPDATE ON public.stock FOR EACH ROW
  WHEN ((old.cantidad IS DISTINCT FROM new.cantidad) OR (old.cantidad_reservada IS DISTINCT FROM new.cantidad_reservada))
  EXECUTE FUNCTION fn_audit_generic();

CREATE TRIGGER trg_push_stock_critico AFTER UPDATE OF cantidad ON public.stock FOR EACH ROW
  EXECUTE FUNCTION trigger_push_stock_critico();

COMMENT ON COLUMN public.stock.cantidad IS
  'Cantidad en stock. Entero desde 2026-08-09 (migración 690): ya no hay excepción para productos vendidos por peso (unidad=kg) — no se pueden cargar fracciones de kilo.';

COMMIT;
