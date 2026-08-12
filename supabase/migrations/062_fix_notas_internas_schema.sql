-- ── 062: Corregir schema de notas_internas ─────────────────────────────────
--
-- La migración 047 creó la tabla con una estructura distinta a la definida
-- en 019_req14_notas_internas.sql (que quedó sin efecto por IF NOT EXISTS).
-- Schema real en backup:   id, empresa_id, usuario_id, tabla, entidad_id, contenido, created_at
-- Contrato del frontend:   + entidad_tipo (no tabla), + usuario_nombre, + activa
--
-- La tabla está vacía en producción → sin migración de datos.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Renombrar 'tabla' → 'entidad_tipo' (campo semántico correcto)
ALTER TABLE notas_internas RENAME COLUMN tabla TO entidad_tipo;

-- 2. Agregar columna usuario_nombre (snapshot del nombre al momento de inserción)
ALTER TABLE notas_internas
  ADD COLUMN IF NOT EXISTS usuario_nombre TEXT;

-- 3. Agregar columna activa (permite archivar sin borrar del historial)
ALTER TABLE notas_internas
  ADD COLUMN IF NOT EXISTS activa BOOLEAN NOT NULL DEFAULT true;

-- 4. Hacer empresa_id NOT NULL (era nullable en la versión de 047, el frontend
--    siempre la envía y las políticas RLS la requieren)
ALTER TABLE notas_internas
  ALTER COLUMN empresa_id SET NOT NULL;

-- 5. Agregar FK a empresas si no existe (019 la tenía, 047 la omitió)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'notas_internas'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'notas_internas_empresa_id_fkey'
  ) THEN
    ALTER TABLE notas_internas
      ADD CONSTRAINT notas_internas_empresa_id_fkey
      FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 6. Índice principal para cargar notas por entidad
CREATE INDEX IF NOT EXISTS idx_notas_internas_entidad
  ON notas_internas(empresa_id, entidad_tipo, entidad_id, created_at DESC);

-- 7. RLS: habilitar si no está ya activo
ALTER TABLE notas_internas ENABLE ROW LEVEL SECURITY;

-- 8. Política de acceso por empresa (DROP + CREATE para idempotencia)
DROP POLICY IF EXISTS "notas_internas_empresa" ON notas_internas;
CREATE POLICY "notas_internas_empresa" ON notas_internas
  FOR ALL USING (
    empresa_id = (
      SELECT empresa_id FROM usuarios WHERE id = auth.uid()
    )
  );
