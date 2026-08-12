-- Migración 405: consolidar políticas RLS permisivas duplicadas (PERF-05)
-- Patrón: política FOR ALL + política FOR SELECT separada = doble evaluación en cada SELECT.
-- Fix: partir la FOR ALL en INSERT/UPDATE/DELETE (Postgres no permite combinar comandos en una policy),
-- dejando la FOR SELECT como única política para lecturas. Mismo comportamiento, sin duplicar evaluación.
BEGIN;

-- bloqueos_cliente: partir bloqueos_empresa (ALL) en insert/update/delete
DROP POLICY IF EXISTS "bloqueos_empresa" ON public.bloqueos_cliente;
CREATE POLICY "bloqueos_empresa_insert" ON public.bloqueos_cliente FOR INSERT WITH CHECK ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "bloqueos_empresa_update" ON public.bloqueos_cliente FOR UPDATE USING ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "bloqueos_empresa_delete" ON public.bloqueos_cliente FOR DELETE USING ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));

-- cajas_pos: partir service_role_all_cajas_pos (ALL) en insert/update/delete
DROP POLICY IF EXISTS "service_role_all_cajas_pos" ON public.cajas_pos;
CREATE POLICY "service_role_all_cajas_pos_insert" ON public.cajas_pos FOR INSERT WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_cajas_pos_update" ON public.cajas_pos FOR UPDATE USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_cajas_pos_delete" ON public.cajas_pos FOR DELETE USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- categorias: partir categorias_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "categorias_modify" ON public.categorias;
CREATE POLICY "categorias_modify_insert" ON public.categorias FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "categorias_modify_update" ON public.categorias FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "categorias_modify_delete" ON public.categorias FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- conciliacion_bancaria_lotes: partir conciliacion_lotes_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "conciliacion_lotes_modify" ON public.conciliacion_bancaria_lotes;
CREATE POLICY "conciliacion_lotes_modify_insert" ON public.conciliacion_bancaria_lotes FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "conciliacion_lotes_modify_update" ON public.conciliacion_bancaria_lotes FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "conciliacion_lotes_modify_delete" ON public.conciliacion_bancaria_lotes FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));

-- conciliacion_bancaria_movimientos: partir conciliacion_mov_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "conciliacion_mov_modify" ON public.conciliacion_bancaria_movimientos;
CREATE POLICY "conciliacion_mov_modify_insert" ON public.conciliacion_bancaria_movimientos FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "conciliacion_mov_modify_update" ON public.conciliacion_bancaria_movimientos FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "conciliacion_mov_modify_delete" ON public.conciliacion_bancaria_movimientos FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));

-- contadores_empresa: partir contadores_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "contadores_modify" ON public.contadores_empresa;
CREATE POLICY "contadores_modify_insert" ON public.contadores_empresa FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "contadores_modify_update" ON public.contadores_empresa FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "contadores_modify_delete" ON public.contadores_empresa FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- depositos: partir depositos_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "depositos_modify" ON public.depositos;
CREATE POLICY "depositos_modify_insert" ON public.depositos FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "depositos_modify_update" ON public.depositos FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "depositos_modify_delete" ON public.depositos FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- export_contable_config: partir export_contable_config_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "export_contable_config_modify" ON public.export_contable_config;
CREATE POLICY "export_contable_config_modify_insert" ON public.export_contable_config FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "export_contable_config_modify_update" ON public.export_contable_config FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "export_contable_config_modify_delete" ON public.export_contable_config FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- facturas: partir facturas_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "facturas_modify" ON public.facturas;
CREATE POLICY "facturas_modify_insert" ON public.facturas FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "facturas_modify_update" ON public.facturas FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "facturas_modify_delete" ON public.facturas FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));

-- listas_precios: partir listas_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "listas_modify" ON public.listas_precios;
CREATE POLICY "listas_modify_insert" ON public.listas_precios FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "listas_modify_update" ON public.listas_precios FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "listas_modify_delete" ON public.listas_precios FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));

-- movimientos_caja: partir service_role_all_movimientos_caja (ALL) en insert/update/delete
DROP POLICY IF EXISTS "service_role_all_movimientos_caja" ON public.movimientos_caja;
CREATE POLICY "service_role_all_movimientos_caja_insert" ON public.movimientos_caja FOR INSERT WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_movimientos_caja_update" ON public.movimientos_caja FOR UPDATE USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_movimientos_caja_delete" ON public.movimientos_caja FOR DELETE USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- notas_credito: partir nc_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "nc_modify" ON public.notas_credito;
CREATE POLICY "nc_modify_insert" ON public.notas_credito FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "nc_modify_update" ON public.notas_credito FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "nc_modify_delete" ON public.notas_credito FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- notas_credito_items: partir nci_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "nci_modify" ON public.notas_credito_items;
CREATE POLICY "nci_modify_insert" ON public.notas_credito_items FOR INSERT WITH CHECK ((EXISTS ( SELECT 1 FROM notas_credito nc WHERE ((nc.id = notas_credito_items.nota_credito_id) AND (nc.empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))))));
CREATE POLICY "nci_modify_update" ON public.notas_credito_items FOR UPDATE USING ((EXISTS ( SELECT 1 FROM notas_credito nc WHERE ((nc.id = notas_credito_items.nota_credito_id) AND (nc.empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))))) WITH CHECK ((EXISTS ( SELECT 1 FROM notas_credito nc WHERE ((nc.id = notas_credito_items.nota_credito_id) AND (nc.empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))))));
CREATE POLICY "nci_modify_delete" ON public.notas_credito_items FOR DELETE USING ((EXISTS ( SELECT 1 FROM notas_credito nc WHERE ((nc.id = notas_credito_items.nota_credito_id) AND (nc.empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))))));

-- notas_internas: partir notas_internas_empresa (ALL) en insert/update/delete
DROP POLICY IF EXISTS "notas_internas_empresa" ON public.notas_internas;
CREATE POLICY "notas_internas_empresa_insert" ON public.notas_internas FOR INSERT WITH CHECK ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "notas_internas_empresa_update" ON public.notas_internas FOR UPDATE USING ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "notas_internas_empresa_delete" ON public.notas_internas FOR DELETE USING ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));

-- notif_log: partir notif_log_empresa (ALL) en insert/update/delete
DROP POLICY IF EXISTS "notif_log_empresa" ON public.notif_log;
CREATE POLICY "notif_log_empresa_insert" ON public.notif_log FOR INSERT WITH CHECK ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "notif_log_empresa_update" ON public.notif_log FOR UPDATE USING ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY "notif_log_empresa_delete" ON public.notif_log FOR DELETE USING ((empresa_id = ( SELECT usuarios.empresa_id FROM usuarios WHERE (usuarios.id = ( SELECT auth.uid() AS uid)))));

-- pedido_items: partir pedido_items_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "pedido_items_modify" ON public.pedido_items;
CREATE POLICY "pedido_items_modify_insert" ON public.pedido_items FOR INSERT WITH CHECK (((( SELECT auth.role() AS role) = 'service_role'::text) OR (pedido_id IN ( SELECT pedidos.id FROM pedidos WHERE (pedidos.empresa_id = auth_empresa_id())))));
CREATE POLICY "pedido_items_modify_update" ON public.pedido_items FOR UPDATE USING (((( SELECT auth.role() AS role) = 'service_role'::text) OR (pedido_id IN ( SELECT pedidos.id FROM pedidos WHERE (pedidos.empresa_id = auth_empresa_id()))))) WITH CHECK (((( SELECT auth.role() AS role) = 'service_role'::text) OR (pedido_id IN ( SELECT pedidos.id FROM pedidos WHERE (pedidos.empresa_id = auth_empresa_id())))));
CREATE POLICY "pedido_items_modify_delete" ON public.pedido_items FOR DELETE USING (((( SELECT auth.role() AS role) = 'service_role'::text) OR (pedido_id IN ( SELECT pedidos.id FROM pedidos WHERE (pedidos.empresa_id = auth_empresa_id())))));

-- pos_favoritos: partir service_role_all_pos_favoritos (ALL) en insert/update/delete
DROP POLICY IF EXISTS "service_role_all_pos_favoritos" ON public.pos_favoritos;
CREATE POLICY "service_role_all_pos_favoritos_insert" ON public.pos_favoritos FOR INSERT WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_pos_favoritos_update" ON public.pos_favoritos FOR UPDATE USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_pos_favoritos_delete" ON public.pos_favoritos FOR DELETE USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- precios_clientes: partir precios_clientes_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "precios_clientes_modify" ON public.precios_clientes;
CREATE POLICY "precios_clientes_modify_insert" ON public.precios_clientes FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "precios_clientes_modify_update" ON public.precios_clientes FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "precios_clientes_modify_delete" ON public.precios_clientes FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));

-- precios_items: partir precios_items_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "precios_items_modify" ON public.precios_items;
CREATE POLICY "precios_items_modify_insert" ON public.precios_items FOR INSERT WITH CHECK (((lista_id IN ( SELECT listas_precios.id FROM listas_precios WHERE (listas_precios.empresa_id = get_empresa_id()))) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "precios_items_modify_update" ON public.precios_items FOR UPDATE USING (((lista_id IN ( SELECT listas_precios.id FROM listas_precios WHERE (listas_precios.empresa_id = get_empresa_id()))) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])))) WITH CHECK (((lista_id IN ( SELECT listas_precios.id FROM listas_precios WHERE (listas_precios.empresa_id = get_empresa_id()))) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "precios_items_modify_delete" ON public.precios_items FOR DELETE USING (((lista_id IN ( SELECT listas_precios.id FROM listas_precios WHERE (listas_precios.empresa_id = get_empresa_id()))) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));

-- productos: partir productos_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "productos_modify" ON public.productos;
CREATE POLICY "productos_modify_insert" ON public.productos FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "productos_modify_update" ON public.productos FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "productos_modify_delete" ON public.productos FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- proveedores: partir proveedores_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "proveedores_modify" ON public.proveedores;
CREATE POLICY "proveedores_modify_insert" ON public.proveedores FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "proveedores_modify_update" ON public.proveedores FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "proveedores_modify_delete" ON public.proveedores FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- reglas_precio: partir reglas_precio_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "reglas_precio_modify" ON public.reglas_precio;
CREATE POLICY "reglas_precio_modify_insert" ON public.reglas_precio FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "reglas_precio_modify_update" ON public.reglas_precio FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));
CREATE POLICY "reglas_precio_modify_delete" ON public.reglas_precio FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'contador'::rol_usuario]))));

-- saas_config: partir saas_config_write (ALL) en insert/update/delete
DROP POLICY IF EXISTS "saas_config_write" ON public.saas_config;
CREATE POLICY "saas_config_write_insert" ON public.saas_config FOR INSERT WITH CHECK (is_saas_owner());
CREATE POLICY "saas_config_write_update" ON public.saas_config FOR UPDATE USING (is_saas_owner()) WITH CHECK (is_saas_owner());
CREATE POLICY "saas_config_write_delete" ON public.saas_config FOR DELETE USING (is_saas_owner());

-- stock: partir stock_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "stock_modify" ON public.stock;
CREATE POLICY "stock_modify_insert" ON public.stock FOR INSERT WITH CHECK (((deposito_id IN ( SELECT depositos.id FROM depositos WHERE (depositos.empresa_id = get_empresa_id()))) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario]))));
CREATE POLICY "stock_modify_update" ON public.stock FOR UPDATE USING (((deposito_id IN ( SELECT depositos.id FROM depositos WHERE (depositos.empresa_id = get_empresa_id()))) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario])))) WITH CHECK (((deposito_id IN ( SELECT depositos.id FROM depositos WHERE (depositos.empresa_id = get_empresa_id()))) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario]))));
CREATE POLICY "stock_modify_delete" ON public.stock FOR DELETE USING (((deposito_id IN ( SELECT depositos.id FROM depositos WHERE (depositos.empresa_id = get_empresa_id()))) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario]))));

-- turnos_caja: partir service_role_all_turnos_caja (ALL) en insert/update/delete
DROP POLICY IF EXISTS "service_role_all_turnos_caja" ON public.turnos_caja;
CREATE POLICY "service_role_all_turnos_caja_insert" ON public.turnos_caja FOR INSERT WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_turnos_caja_update" ON public.turnos_caja FOR UPDATE USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_turnos_caja_delete" ON public.turnos_caja FOR DELETE USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- venta_pos_items: partir service_role_all_venta_pos_items (ALL) en insert/update/delete
DROP POLICY IF EXISTS "service_role_all_venta_pos_items" ON public.venta_pos_items;
CREATE POLICY "service_role_all_venta_pos_items_insert" ON public.venta_pos_items FOR INSERT WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_venta_pos_items_update" ON public.venta_pos_items FOR UPDATE USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_venta_pos_items_delete" ON public.venta_pos_items FOR DELETE USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- ventas_pos: partir service_role_all_ventas_pos (ALL) en insert/update/delete
DROP POLICY IF EXISTS "service_role_all_ventas_pos" ON public.ventas_pos;
CREATE POLICY "service_role_all_ventas_pos_insert" ON public.ventas_pos FOR INSERT WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_ventas_pos_update" ON public.ventas_pos FOR UPDATE USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "service_role_all_ventas_pos_delete" ON public.ventas_pos FOR DELETE USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- zonas: partir zonas_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "zonas_modify" ON public.zonas;
CREATE POLICY "zonas_modify_insert" ON public.zonas FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "zonas_modify_update" ON public.zonas FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));
CREATE POLICY "zonas_modify_delete" ON public.zonas FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario]))));

-- rutas: partir rutas_modify (ALL) en insert/update/delete
DROP POLICY IF EXISTS "rutas_modify" ON public.rutas;
CREATE POLICY "rutas_modify_insert" ON public.rutas FOR INSERT WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario]))));
CREATE POLICY "rutas_modify_update" ON public.rutas FOR UPDATE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario])))) WITH CHECK (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario]))));
CREATE POLICY "rutas_modify_delete" ON public.rutas FOR DELETE USING (((empresa_id = get_empresa_id()) AND (get_rol_usuario() = ANY (ARRAY['dueno'::rol_usuario, 'admin'::rol_usuario, 'depositero'::rol_usuario]))));

COMMIT;