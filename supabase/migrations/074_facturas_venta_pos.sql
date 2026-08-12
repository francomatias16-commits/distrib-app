-- ============================================================================
-- 074_facturas_venta_pos.sql
--
-- Etapa 4 del POS: permitir facturar una venta de mostrador (ventas_pos)
-- desde el modal de ticket, reutilizando el mismo flujo de emisión que ya
-- existe para pedidos (lib/facturas.js → emitirFactura).
--
-- (Nota de numeración: esta migración iba a ser la "073", pero ese número
-- ya lo ocupó el fix de score/costo_km/portal-proveedor. Pasa a ser 074.)
--
--  1) facturas.venta_pos_id: análogo a facturas.pedido_id pero para ventas
--     de mostrador. Ambas columnas son nullable — una factura nace de un
--     pedido O de una venta POS, nunca de ambos. Se agrega un CHECK para
--     que el dato no quede ambiguo.
--
--  2) ventas_pos.factura_id ya existía desde 072_pos.sql (columna prevista
--     pero sin usar todavía) — no requiere cambios acá, lib/facturas.js la
--     actualiza directamente al emitir.
--
--  3) Índice sobre facturas.venta_pos_id para el lookup de
--     "¿esta venta ya tiene una factura pendiente/emitida?", igual patrón
--     que el índice implícito de la FK sobre pedido_id.
-- ============================================================================

-- ── 1. Columna venta_pos_id en facturas ─────────────────────────────────
ALTER TABLE facturas
  ADD COLUMN IF NOT EXISTS venta_pos_id UUID REFERENCES ventas_pos(id);

-- ── 2. CHECK: pedido_id y venta_pos_id son mutuamente excluyentes ───────
-- (no agrega NOT NULL en ninguna de las dos — solo evita que una factura
-- quede asociada a ambos orígenes a la vez, lo cual sería un bug de datos).
ALTER TABLE facturas
  DROP CONSTRAINT IF EXISTS chk_facturas_origen_unico;

ALTER TABLE facturas
  ADD CONSTRAINT chk_facturas_origen_unico
  CHECK (NOT (pedido_id IS NOT NULL AND venta_pos_id IS NOT NULL));

-- ── 3. Índice para el lookup por venta_pos_id ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_facturas_venta_pos
  ON facturas(venta_pos_id)
  WHERE venta_pos_id IS NOT NULL;
