-- PORTAL-CLIENTE-AUDIT-01 (auditoría etapa 4, hallazgo crítico):
-- pedidos_update y pedidos_insert solo verificaban `empresa_id =
-- auth_empresa_id()`, sin el mismo scoping por rol/cliente_id que ya
-- tiene pedidos_select_unificada. Efecto: cualquier usuario autenticado
-- con rol='cliente' podía, llamando directo al SDK de Supabase desde la
-- consola del navegador (con su propio JWT + anon key, ya cargados en
-- cualquier página del portal cliente), actualizar o insertar filas de
-- `pedidos` de OTRO cliente de la misma empresa — cambiar estado, total,
-- cliente_id, etc. No lo explota el flujo normal de la app (el checkout
-- real pasa por /api/pedidos con service_role), pero es una vulnerabilidad
-- real y directamente explotable, no defensa en profundidad.
--
-- Fix: mismo criterio que pedidos_select_unificada — rol='cliente' queda
-- acotado a cliente_id propio; roles de staff (dueno/admin/vendedor/
-- depositero/chofer/contador) siguen con acceso a nivel empresa, igual
-- que antes; service_role sin cambios.
DROP POLICY IF EXISTS pedidos_update ON public.pedidos;
CREATE POLICY pedidos_update ON public.pedidos
FOR UPDATE
USING (
  (SELECT auth.role()) = 'service_role'
  OR (
    (SELECT rol FROM usuarios WHERE id = (SELECT auth.uid()) LIMIT 1) = 'cliente'
    AND cliente_id = (
      SELECT c.id FROM clientes c JOIN usuarios u ON u.cliente_id = c.id
      WHERE u.id = (SELECT auth.uid()) LIMIT 1
    )
  )
  OR (
    empresa_id = auth_empresa_id()
    AND (SELECT rol FROM usuarios WHERE id = (SELECT auth.uid()) LIMIT 1)
        = ANY (ARRAY['dueno','admin','vendedor','depositero','chofer','contador']::rol_usuario[])
  )
);

DROP POLICY IF EXISTS pedidos_insert ON public.pedidos;
CREATE POLICY pedidos_insert ON public.pedidos
FOR INSERT
WITH CHECK (
  (SELECT auth.role()) = 'service_role'
  OR (
    (SELECT rol FROM usuarios WHERE id = (SELECT auth.uid()) LIMIT 1) = 'cliente'
    AND cliente_id = (
      SELECT c.id FROM clientes c JOIN usuarios u ON u.cliente_id = c.id
      WHERE u.id = (SELECT auth.uid()) LIMIT 1
    )
    AND empresa_id = auth_empresa_id()
  )
  OR (
    empresa_id = auth_empresa_id()
    AND (SELECT rol FROM usuarios WHERE id = (SELECT auth.uid()) LIMIT 1)
        = ANY (ARRAY['dueno','admin','vendedor','depositero','chofer','contador']::rol_usuario[])
  )
);
