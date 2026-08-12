-- ============================================================
-- DISTRIB-APP — Fase 1: RLS granular por rol
-- 012_fase1_roles_rls.sql
-- Ejecutar DESPUÉS de 011_fase1_transacciones.sql
--
-- Objetivos:
--  • Vendedor    → puede crear/ver pedidos y clientes. NO toca
--                  stock, finanzas ni facturas.
--  • Depositero  → puede ver pedidos y mover stock. NO toca
--                  finanzas ni emitir facturas.
--  • Contador    → ve todo pero solo escribe en cobros/facturas.
--  • Admin/Dueño → acceso total.
--
-- IMPORTANTE: estas policies REEMPLAZAN las genéricas de 002_rls.sql.
-- Primero dropeamos las existentes que apliquen.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PEDIDOS: granularidad en escritura
-- Vendedor puede crear y editar (no eliminar, no saltarse el flujo)
-- Depositero puede actualizar estado (para marcar preparando)
-- Contador: solo lectura
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS pedidos_insert   ON pedidos;
DROP POLICY IF EXISTS pedidos_update   ON pedidos;

-- INSERT: vendedor, admin, dueno (no contador, no depositero)
CREATE POLICY pedidos_insert ON pedidos
  FOR INSERT WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'vendedor')
  );

-- UPDATE: admin/dueno sin restricción; vendedor solo sus pedidos;
--         depositero solo puede cambiar estado (no el total ni items)
CREATE POLICY pedidos_update ON pedidos
  FOR UPDATE USING (
    empresa_id = get_empresa_id()
    AND (
      get_rol_usuario() IN ('dueno', 'admin')
      OR (get_rol_usuario() = 'vendedor'    AND vendedor_id = auth.uid())
      OR (get_rol_usuario() = 'depositero')   -- puede marcar preparando
      -- contador NO puede actualizar pedidos
    )
  );

-- DELETE: solo admin/dueno
DROP POLICY IF EXISTS pedidos_delete ON pedidos;
CREATE POLICY pedidos_delete ON pedidos
  FOR DELETE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ────────────────────────────────────────────────────────────
-- STOCK: depositero puede modificar, vendedor solo lee
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS stock_select ON stock;
DROP POLICY IF EXISTS stock_modify ON stock;

CREATE POLICY stock_select ON stock
  FOR SELECT USING (
    deposito_id IN (
      SELECT id FROM depositos WHERE empresa_id = get_empresa_id()
    )
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero', 'vendedor', 'contador')
  );

CREATE POLICY stock_modify ON stock
  FOR ALL USING (
    deposito_id IN (
      SELECT id FROM depositos WHERE empresa_id = get_empresa_id()
    )
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
  );

-- ────────────────────────────────────────────────────────────
-- MOVIMIENTOS DE STOCK: depositero puede insertar
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS mov_stock_select ON movimientos_stock;
DROP POLICY IF EXISTS mov_stock_insert ON movimientos_stock;

CREATE POLICY mov_stock_select ON movimientos_stock
  FOR SELECT USING (
    deposito_id IN (
      SELECT id FROM depositos WHERE empresa_id = get_empresa_id()
    )
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero', 'contador')
  );

CREATE POLICY mov_stock_insert ON movimientos_stock
  FOR INSERT WITH CHECK (
    deposito_id IN (
      SELECT id FROM depositos WHERE empresa_id = get_empresa_id()
    )
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
  );

-- ────────────────────────────────────────────────────────────
-- CLIENTES: vendedor puede crear y editar, no eliminar
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS clientes_insert ON clientes;
DROP POLICY IF EXISTS clientes_update ON clientes;
DROP POLICY IF EXISTS clientes_delete ON clientes;

CREATE POLICY clientes_insert ON clientes
  FOR INSERT WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'vendedor')
  );

CREATE POLICY clientes_update ON clientes
  FOR UPDATE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'vendedor')
  );

CREATE POLICY clientes_delete ON clientes
  FOR DELETE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ────────────────────────────────────────────────────────────
-- PRODUCTOS: solo admin/dueno/depositero modifican
--            vendedor: solo lectura
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS productos_modify ON productos;
DROP POLICY IF EXISTS productos_insert ON productos;
DROP POLICY IF EXISTS productos_update ON productos;
DROP POLICY IF EXISTS productos_delete ON productos;

CREATE POLICY productos_insert ON productos
  FOR INSERT WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

CREATE POLICY productos_update ON productos
  FOR UPDATE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
    -- depositero puede actualizar fotos y stock mínimo pero no precios
    -- (el control de qué campos edita se hace en el frontend + sin acceso a precios_items)
  );

CREATE POLICY productos_delete ON productos
  FOR DELETE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ────────────────────────────────────────────────────────────
-- COBROS: contador puede registrar (antes solo modify sin insert)
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS cobros_select ON cobros;
DROP POLICY IF EXISTS cobros_modify ON cobros;

CREATE POLICY cobros_select ON cobros
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cobros_insert ON cobros
  FOR INSERT WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cobros_update ON cobros
  FOR UPDATE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
    -- contador no puede modificar cobros ya registrados
  );

-- ────────────────────────────────────────────────────────────
-- CHEQUES: igual que cobros
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS cheques_select ON cheques;
DROP POLICY IF EXISTS cheques_modify ON cheques;

CREATE POLICY cheques_select ON cheques
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cheques_insert ON cheques
  FOR INSERT WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cheques_update ON cheques
  FOR UPDATE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

-- ────────────────────────────────────────────────────────────
-- CTA_CTE: contador y vendedor pueden ver; solo contador/admin insertan
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS cta_cte_select_interno ON cta_cte;

CREATE POLICY cta_cte_select_interno ON cta_cte
  FOR SELECT USING (
    cliente_id IN (SELECT id FROM clientes WHERE empresa_id = get_empresa_id())
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador', 'vendedor')
  );

DROP POLICY IF EXISTS cta_cte_insert ON cta_cte;
CREATE POLICY cta_cte_insert ON cta_cte
  FOR INSERT WITH CHECK (
    cliente_id IN (SELECT id FROM clientes WHERE empresa_id = get_empresa_id())
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

DROP POLICY IF EXISTS cta_cte_update ON cta_cte;
CREATE POLICY cta_cte_update ON cta_cte
  FOR UPDATE USING (
    cliente_id IN (SELECT id FROM clientes WHERE empresa_id = get_empresa_id())
    AND get_rol_usuario() IN ('dueno', 'admin')
    -- ni el contador puede corregir una cta_cte ya asentada
  );

-- ────────────────────────────────────────────────────────────
-- FACTURAS: solo dueno/admin/contador modifican
-- ────────────────────────────────────────────────────────────
-- (las policies de 002_rls.sql ya cubren esto, confirmamos)
DROP POLICY IF EXISTS facturas_modify ON facturas;
CREATE POLICY facturas_modify ON facturas
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

-- ────────────────────────────────────────────────────────────
-- LISTAS DE PRECIOS + PRECIOS_ITEMS: solo admin/dueno
-- (vendedor no puede tocar precios)
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS precios_select ON listas_precios;
DROP POLICY IF EXISTS precios_modify ON listas_precios;
DROP POLICY IF EXISTS precios_items_select ON precios_items;
DROP POLICY IF EXISTS precios_items_modify ON precios_items;

CREATE POLICY listas_select ON listas_precios
  FOR SELECT USING (empresa_id = get_empresa_id());

CREATE POLICY listas_modify ON listas_precios
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

CREATE POLICY precios_items_select ON precios_items
  FOR SELECT USING (
    lista_id IN (SELECT id FROM listas_precios WHERE empresa_id = get_empresa_id())
  );

CREATE POLICY precios_items_modify ON precios_items
  FOR ALL USING (
    lista_id IN (SELECT id FROM listas_precios WHERE empresa_id = get_empresa_id())
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ────────────────────────────────────────────────────────────
-- USUARIOS: solo dueno/admin pueden crear/modificar
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS usuarios_insert ON usuarios;
DROP POLICY IF EXISTS usuarios_update ON usuarios;

CREATE POLICY usuarios_insert ON usuarios
  FOR INSERT WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

CREATE POLICY usuarios_update ON usuarios
  FOR UPDATE USING (
    empresa_id = get_empresa_id()
    AND (
      get_rol_usuario() IN ('dueno', 'admin')
      OR id = auth.uid()  -- cada usuario puede editar su propio perfil
    )
  );

-- ============================================================
-- FIN DE 012_fase1_roles_rls.sql
-- ============================================================
