-- Fase 5 (auditoría de negocio centralizada): la policy SELECT de
-- eventos_negocio dejaba ver los eventos de la empresa a CUALQUIER rol
-- (chofer, vendedor, cliente, etc.) — heredado de cuando la tabla era
-- solo un mecanismo interno (outbox pattern) sin UI encima. Ahora que se
-- expone como reporte de "qué pasó en mi negocio" para dueño/admin, se
-- restringe al mismo criterio que ya usa audit_log_select_unificada.
-- No afecta al despachador ni a los listeners: siguen leyendo/escribiendo
-- con el cliente service_role, que bypassea RLS por completo.

drop policy if exists eventos_negocio_select_empresa on public.eventos_negocio;

create policy eventos_negocio_select_dueno_admin
  on public.eventos_negocio
  for select
  to public
  using (
    empresa_id = get_empresa_id()
    and get_rol_usuario() = any (array['dueno','admin']::rol_usuario[])
  );
