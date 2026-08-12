-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 153: clientes.vendedor_id_default
--
-- No existía ningún campo para "vendedor asignado por defecto" a un cliente:
-- vendedor_id solo vive a nivel de transacción (pedidos, presupuestos,
-- ventas_pos). Lo agregamos en clientes, mismo patrón que ya existe en
-- productos.proveedor_id_default. Es la base para que el wizard de migración
-- pueda importar la columna "vendedor asignado" pedida por la distribuidora.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS vendedor_id_default UUID REFERENCES usuarios(id);
