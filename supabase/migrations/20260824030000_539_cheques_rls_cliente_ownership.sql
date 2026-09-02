-- 539_cheques_rls_cliente_ownership.sql
--
-- Auditoría Cheques, 2026-08-24. frontend/admin/js/cheques.js escribe
-- SIEMPRE directo contra PostgREST (/rest/v1/cheques), sin pasar por
-- ningún handler de backend — acá la RLS es la ÚNICA capa de control.
--
-- Hallazgo CHEQUES-001 (🟠 Media, cross-tenant): las policies
-- cheques_insert/cheques_update (migración 012) validan
-- empresa_id = get_empresa_id(), pero NUNCA validan que cliente_id
-- pertenezca a esa misma empresa — mismo patrón que CLIENTES-002/
-- REGLAS-001 (ronda 2026-07-26), acá sin corregir todavía. Cualquier
-- usuario dueño/admin/contador podía insertar (o editar) un cheque con
-- su propio empresa_id pero un cliente_id de OTRO tenant. Impacto real
-- confirmado: fn_cheques_lista (259/522) hace
-- "LEFT JOIN clientes cli ON cli.id = c.cliente_id" sin filtrar por
-- empresa en el join — un cliente_id ajeno se resuelve igual y expone
-- razon_social/nombre_fantasia de un cliente de OTRA empresa en el
-- listado de cheques propio.
--
-- Nota aparte (a verificar manualmente en el dashboard, no accionable
-- desde acá): la migración 406 borró "cheques_select" asumiendo que
-- era redundante con una policy "cheques_modify" FOR ALL — pero
-- ninguna migración del repo recreó "cheques_modify" después de que
-- 012 la reemplazara por policies separadas (select/insert/update).
-- Si esa policy ALL no existe realmente en producción (fuera del
-- repo, por drift), la pantalla de Cheques debería estar rota para
-- todos hoy; si SÍ existe (creada manualmente, sin migración), este
-- script no rompe nada. Por las dudas, se reafirma cheques_select acá
-- de forma idempotente.

DROP POLICY IF EXISTS cheques_select ON public.cheques;
DROP POLICY IF EXISTS cheques_insert ON public.cheques;
DROP POLICY IF EXISTS cheques_update ON public.cheques;
DROP POLICY IF EXISTS cheques_modify ON public.cheques;

CREATE POLICY cheques_select ON public.cheques
  FOR SELECT USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  );

CREATE POLICY cheques_insert ON public.cheques
  FOR INSERT WITH CHECK (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
    AND (
      cliente_id IS NULL
      OR cliente_id IN (SELECT id FROM public.clientes WHERE empresa_id = get_empresa_id())
    )
  );

CREATE POLICY cheques_update ON public.cheques
  FOR UPDATE USING (
    empresa_id = get_empresa_id()
    AND get_rol_usuario() IN ('dueno', 'admin', 'contador')
  )
  WITH CHECK (
    empresa_id = get_empresa_id()
    AND (
      cliente_id IS NULL
      OR cliente_id IN (SELECT id FROM public.clientes WHERE empresa_id = get_empresa_id())
    )
  );

-- Nota: sigue sin existir policy de DELETE (a propósito, ver el FIX del
-- "hallazgo 3, auditoría CRUD 2026" en frontend/admin/js/cheques.js —
-- eliminarCheque() ya hace PATCH a estado='anulado', no DELETE real).
