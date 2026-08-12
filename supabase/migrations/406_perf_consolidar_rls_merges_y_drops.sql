BEGIN;

-- ===== Drops de políticas redundantes (idéntica condición ya cubierta por otra) =====

-- cheques_select es idéntica a cheques_modify (ALL), que ya cubre SELECT
DROP POLICY IF EXISTS "cheques_select" ON public.cheques;

-- cobros_select es idéntica a cobros_modify (ALL), que ya cubre SELECT
DROP POLICY IF EXISTS "cobros_select" ON public.cobros;

-- entregas_select es idéntica a entregas_modify (ALL), que ya cubre SELECT
DROP POLICY IF EXISTS "entregas_select" ON public.entregas;

-- facturacion_config: fc_delete/fc_insert/fc_update son idénticas a service_role_all_facturacion_config (ALL)
DROP POLICY IF EXISTS "fc_delete" ON public.facturacion_config;
DROP POLICY IF EXISTS "fc_insert" ON public.facturacion_config;
DROP POLICY IF EXISTS "fc_update" ON public.facturacion_config;

-- tokens_wsaa: tw_all es idéntica (USING y WITH CHECK) a service_role_all_tokens_wsaa
DROP POLICY IF EXISTS "tw_all" ON public.tokens_wsaa;

-- devoluciones_pos_items: dev_items_insert/select son duplicados literales (misma lógica, distinta sintaxis) de devoluciones_items_insert/select
DROP POLICY IF EXISTS "dev_items_insert" ON public.devoluciones_pos_items;
DROP POLICY IF EXISTS "dev_items_select" ON public.devoluciones_pos_items;

-- ===== Fusionar pares de políticas SELECT-only en una sola (OR de ambas condiciones) =====

-- carrito_items: fusionar ['carrito_admin_select', 'carrito_select'] en 'carrito_select_unificada'
DROP POLICY IF EXISTS "carrito_admin_select" ON public.carrito_items;
DROP POLICY IF EXISTS "carrito_select" ON public.carrito_items;
CREATE POLICY "carrito_select_unificada" ON public.carrito_items FOR SELECT USING ((EXISTS ( SELECT 1 FROM usuarios u WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (u.empresa_id = carrito_items.empresa_id) AND (u.rol = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'vendedor'::rol_usuario]))))) OR (cliente_id IN ( SELECT usuarios.cliente_id FROM usuarios WHERE ((usuarios.id = ( SELECT auth.uid() AS uid)) AND (usuarios.cliente_id IS NOT NULL)))));

-- clientes: fusionar ['clientes_select_interno', 'clientes_select_portal'] en 'clientes_select_unificada'
DROP POLICY IF EXISTS "clientes_select_interno" ON public.clientes;
DROP POLICY IF EXISTS "clientes_select_portal" ON public.clientes;
CREATE POLICY "clientes_select_unificada" ON public.clientes FOR SELECT USING (((empresa_id = get_empresa_id()) AND ((get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'vendedor'::rol_usuario, 'depositero'::rol_usuario, 'contador'::rol_usuario])) OR ((get_rol_usuario() = 'chofer'::rol_usuario) AND (id IN ( SELECT chofer_clientes_ids() AS chofer_clientes_ids))))) OR (usuario_id = ( SELECT auth.uid() AS uid)));

-- ofertas_liquidacion: fusionar ['ofertas_liq_select_admin', 'ofertas_liq_select_cliente'] en 'ofertas_liq_select_unificada'
DROP POLICY IF EXISTS "ofertas_liq_select_admin" ON public.ofertas_liquidacion;
DROP POLICY IF EXISTS "ofertas_liq_select_cliente" ON public.ofertas_liquidacion;
CREATE POLICY "ofertas_liq_select_unificada" ON public.ofertas_liquidacion FOR SELECT USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'vendedor'::rol_usuario]))) OR ((empresa_id = get_empresa_id()) AND (activa = true) AND (get_rol_usuario() = 'cliente'::rol_usuario)));

-- pedidos: fusionar ['pedidos_select_cliente', 'pedidos_select_interno'] en 'pedidos_select_unificada'
DROP POLICY IF EXISTS "pedidos_select_cliente" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_select_interno" ON public.pedidos;
CREATE POLICY "pedidos_select_unificada" ON public.pedidos FOR SELECT USING (((( SELECT usuarios.rol FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)) LIMIT 1) = 'cliente'::rol_usuario) AND (cliente_id = ( SELECT c.id FROM (clientes c JOIN usuarios u ON ((u.cliente_id = c.id))) WHERE (u.id = ( SELECT auth.uid() AS uid)) LIMIT 1))) OR ((( SELECT auth.role() AS role) = 'service_role'::text) OR ((empresa_id = auth_empresa_id()) AND (( SELECT usuarios.rol FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)) LIMIT 1) = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'vendedor'::rol_usuario, 'depositero'::rol_usuario, 'chofer'::rol_usuario, 'contador'::rol_usuario])))));

-- saas_facturas: fusionar ['saas_facturas_operador', 'saas_facturas_own'] en 'saas_facturas_select_unificada'
DROP POLICY IF EXISTS "saas_facturas_operador" ON public.saas_facturas;
DROP POLICY IF EXISTS "saas_facturas_own" ON public.saas_facturas;
CREATE POLICY "saas_facturas_select_unificada" ON public.saas_facturas FOR SELECT USING (is_saas_owner() OR (empresa_id = get_empresa_id()));

-- audit_log: fusionar ['audit_admins_select', 'audit_log_select'] en 'audit_log_select_unificada'
DROP POLICY IF EXISTS "audit_admins_select" ON public.audit_log;
DROP POLICY IF EXISTS "audit_log_select" ON public.audit_log;
CREATE POLICY "audit_log_select_unificada" ON public.audit_log FOR SELECT USING ((empresa_id IN ( SELECT usuarios.empresa_id FROM usuarios WHERE ((usuarios.id = ( SELECT auth.uid() AS uid)) AND (usuarios.rol = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))))) OR ((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- ===== rutas: caso especial (ALL + 2 SELECT, uno de ellos redundante con el ALL) =====
-- rutas_select_interno es idéntica a rutas_modify (ALL); se fusiona junto con rutas_select_chofer
DROP POLICY IF EXISTS "rutas_select_interno" ON public.rutas;
DROP POLICY IF EXISTS "rutas_select_chofer" ON public.rutas;
CREATE POLICY "rutas_select_unificada" ON public.rutas FOR SELECT USING (
  ((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario])))
  OR ((get_rol_usuario() = 'chofer'::rol_usuario) AND (chofer_id = ( SELECT auth.uid() AS uid)))
);

COMMIT;