-- ═══════════════════════════════════════════════════════════════════════════
-- 231 — Fix sincronización de Productos: columna updated_at real
--
-- Contexto: la pantalla /admin/productos.html muestra una columna
-- "ÚLTIMA ACT." que el frontend (productos.js) intentaba llenar leyendo
-- p.updated_at directamente de la tabla productos. Esa columna nunca
-- existió (solo estaba created_at), por lo que la query real a Supabase
-- fallaba (error de columna inexistente) y la pantalla caía siempre al
-- dataset de demostración hardcodeado — por eso se veía "desincronizada"
-- respecto de Clientes, Stock, etc., que sí reflejan la base real.
--
-- Este script agrega updated_at con un trigger que lo actualiza en cada
-- UPDATE, igual que se espera para el resto de las entidades editables.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE productos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Backfill: productos existentes arrancan con updated_at = created_at
UPDATE productos SET updated_at = created_at WHERE updated_at IS NULL;

CREATE OR REPLACE FUNCTION fn_set_productos_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_productos_updated_at ON productos;
CREATE TRIGGER trg_productos_updated_at
  BEFORE UPDATE ON productos
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_productos_updated_at();
