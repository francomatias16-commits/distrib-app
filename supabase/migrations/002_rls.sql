-- ============================================================
-- DISTRIB-APP — Row Level Security (RLS)
-- Ejecutar DESPUÉS de 001_schema.sql
-- MF Web Solutions | v1.0 | Junio 2026
-- ============================================================

-- ============================================================
-- FUNCION HELPER: obtiene empresa_id del usuario autenticado
-- Se usa en todas las policies para no repetir la subquery
-- ============================================================
CREATE OR REPLACE FUNCTION get_empresa_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT empresa_id FROM usuarios WHERE id = auth.uid();
$$;

-- ============================================================
-- FUNCION HELPER: obtiene el rol del usuario autenticado
-- ============================================================
CREATE OR REPLACE FUNCTION get_rol_usuario()
RETURNS rol_usuario
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT rol FROM usuarios WHERE id = auth.uid();
$$;

-- ============================================================
-- ACTIVAR RLS EN TODAS LAS TABLAS
-- ============================================================
ALTER TABLE empresas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios          ENABLE ROW LEVEL SECURITY;
ALTER TABLE zonas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias        ENABLE ROW LEVEL SECURITY;
ALTER TABLE listas_precios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE precios_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE productos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE depositos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock             ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedido_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE facturas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE rutas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE entregas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cobros            ENABLE ROW LEVEL SECURITY;
ALTER TABLE cheques           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cta_cte           ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- POLICIES: empresas
-- El usuario solo ve su propia empresa
-- ============================================================
CREATE POLICY empresas_select ON empresas
  FOR SELECT USING (id = get_empresa_id());

CREATE POLICY empresas_update ON empresas
  FOR UPDATE USING (
    id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ============================================================
-- POLICIES: usuarios
-- Cada usuario ve a los compañeros de su misma empresa
-- Solo dueno/admin pueden crear o modificar usuarios
-- ============================================================
CREATE POLICY usuarios_select ON usuarios
  FOR SELECT USING (empresa_id = get_empresa_id());

CREATE POLICY usuarios_insert ON usuarios
  FOR INSERT WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

CREATE POLICY usuarios_update ON usuarios
  FOR UPDATE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ============================================================
-- POLICIES: tablas de configuracion
-- (zonas, categorias, listas_precios, precios_items, depositos)
-- Todos leen, solo admin/dueno modifican
-- ============================================================

-- zonas
CREATE POLICY zonas_select ON zonas
  FOR SELECT USING (empresa_id = get_empresa_id());
CREATE POLICY zonas_modify ON zonas
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- categorias
CREATE POLICY categorias_select ON categorias
  FOR SELECT USING (empresa_id = get_empresa_id());
CREATE POLICY categorias_modify ON categorias
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- listas_precios
CREATE POLICY listas_select ON listas_precios
  FOR SELECT USING (empresa_id = get_empresa_id());
CREATE POLICY listas_modify ON listas_precios
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

-- precios_items (acceso via lista de su empresa)
CREATE POLICY precios_items_select ON precios_items
  FOR SELECT USING (
    lista_id IN (
      SELECT id FROM listas_precios WHERE empresa_id = get_empresa_id()
    )
  );
CREATE POLICY precios_items_modify ON precios_items
  FOR ALL USING (
    lista_id IN (
      SELECT id FROM listas_precios WHERE empresa_id = get_empresa_id()
    )
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

-- depositos
CREATE POLICY depositos_select ON depositos
  FOR SELECT USING (empresa_id = get_empresa_id());
CREATE POLICY depositos_modify ON depositos
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ============================================================
-- POLICIES: clientes
-- Todos los roles internos leen; vendedor/admin crean y editan
-- Cliente solo ve su propio registro
-- ============================================================
CREATE POLICY clientes_select_interno ON clientes
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'vendedor', 'depositero', 'chofer', 'contador')
  );

CREATE POLICY clientes_select_propio ON clientes
  FOR SELECT USING (
    get_rol_usuario() = 'cliente'
    AND id = (SELECT id FROM clientes WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()) LIMIT 1)
  );

CREATE POLICY clientes_modify ON clientes
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'vendedor')
  );

-- ============================================================
-- POLICIES: productos
-- Todos los roles internos leen (clientes también, para el portal)
-- Solo admin/dueno modifican
-- ============================================================
CREATE POLICY productos_select ON productos
  FOR SELECT USING (empresa_id = get_empresa_id());

CREATE POLICY productos_modify ON productos
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin')
  );

-- ============================================================
-- POLICIES: stock y movimientos
-- ============================================================
CREATE POLICY stock_select ON stock
  FOR SELECT USING (
    deposito_id IN (
      SELECT id FROM depositos WHERE empresa_id = get_empresa_id()
    )
  );

CREATE POLICY stock_modify ON stock
  FOR ALL USING (
    deposito_id IN (
      SELECT id FROM depositos WHERE empresa_id = get_empresa_id()
    )
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
  );

CREATE POLICY mov_stock_select ON movimientos_stock
  FOR SELECT USING (
    deposito_id IN (
      SELECT id FROM depositos WHERE empresa_id = get_empresa_id()
    )
  );

CREATE POLICY mov_stock_insert ON movimientos_stock
  FOR INSERT WITH CHECK (
    deposito_id IN (
      SELECT id FROM depositos WHERE empresa_id = get_empresa_id()
    )
  );

-- ============================================================
-- POLICIES: pedidos
-- Cliente ve solo sus pedidos; internos ven todo su empresa
-- ============================================================
CREATE POLICY pedidos_select_interno ON pedidos
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'vendedor', 'depositero', 'chofer', 'contador')
  );

CREATE POLICY pedidos_select_cliente ON pedidos
  FOR SELECT USING (
    get_rol_usuario() = 'cliente'
    AND cliente_id = (SELECT id FROM clientes WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()) LIMIT 1)
  );

CREATE POLICY pedidos_insert ON pedidos
  FOR INSERT WITH CHECK (empresa_id = get_empresa_id());

CREATE POLICY pedidos_update ON pedidos
  FOR UPDATE USING (empresa_id = get_empresa_id());

-- pedido_items: acceso via pedido de su empresa
CREATE POLICY pedido_items_select ON pedido_items
  FOR SELECT USING (
    pedido_id IN (SELECT id FROM pedidos WHERE empresa_id = get_empresa_id())
  );

CREATE POLICY pedido_items_modify ON pedido_items
  FOR ALL USING (
    pedido_id IN (SELECT id FROM pedidos WHERE empresa_id = get_empresa_id())
  );

-- ============================================================
-- POLICIES: facturas
-- ============================================================
CREATE POLICY facturas_select_interno ON facturas
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'vendedor', 'contador')
  );

CREATE POLICY facturas_select_cliente ON facturas
  FOR SELECT USING (
    get_rol_usuario() = 'cliente'
    AND cliente_id = (SELECT id FROM clientes WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()) LIMIT 1)
  );

CREATE POLICY facturas_modify ON facturas
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

-- ============================================================
-- POLICIES: logistica (rutas y entregas)
-- Chofer solo ve sus propias rutas
-- ============================================================
CREATE POLICY rutas_select_interno ON rutas
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
  );

CREATE POLICY rutas_select_chofer ON rutas
  FOR SELECT USING (
    get_rol_usuario() = 'chofer'
    AND chofer_id = auth.uid()
  );

CREATE POLICY rutas_modify ON rutas
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
  );

CREATE POLICY entregas_select ON entregas
  FOR SELECT USING (
    ruta_id IN (SELECT id FROM rutas WHERE empresa_id = get_empresa_id())
  );

CREATE POLICY entregas_modify ON entregas
  FOR ALL USING (
    ruta_id IN (SELECT id FROM rutas WHERE empresa_id = get_empresa_id())
  );

-- ============================================================
-- POLICIES: finanzas (cobros, cheques, cta_cte)
-- ============================================================
CREATE POLICY cobros_select ON cobros
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cobros_modify ON cobros
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cheques_select ON cheques
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cheques_modify ON cheques
  FOR ALL USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cta_cte_select_interno ON cta_cte
  FOR SELECT USING (
    cliente_id IN (SELECT id FROM clientes WHERE empresa_id = get_empresa_id())
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador', 'vendedor')
  );

CREATE POLICY cta_cte_select_cliente ON cta_cte
  FOR SELECT USING (
    get_rol_usuario() = 'cliente'
    AND cliente_id = (SELECT id FROM clientes WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()) LIMIT 1)
  );

-- ============================================================
-- FIN DE RLS
-- Continuar con 003_seed.sql
-- ============================================================
