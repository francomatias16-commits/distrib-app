-- ── 063: Eliminar columna huérfana orden_id en ordenes_compra_items ─────────
--
-- HALLAZGO:
-- La tabla ordenes_compra_items tiene DOS columnas que apuntan a ordenes_compra:
--
--   • orden_compra_id  → columna original (migración 017), usada por TODO el app:
--                        RPC crear_orden_compra, stock-auto.js, RLS oci_select/oci_modify,
--                        FK de alertas_stock, índice idx_oci_orden.
--
--   • orden_id         → columna huérfana añadida a mano en producción (no existe en
--                        ninguna migración del repo). Nunca se popula. Siempre NULL.
--                        Sin embargo, es la única con FK constraint
--                        (ordenes_compra_items_orden_id_fkey), y PostgREST usa FK constraints
--                        para resolver embeds automáticos.
--
-- IMPACTO:
-- Cualquier query PostgREST que embede ordenes_compra_items(...) dentro de ordenes_compra
-- usa orden_id (NULL siempre) como columna de join → devuelve array vacío.
-- Afecta: aprobarYEnviarOrden en stock-auto.js Y lib/handlers/proveedores.js.
-- Los emails de órdenes de compra salen sin líneas de producto.
--
-- FIX:
-- Eliminar la columna huérfana y todos sus artefactos asociados.
-- PostgREST resolverá el embed via la columna real orden_compra_id
-- una vez que se agregue la FK correcta (ver paso 4).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Eliminar la política RLS muerta que referencia orden_id (siempre falsa,
--    inofensiva por OR con otras políticas, pero confusa y engañosa)
DROP POLICY IF EXISTS oc_items_empresa ON ordenes_compra_items;

-- 2. Eliminar el FK constraint huérfano que hijackea los embeds de PostgREST
ALTER TABLE ordenes_compra_items
  DROP CONSTRAINT IF EXISTS ordenes_compra_items_orden_id_fkey;

-- 3. Eliminar la columna huérfana (nunca poblada, no rastreada en migraciones)
ALTER TABLE ordenes_compra_items
  DROP COLUMN IF EXISTS orden_id;

-- 4. Agregar FK correcta sobre orden_compra_id (la columna que realmente se usa)
--    para que PostgREST resuelva embeds ordenes_compra_items(...) correctamente
--    en toda la app, sin necesidad de hint !inner ni join manual.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'ordenes_compra_items'
      AND constraint_name = 'ordenes_compra_items_orden_compra_id_fkey'
  ) THEN
    ALTER TABLE ordenes_compra_items
      ADD CONSTRAINT ordenes_compra_items_orden_compra_id_fkey
      FOREIGN KEY (orden_compra_id) REFERENCES ordenes_compra(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Nota: el índice idx_oci_orden ya apunta a orden_compra_id (nombre confuso pero
-- contenido correcto), no es necesario recrearlo.
