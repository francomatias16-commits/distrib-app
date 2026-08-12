-- ═══════════════════════════════════════════════════════════════
-- 109 · Carrito persistente para portal cliente
-- ═══════════════════════════════════════════════════════════════
-- Cada fila = 1 producto en el carrito de 1 cliente.
-- ON CONFLICT (cliente_id, producto_id) → actualiza cantidad/precio.
-- Se vacía al confirmar el pedido.

CREATE TABLE IF NOT EXISTS carrito_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES empresas(id)  ON DELETE CASCADE,
  cliente_id   uuid NOT NULL REFERENCES clientes(id)  ON DELETE CASCADE,
  producto_id  uuid NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  cantidad     int  NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  precio_snap  numeric(12,2) NOT NULL DEFAULT 0,  -- precio al momento de agregar (referencia, no se usa para cobrar)
  creado_at    timestamptz DEFAULT now(),
  actualizado_at timestamptz DEFAULT now(),

  UNIQUE (cliente_id, producto_id)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_carrito_cliente     ON carrito_items(cliente_id);
CREATE INDEX IF NOT EXISTS idx_carrito_empresa     ON carrito_items(empresa_id);

-- RLS
ALTER TABLE carrito_items ENABLE ROW LEVEL SECURITY;

-- El propio cliente puede ver/insertar/actualizar/borrar SU carrito
-- (enlace: usuarios.cliente_id = carrito_items.cliente_id, mismo empresa_id)
DROP POLICY IF EXISTS carrito_cliente_select ON carrito_items;
CREATE POLICY carrito_cliente_select ON carrito_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM usuarios u
      WHERE u.id = auth.uid()
        AND u.cliente_id = carrito_items.cliente_id
    )
  );

DROP POLICY IF EXISTS carrito_cliente_insert ON carrito_items;
CREATE POLICY carrito_cliente_insert ON carrito_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM usuarios u
      WHERE u.id = auth.uid()
        AND u.cliente_id = carrito_items.cliente_id
        AND u.empresa_id = carrito_items.empresa_id
    )
  );

DROP POLICY IF EXISTS carrito_cliente_update ON carrito_items;
CREATE POLICY carrito_cliente_update ON carrito_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM usuarios u
      WHERE u.id = auth.uid()
        AND u.cliente_id = carrito_items.cliente_id
    )
  );

DROP POLICY IF EXISTS carrito_cliente_delete ON carrito_items;
CREATE POLICY carrito_cliente_delete ON carrito_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM usuarios u
      WHERE u.id = auth.uid()
        AND u.cliente_id = carrito_items.cliente_id
    )
  );

-- Admin de la empresa puede ver los carritos de sus clientes
DROP POLICY IF EXISTS carrito_admin_select ON carrito_items;
CREATE POLICY carrito_admin_select ON carrito_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM usuarios u
      WHERE u.id = auth.uid()
        AND u.empresa_id = carrito_items.empresa_id
        AND u.rol IN ('dueno', 'admin', 'vendedor')
    )
  );

COMMENT ON TABLE carrito_items IS 'Carrito persistente del portal de cliente. Se vacía al confirmar el pedido.';
