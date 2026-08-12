-- ============================================================
-- 120_balanza_devoluciones_promociones.sql
-- POS Fase 4 — Balanza digital, Devoluciones y Promociones
--
-- TABLAS NUEVAS:
--   · devoluciones_pos       — cabecera de devoluciones en el POS
--   · devoluciones_pos_items — ítems devueltos
--   · promociones            — promociones activas (nxm, descuento por
--     producto o por categoría)
--
-- COLUMNAS NUEVAS:
--   · productos.vendido_por_peso   — flag para productos a granel (balanza)
--   · venta_pos_items.promocion_id — referencia a la promoción aplicada
--     en ese ítem de venta
--
-- RPCS NUEVOS:
--   · rpc_registrar_devolucion_pos(venta_pos_id, items, motivo, usuario_id)
--     registra una devolución (parcial o total), valida contra lo ya
--     devuelto por ítem, repone stock y crea un lote de reingreso
--     (DEV-<venta>-<fecha>) cuando la caja tiene depósito asociado.
--
-- 2026-07-16: reconstruida a partir del estado real de producción (esta
-- migración se había aplicado vía apply_migration sin versionar el SQL —
-- ver AUDITORIA_2026, Etapa 8/Observabilidad, housekeeping de migraciones).
-- Verificada contra information_schema / pg_get_functiondef() / pg_policies
-- en producción; DDL idempotente para permitir reconstrucción de la base
-- desde cero.
--
-- NOTA aparte (no corregida acá, solo documentada): en producción
-- devoluciones_pos_items tiene dos pares de políticas RLS funcionalmente
-- idénticos para SELECT/INSERT (dev_items_select/dev_items_insert y
-- devoluciones_items_select/devoluciones_items_insert). Esta migración
-- versiona el par "devoluciones_items_*"; el otro par quedó duplicado en
-- algún momento posterior y conviene limpiarlo en una migración aparte.
-- ============================================================

BEGIN;

-- ── 1. Columnas nuevas ────────────────────────────────────────────────────

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS vendido_por_peso BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE venta_pos_items
  ADD COLUMN IF NOT EXISTS promocion_id UUID REFERENCES promociones(id);

-- ── 2. Tabla promociones ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS promociones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre        TEXT NOT NULL,
  tipo          TEXT NOT NULL CHECK (tipo IN ('nxm', 'descuento_categoria', 'descuento_producto')),
  n_cantidad    INTEGER,
  m_paga        INTEGER,
  descuento_pct NUMERIC,
  producto_id   UUID REFERENCES productos(id) ON DELETE CASCADE,
  categoria_id  UUID REFERENCES categorias(id) ON DELETE CASCADE,
  activa        BOOLEAN NOT NULL DEFAULT true,
  fecha_desde   DATE,
  fecha_hasta   DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promociones_empresa_activa ON promociones(empresa_id) WHERE activa = true;
CREATE INDEX IF NOT EXISTS idx_promociones_producto        ON promociones(producto_id);
CREATE INDEX IF NOT EXISTS idx_promociones_categoria        ON promociones(categoria_id);

ALTER TABLE promociones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS promociones_select ON promociones;
CREATE POLICY promociones_select ON promociones FOR SELECT
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

DROP POLICY IF EXISTS promociones_insert ON promociones;
CREATE POLICY promociones_insert ON promociones FOR INSERT
  WITH CHECK (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    AND (SELECT rol FROM usuarios WHERE id = auth.uid()) = ANY (ARRAY['dueno','admin']::rol_usuario[])
  );

DROP POLICY IF EXISTS promociones_update ON promociones;
CREATE POLICY promociones_update ON promociones FOR UPDATE
  USING (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    AND (SELECT rol FROM usuarios WHERE id = auth.uid()) = ANY (ARRAY['dueno','admin']::rol_usuario[])
  );

DROP POLICY IF EXISTS promociones_delete ON promociones;
CREATE POLICY promociones_delete ON promociones FOR DELETE
  USING (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    AND (SELECT rol FROM usuarios WHERE id = auth.uid()) = ANY (ARRAY['dueno','admin']::rol_usuario[])
  );

-- ── 3. Tabla devoluciones_pos ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS devoluciones_pos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  venta_pos_id UUID NOT NULL REFERENCES ventas_pos(id) ON DELETE RESTRICT,
  usuario_id   UUID REFERENCES usuarios(id),
  motivo       TEXT,
  monto_total  NUMERIC NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devoluciones_venta          ON devoluciones_pos(venta_pos_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_pos_empresa_id ON devoluciones_pos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_pos_usuario_id ON devoluciones_pos(usuario_id);

ALTER TABLE devoluciones_pos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS devoluciones_select ON devoluciones_pos;
CREATE POLICY devoluciones_select ON devoluciones_pos FOR SELECT
  USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

DROP POLICY IF EXISTS devoluciones_insert ON devoluciones_pos;
CREATE POLICY devoluciones_insert ON devoluciones_pos FOR INSERT
  WITH CHECK (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    AND (SELECT rol FROM usuarios WHERE id = auth.uid()) = ANY (ARRAY['dueno','admin','vendedor']::rol_usuario[])
  );

DROP POLICY IF EXISTS devoluciones_update ON devoluciones_pos;
CREATE POLICY devoluciones_update ON devoluciones_pos FOR UPDATE
  USING (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    AND (SELECT rol FROM usuarios WHERE id = auth.uid()) = ANY (ARRAY['dueno','admin']::rol_usuario[])
  );

-- ── 4. Tabla devoluciones_pos_items ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS devoluciones_pos_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  devolucion_id      UUID NOT NULL REFERENCES devoluciones_pos(id) ON DELETE CASCADE,
  venta_pos_item_id  UUID NOT NULL REFERENCES venta_pos_items(id) ON DELETE RESTRICT,
  producto_id        UUID NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
  cantidad_devuelta  NUMERIC NOT NULL CHECK (cantidad_devuelta > 0),
  monto              NUMERIC NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_devoluciones_items_devolucion         ON devoluciones_pos_items(devolucion_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_pos_items_producto_id    ON devoluciones_pos_items(producto_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_pos_items_venta_pos_item_id ON devoluciones_pos_items(venta_pos_item_id);

ALTER TABLE devoluciones_pos_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS devoluciones_items_select ON devoluciones_pos_items;
CREATE POLICY devoluciones_items_select ON devoluciones_pos_items FOR SELECT
  USING (
    devolucion_id IN (
      SELECT id FROM devoluciones_pos
      WHERE empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    )
  );

DROP POLICY IF EXISTS devoluciones_items_insert ON devoluciones_pos_items;
CREATE POLICY devoluciones_items_insert ON devoluciones_pos_items FOR INSERT
  WITH CHECK (
    devolucion_id IN (
      SELECT id FROM devoluciones_pos
      WHERE empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    )
  );

-- ── 5. RPC rpc_registrar_devolucion_pos ────────────────────────────────────
-- Registra una devolución (total o parcial) validando que no se devuelva
-- más cantidad de la vendida por ítem, repone stock en el depósito de la
-- caja de origen y genera un lote de reingreso para trazabilidad.

CREATE OR REPLACE FUNCTION rpc_registrar_devolucion_pos(
  p_venta_pos_id UUID,
  p_items        JSONB,
  p_motivo       TEXT,
  p_usuario_id   UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_empresa_id    UUID;
  v_caja_id       UUID;
  v_deposito_id   UUID;
  v_devolucion_id UUID;
  v_item          JSONB;
  v_vpi           RECORD;
  v_ya_devuelto   NUMERIC;
  v_monto         NUMERIC;
  v_monto_total   NUMERIC := 0;
  v_cant_dev      NUMERIC;
BEGIN
  IF auth.role() <> 'service_role' THEN
    p_usuario_id := auth.uid();
  END IF;

  SELECT empresa_id, caja_id INTO v_empresa_id, v_caja_id FROM ventas_pos WHERE id = p_venta_pos_id;
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  IF auth.role() <> 'service_role' AND v_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  SELECT deposito_id INTO v_deposito_id FROM cajas_pos WHERE id = v_caja_id;

  INSERT INTO devoluciones_pos (empresa_id, venta_pos_id, usuario_id, motivo, monto_total)
  VALUES (v_empresa_id, p_venta_pos_id, p_usuario_id, p_motivo, 0)
  RETURNING id INTO v_devolucion_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_vpi FROM venta_pos_items WHERE id = (v_item->>'venta_pos_item_id')::uuid AND venta_pos_id = p_venta_pos_id;
    IF v_vpi IS NULL THEN
      RAISE EXCEPTION 'Ítem de venta no encontrado en esta venta';
    END IF;

    SELECT COALESCE(SUM(cantidad_devuelta), 0) INTO v_ya_devuelto
      FROM devoluciones_pos_items WHERE venta_pos_item_id = v_vpi.id;

    v_cant_dev := (v_item->>'cantidad_devuelta')::NUMERIC;

    IF v_ya_devuelto + v_cant_dev > v_vpi.cantidad THEN
      RAISE EXCEPTION 'No se puede devolver más cantidad de la vendida para "%"', v_vpi.producto_id;
    END IF;

    v_monto := v_cant_dev * v_vpi.precio_unitario * (1 - COALESCE(v_vpi.descuento_pct, 0) / 100);
    v_monto_total := v_monto_total + v_monto;

    INSERT INTO devoluciones_pos_items (devolucion_id, venta_pos_item_id, producto_id, cantidad_devuelta, monto)
    VALUES (v_devolucion_id, v_vpi.id, v_vpi.producto_id, v_cant_dev, v_monto);

    IF v_deposito_id IS NOT NULL THEN
      UPDATE stock
         SET cantidad = cantidad + v_cant_dev
       WHERE producto_id = v_vpi.producto_id AND deposito_id = v_deposito_id;

      INSERT INTO lotes (
        empresa_id, producto_id, deposito_id,
        numero_lote, cantidad, cantidad_disponible,
        estado
      ) VALUES (
        v_empresa_id, v_vpi.producto_id, v_deposito_id,
        'DEV-' || LEFT(p_venta_pos_id::TEXT, 8) || '-' || TO_CHAR(now(), 'YYYYMMDD'),
        v_cant_dev, v_cant_dev,
        'activo'
      );
    END IF;
  END LOOP;

  UPDATE devoluciones_pos SET monto_total = v_monto_total WHERE id = v_devolucion_id;

  RETURN v_devolucion_id;
END;
$$;

COMMIT;
