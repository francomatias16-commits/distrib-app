-- ============================================================
-- 119b_deteccion_automatica_codigo_barras.sql
-- (Renumerada de 119 a 119b el 2026-07-12: colisionaba con
--  119_offline_pos_sync.sql — ver AUDITORIA_2026/etapas_modulos/07_pos.md,
--  Hallazgo 1.)
--
-- Detección automática de código de barras en el POS
--
-- CAMBIOS:
--   · productos.codigo_es_barras   — flag que indica si el código cargado
--     es un código de barras válido (EAN-13/EAN-8/UPC-A) o un código
--     interno propio del negocio
--   · Secuencia seq_codigo_interno_producto — usada para autogenerar un
--     código interno (INT-000001, INT-000002, ...) cuando el producto se
--     crea sin código
--   · fn_es_codigo_barras_valido(texto) — valida dígito verificador de
--     EAN-13/EAN-8/UPC-A
--   · fn_productos_autodetectar_codigo() + trigger — al insertar/actualizar
--     el código de un producto, lo normaliza (trim), autogenera uno interno
--     si viene vacío, y marca codigo_es_barras según corresponda
--
-- 2026-07-16: reconstruida a partir del estado real de producción (esta
-- migración se había aplicado vía apply_migration sin versionar el SQL —
-- ver AUDITORIA_2026, Etapa 8/Observabilidad, housekeeping de migraciones).
-- Verificada contra pg_get_functiondef() en producción; DDL idempotente
-- para permitir reconstrucción de la base desde cero.
-- ============================================================

BEGIN;

-- ── 1. Columna en productos ──────────────────────────────────────────────

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS codigo_es_barras BOOLEAN DEFAULT NULL;

-- ── 2. Secuencia para código interno autogenerado ────────────────────────

CREATE SEQUENCE IF NOT EXISTS seq_codigo_interno_producto
  START WITH 1 INCREMENT BY 1;

-- ── 3. fn_es_codigo_barras_valido ────────────────────────────────────────
-- Valida dígito verificador de EAN-13 (13 dígitos), EAN-8 (8) y UPC-A (12).

CREATE OR REPLACE FUNCTION fn_es_codigo_barras_valido(p_codigo TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
declare
  n int;
  i int;
  weight int;
  sum_val int := 0;
  check_digit int;
  expected int;
begin
  if p_codigo is null or p_codigo !~ '^[0-9]+$' then
    return false;
  end if;

  n := length(p_codigo);
  if n not in (8, 12, 13) then
    return false;
  end if;

  check_digit := substring(p_codigo from n for 1)::int;
  weight := 3;
  for i in reverse (n - 1)..1 loop
    sum_val := sum_val + weight * substring(p_codigo from i for 1)::int;
    weight := case weight when 3 then 1 else 3 end;
  end loop;

  expected := (10 - (sum_val % 10)) % 10;
  return expected = check_digit;
end;
$$;

-- ── 4. Trigger de autodetección/normalización de código ──────────────────

CREATE OR REPLACE FUNCTION fn_productos_autodetectar_codigo()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
begin
  if NEW.codigo is null or btrim(NEW.codigo) = '' then
    NEW.codigo := 'INT-' || lpad(nextval('seq_codigo_interno_producto')::text, 6, '0');
  else
    NEW.codigo := btrim(NEW.codigo);
  end if;

  NEW.codigo_es_barras := fn_es_codigo_barras_valido(NEW.codigo);
  return NEW;
end;
$$;

DROP TRIGGER IF EXISTS trg_productos_autodetectar_codigo ON productos;
CREATE TRIGGER trg_productos_autodetectar_codigo
  BEFORE INSERT OR UPDATE OF codigo ON productos
  FOR EACH ROW EXECUTE FUNCTION fn_productos_autodetectar_codigo();

COMMIT;
