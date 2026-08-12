-- =============================================================================
-- 042_fix_productos_modify_roles.sql
-- CORRECCIÓN: productos_modify — agregar rol 'depositero'
--
-- 002_rls.sql definió:
--   get_rol_usuario() IN ('dueno', 'admin')
-- Pero auth.js del admin permite a 'depositero' acceder a /admin/productos.
-- Si un depositero crea/edita un producto, RLS lo bloquea silenciosamente.
-- Se agrega 'depositero' a la policy de modificación.
-- =============================================================================

DROP POLICY IF EXISTS productos_modify ON public.productos;

CREATE POLICY productos_modify ON public.productos
    FOR ALL USING (
        empresa_id = get_empresa_id()
        AND get_rol_usuario() IN ('dueno', 'admin', 'depositero')
    );
