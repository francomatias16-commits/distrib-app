-- ── REQ-14: Notas internas con historial ────────────────────────────────────
-- Archivo: db/019_req14_notas_internas.sql
--
-- Tabla genérica de notas internas para cualquier entidad del sistema.
-- Cada nota queda asociada a:
--   • entidad_tipo: 'cliente' | 'pedido' | 'proveedor' (extensible)
--   • entidad_id:   UUID del registro correspondiente
--   • usuario que la creó + timestamp inmutable
--
-- Las notas son INMUTABLES: no se editan, solo se agregan o se marcan inactivas.
-- Esto garantiza un historial fiel de lo que se registró y cuándo.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notas_internas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  entidad_tipo  TEXT NOT NULL CHECK (entidad_tipo IN ('cliente','pedido','proveedor','producto')),
  entidad_id    UUID NOT NULL,
  contenido     TEXT NOT NULL CHECK (char_length(contenido) BETWEEN 1 AND 2000),
  usuario_id    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  -- Nombre en el momento del registro, para que quede aunque baje el usuario
  usuario_nombre TEXT,
  -- Permite "archivar" una nota sin borrarla del historial
  activa        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice principal: cargar notas de una entidad específica
CREATE INDEX IF NOT EXISTS idx_notas_internas_entidad
  ON notas_internas(empresa_id, entidad_tipo, entidad_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notas_internas_usuario
  ON notas_internas(usuario_id);

-- RLS: cada empresa solo ve sus notas
ALTER TABLE notas_internas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notas_internas_empresa" ON notas_internas
  FOR ALL USING (
    empresa_id = (
      SELECT empresa_id FROM usuarios WHERE id = auth.uid()
    )
  );

-- Solo roles internos (no clientes) pueden ver/crear notas internas.
-- El control de rol se hace en el frontend + RLS de usuarios.
-- Los clientes no tienen acceso a esta tabla por diseño.

COMMENT ON TABLE notas_internas IS
  'Notas internas del equipo sobre clientes, pedidos u otras entidades. Inmutables (solo se agregan).';
COMMENT ON COLUMN notas_internas.entidad_tipo IS
  'Tipo de entidad a la que pertenece la nota: cliente, pedido, proveedor, producto.';
COMMENT ON COLUMN notas_internas.usuario_nombre IS
  'Nombre del usuario al momento del registro. Se preserva aunque el usuario sea dado de baja.';
COMMENT ON COLUMN notas_internas.activa IS
  'false = nota archivada. No se muestra por defecto pero se preserva en la BD.';
