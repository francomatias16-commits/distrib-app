-- ============================================================
-- 20260822180000_530_combos_schema.sql
-- Combos: agrupación de productos vendida como un renglón único, con
-- precio propio (no es la suma de sus componentes) — mismo patrón de
-- "ítem único" que ya definimos para el carrito/pedido (ver nota de la
-- pregunta original: "Al agregar un combo al carrito, ¿cómo se guarda en
-- el pedido? R: Ítem único, precio propio, un renglón, se descuenta stock
-- por combo_items al confirmar").
--
-- Reconstrucción de la migración 530 original (no recuperada del entorno
-- donde se armó) a partir del contrato que ya asumen combos.js,
-- pedido-totales.js, pedidos.js y las migraciones 533/534: nombres de
-- columna, tipos y la constraint pedido_items_producto_o_combo salen
-- textuales de esos archivos; el resto (RLS, índices, trigger de
-- empresa_id) sigue el mismo patrón ya usado para `productos`.
-- ============================================================

-- ── 1. Tabla combos ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  descripcion TEXT,
  precio      NUMERIC(12,2) NOT NULL CHECK (precio >= 0),
  foto_url    TEXT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_combos_empresa ON combos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_combos_activo  ON combos(empresa_id, activo);

-- ── 2. Composición del combo ─────────────────────────────────────────────
-- cantidad es INTEGER, no NUMERIC: mismo tipo que stock.cantidad,
-- pedido_items.cantidad, carrito_items.cantidad y movimientos_stock.cantidad
-- en el schema real (confirmado contra la base — ver migración 690, que
-- eliminó las fracciones de kilo incluso para productos por peso).
CREATE TABLE IF NOT EXISTS combo_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_id    UUID NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  producto_id UUID NOT NULL REFERENCES productos(id),
  cantidad    INTEGER NOT NULL CHECK (cantidad > 0),
  UNIQUE (combo_id, producto_id)
);

CREATE INDEX IF NOT EXISTS idx_combo_items_combo    ON combo_items(combo_id);
CREATE INDEX IF NOT EXISTS idx_combo_items_producto ON combo_items(producto_id);

-- ── 3. pedido_items: renglón único (producto O combo) ────────────────────
ALTER TABLE pedido_items
  ADD COLUMN IF NOT EXISTS combo_id UUID REFERENCES combos(id);

ALTER TABLE pedido_items
  DROP CONSTRAINT IF EXISTS pedido_items_producto_o_combo;

ALTER TABLE pedido_items
  ADD CONSTRAINT pedido_items_producto_o_combo
  CHECK (
    (producto_id IS NOT NULL AND combo_id IS NULL) OR
    (producto_id IS NULL AND combo_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_pedido_items_combo ON pedido_items(combo_id) WHERE combo_id IS NOT NULL;

-- ── 4. carrito_items: mismo criterio de renglón único ─────────────────────
-- 145_carrito_items_portal_cliente.sql definió producto_id NOT NULL y
-- UNIQUE(cliente_id, producto_id) — hay que relajar el NOT NULL y llevar el
-- UNIQUE a un índice parcial por columna para no romper el caso combo
-- (producto_id NULL no colisiona en un UNIQUE compuesto, pero dos renglones
-- de combo_id NULL sí colisionarían entre sí si no se particiona).
ALTER TABLE carrito_items
  ALTER COLUMN producto_id DROP NOT NULL;

ALTER TABLE carrito_items
  ADD COLUMN IF NOT EXISTS combo_id UUID REFERENCES combos(id);

ALTER TABLE carrito_items
  DROP CONSTRAINT IF EXISTS carrito_items_producto_o_combo;

ALTER TABLE carrito_items
  ADD CONSTRAINT carrito_items_producto_o_combo
  CHECK (
    (producto_id IS NOT NULL AND combo_id IS NULL) OR
    (producto_id IS NULL AND combo_id IS NOT NULL)
  );

ALTER TABLE carrito_items
  DROP CONSTRAINT IF EXISTS carrito_items_cliente_id_producto_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carrito_items_cliente_producto
  ON carrito_items(cliente_id, producto_id) WHERE producto_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_carrito_items_cliente_combo
  ON carrito_items(cliente_id, combo_id) WHERE combo_id IS NOT NULL;

-- ── 5. Trigger empresa_id (mismo patrón que productos/clientes/pedidos) ──
DROP TRIGGER IF EXISTS tr_force_empresa_combos ON combos;
CREATE TRIGGER tr_force_empresa_combos
BEFORE INSERT ON combos
FOR EACH ROW EXECUTE FUNCTION force_empresa_id();

DROP TRIGGER IF EXISTS trg_combos_updated_at ON combos;
CREATE OR REPLACE FUNCTION combos_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_combos_updated_at
BEFORE UPDATE ON combos
FOR EACH ROW EXECUTE FUNCTION combos_set_updated_at();

-- ── 6. RLS: mismo criterio que productos (todos los roles internos +
-- clientes leen; solo dueño/admin/depositero modifican, vía RPC) ─────────
ALTER TABLE combos ENABLE ROW LEVEL SECURITY;
ALTER TABLE combo_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS combos_select ON combos;
CREATE POLICY combos_select ON combos
  FOR SELECT USING (empresa_id = get_empresa_id());

DROP POLICY IF EXISTS combos_modify ON combos;
CREATE POLICY combos_modify ON combos
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
  );

DROP POLICY IF EXISTS combo_items_select ON combo_items;
CREATE POLICY combo_items_select ON combo_items
  FOR SELECT USING (
    combo_id IN (SELECT id FROM combos WHERE empresa_id = get_empresa_id())
  );

DROP POLICY IF EXISTS combo_items_modify ON combo_items;
CREATE POLICY combo_items_modify ON combo_items
  FOR ALL USING (
    combo_id IN (
      SELECT id FROM combos
       WHERE empresa_id = get_empresa_id()
         AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
    )
  );

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '20260822180000_530_combos_schema.sql',
  '530',
  'claude_assistant',
  'Reconstrucción: schema de combos/combo_items + pedido_items.combo_id + carrito_items.combo_id, ítem único (producto XOR combo).'
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
