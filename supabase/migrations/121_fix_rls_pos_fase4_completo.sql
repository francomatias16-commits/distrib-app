-- ============================================================
-- 121_fix_rls_pos_fase4_completo.sql
-- Completar y corregir RLS para tablas Fase 4
--
-- Problemas corregidos:
--   1. devoluciones_pos.INSERT sin WITH CHECK → agregado (empresa_id + rol)
--   2. devoluciones_pos_items sin políticas INSERT/SELECT → creadas
--   3. promociones.INSERT sin WITH CHECK empresa_id → corregido
--   4. ventas_pos y venta_pos_items sin SELECT para auth users → agregado
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS devoluciones_insert ON devoluciones_pos;
CREATE POLICY devoluciones_insert ON devoluciones_pos
  FOR INSERT WITH CHECK (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    AND (SELECT rol FROM usuarios WHERE id = auth.uid()) = ANY (ARRAY['dueno','admin','vendedor']::rol_usuario[])
  );

DROP POLICY IF EXISTS devoluciones_update ON devoluciones_pos;
CREATE POLICY devoluciones_update ON devoluciones_pos
  FOR UPDATE USING (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    AND (SELECT rol FROM usuarios WHERE id = auth.uid()) = ANY (ARRAY['dueno','admin']::rol_usuario[])
  );

DROP POLICY IF EXISTS dev_items_select ON devoluciones_pos_items;
CREATE POLICY dev_items_select ON devoluciones_pos_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM devoluciones_pos d WHERE d.id = devolucion_id
      AND d.empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()))
  );

DROP POLICY IF EXISTS dev_items_insert ON devoluciones_pos_items;
CREATE POLICY dev_items_insert ON devoluciones_pos_items
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM devoluciones_pos d WHERE d.id = devolucion_id
      AND d.empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()))
  );

DROP POLICY IF EXISTS promociones_insert ON promociones;
CREATE POLICY promociones_insert ON promociones
  FOR INSERT WITH CHECK (
    empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid())
    AND (SELECT rol FROM usuarios WHERE id = auth.uid()) = ANY (ARRAY['dueno','admin']::rol_usuario[])
  );

DROP POLICY IF EXISTS ventas_pos_select_propia ON ventas_pos;
CREATE POLICY ventas_pos_select_propia ON ventas_pos
  FOR SELECT USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

DROP POLICY IF EXISTS venta_pos_items_select_propia ON venta_pos_items;
CREATE POLICY venta_pos_items_select_propia ON venta_pos_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM ventas_pos v WHERE v.id = venta_pos_id
      AND v.empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()))
  );

COMMIT;
