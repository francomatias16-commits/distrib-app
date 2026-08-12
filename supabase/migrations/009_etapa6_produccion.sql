-- ============================================================
-- ETAPA 6: ESCALA Y PRODUCCIÓN
-- Optimizaciones de Onboarding, Índices y Seguridad
-- MF Web Solutions | v1.0 | Junio 2026
-- ============================================================

-- 1. FUNCIÓN DE ONBOARDING AUTOMATIZADO
-- Crea datos base necesarios para que una nueva distribuidora pueda operar
CREATE OR REPLACE FUNCTION onboarding_empresa(empresa_uuid UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deposito_id UUID;
    lista_id UUID;
BEGIN
    -- 1. Crear depósito principal
    INSERT INTO depositos (empresa_id, nombre, es_principal)
    VALUES (empresa_uuid, 'Depósito Central', true)
    RETURNING id INTO deposito_id;

    -- 2. Crear lista de precios por defecto
    INSERT INTO listas_precios (empresa_id, nombre, es_default, activa)
    VALUES (empresa_uuid, 'Lista General', true, true)
    RETURNING id INTO lista_id;

    -- 3. Crear zonas base (ejemplo)
    INSERT INTO zonas (empresa_id, nombre, activa)
    VALUES (empresa_uuid, 'Zona Local', true);

    -- 4. Crear categorías base
    INSERT INTO categorias (empresa_id, nombre, orden)
    VALUES (empresa_uuid, 'General', 0);

END;
$$;

-- 2. ÍNDICES ADICIONALES PARA PERFORMANCE
-- Optimizando búsquedas frecuentes de la Etapa 5 y 6
CREATE INDEX IF NOT EXISTS idx_pedidos_fecha_pedido ON pedidos(fecha_pedido);
CREATE INDEX IF NOT EXISTS idx_movimientos_stock_created ON movimientos_stock(created_at);
CREATE INDEX IF NOT EXISTS idx_cta_cte_fecha ON cta_cte(fecha);
CREATE INDEX IF NOT EXISTS idx_entregas_ruta ON entregas(ruta_id);
CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria_id);

-- 3. REFUERZO DE SEGURIDAD (HARDENING RLS)
-- Asegurar que los usuarios no puedan saltarse el aislamiento de empresa
-- incluso si intentan manipular el ID en el frontend

-- Forzar que empresa_id sea siempre el del usuario en INSERTs
CREATE OR REPLACE FUNCTION public.force_empresa_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.empresa_id := (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar trigger a tablas críticas
DROP TRIGGER IF EXISTS tr_force_empresa_pedidos ON pedidos;
CREATE TRIGGER tr_force_empresa_pedidos
BEFORE INSERT ON pedidos
FOR EACH ROW EXECUTE FUNCTION force_empresa_id();

DROP TRIGGER IF EXISTS tr_force_empresa_clientes ON clientes;
CREATE TRIGGER tr_force_empresa_clientes
BEFORE INSERT ON clientes
FOR EACH ROW EXECUTE FUNCTION force_empresa_id();

DROP TRIGGER IF EXISTS tr_force_empresa_productos ON productos;
CREATE TRIGGER tr_force_empresa_productos
BEFORE INSERT ON productos
FOR EACH ROW EXECUTE FUNCTION force_empresa_id();

-- 4. VISTA DE SUPERADMIN (SÓLO PARA MF WEB SOLUTIONS)
-- Permite ver métricas globales de todas las empresas
CREATE OR REPLACE VIEW superadmin_metrics AS
SELECT 
    e.nombre as empresa,
    e.cuit,
    COUNT(DISTINCT u.id) as total_usuarios,
    COUNT(DISTINCT c.id) as total_clientes,
    COUNT(DISTINCT p.id) as total_pedidos,
    SUM(p.total) as facturacion_total
FROM empresas e
LEFT JOIN usuarios u ON e.id = u.empresa_id
LEFT JOIN clientes c ON e.id = c.empresa_id
LEFT JOIN pedidos p ON e.id = p.empresa_id
GROUP BY e.id, e.nombre, e.cuit;

-- Solo el rol 'superadmin' (configurado en auth) podría ver esto
-- O podemos usar una policy específica si MF tiene un usuario especial
ALTER VIEW superadmin_metrics OWNER TO postgres;
