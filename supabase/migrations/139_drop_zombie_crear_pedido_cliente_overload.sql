-- 139_drop_zombie_crear_pedido_cliente_overload.sql
-- Aplicada en Supabase: 2026-06-30 (auditoría)
--
-- Elimina el overload viejo/no usado de crear_pedido_cliente (4 args, portal_cliente directo).
-- El flujo real de la app usa exclusivamente el overload de 10 args llamado desde
-- lib/handlers/pedidos.js con service_role. Este overload de 4 args estaba otorgado
-- a 'authenticated' y era invocable directo desde el cliente sin pasar por las
-- validaciones de negocio (bloqueos_cliente, score, reserva de stock) que sí aplica
-- el flujo real.
--
-- Verificado antes de dropear: el SECURITY DEFINER internamente sí validaba
-- auth.uid() contra el cliente_id pedido, así que NO era un IDOR cross-tenant
-- explotable. Se elimina igual por higiene: es código zombie callable directo
-- que duplica lógica de negocio sin las mismas validaciones del flujo oficial.

DROP FUNCTION IF EXISTS public.crear_pedido_cliente(uuid, jsonb, text, text);
