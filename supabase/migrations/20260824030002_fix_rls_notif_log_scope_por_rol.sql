-- SEC: notif_log no tenía scoping por rol en SELECT/INSERT/UPDATE/DELETE,
-- solo por empresa_id — a diferencia de pedidos/cta_cte, que sí exigen
-- rol='cliente' + cliente_id propio para el rol cliente. Como cliente y
-- chofer son roles de la misma tabla `usuarios` que ya cargan supabase-js
-- con sesión logueada en sus portales, cualquier cliente o chofer podía
-- leer (y escribir/borrar) el notif_log completo de toda la empresa
-- (teléfonos y montos de deuda vencida de otros clientes incluidos).
--
-- Fix: SELECT igual que pedidos_select_unificada — staff ve todo lo de
-- su empresa, cliente solo lo propio (via usuarios.cliente_id). chofer
-- queda afuera por ahora: notif_log solo registra notificaciones hacia
-- clientes (deuda, pedido entregado/en camino, puntos, oferta), no hay
-- ningún push logueado hacia chofer — no hay caso de uso hoy, se agrega
-- cuando exista.
-- INSERT/UPDATE/DELETE: se restringen a staff. Ningún frontend
-- (admin/cliente/chofer) escribe notif_log de forma directa — todos los
-- inserts/updates reales pasan por el backend con service_role, que
-- bypassea RLS. Dejarlas abiertas a cualquier usuario de la empresa sin
-- chequeo de rol no protegía nada real, solo dejaba una puerta sin uso.

drop policy if exists "ver notif_log propia empresa" on public.notif_log;
drop policy if exists "notif_log_empresa_insert" on public.notif_log;
drop policy if exists "notif_log_empresa_update" on public.notif_log;
drop policy if exists "notif_log_empresa_delete" on public.notif_log;

create policy "notif_log_select_unificada" on public.notif_log
for select
using (
  (select auth.role()) = 'service_role'
  or (
    get_rol_usuario() = ANY (ARRAY['dueno','admin','vendedor','depositero','contador']::rol_usuario[])
    and empresa_id = auth_empresa_id()
  )
  or (
    get_rol_usuario() = 'cliente'
    and cliente_id = (
      select c.id from clientes c
      join usuarios u on u.cliente_id = c.id
      where u.id = (select auth.uid())
      limit 1
    )
  )
);

create policy "notif_log_staff_insert" on public.notif_log
for insert
with check (
  (select auth.role()) = 'service_role'
  or (
    get_rol_usuario() = ANY (ARRAY['dueno','admin','vendedor','depositero','contador']::rol_usuario[])
    and empresa_id = auth_empresa_id()
  )
);

create policy "notif_log_staff_update" on public.notif_log
for update
using (
  (select auth.role()) = 'service_role'
  or (
    get_rol_usuario() = ANY (ARRAY['dueno','admin','vendedor','depositero','contador']::rol_usuario[])
    and empresa_id = auth_empresa_id()
  )
)
with check (
  (select auth.role()) = 'service_role'
  or (
    get_rol_usuario() = ANY (ARRAY['dueno','admin','vendedor','depositero','contador']::rol_usuario[])
    and empresa_id = auth_empresa_id()
  )
);

create policy "notif_log_staff_delete" on public.notif_log
for delete
using (
  (select auth.role()) = 'service_role'
  or (
    get_rol_usuario() = ANY (ARRAY['dueno','admin','vendedor','depositero','contador']::rol_usuario[])
    and empresa_id = auth_empresa_id()
  )
);
