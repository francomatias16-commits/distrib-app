-- PERF-06 parte 1: envolver auth.uid() en (select ...) para evitar re-evaluación por fila
BEGIN;

ALTER POLICY saldo_puntos_select ON public.saldo_puntos
  USING (es_admin() OR (cliente_id IN ( SELECT clientes.id FROM clientes WHERE clientes.usuario_id = (select auth.uid()))));

ALTER POLICY movimientos_puntos_select ON public.movimientos_puntos
  USING (es_admin() OR (cliente_id IN ( SELECT clientes.id FROM clientes WHERE clientes.usuario_id = (select auth.uid()))));

ALTER POLICY canjes_select ON public.canjes_recompensas
  USING (es_admin() OR (cliente_id IN ( SELECT clientes.id FROM clientes WHERE clientes.usuario_id = (select auth.uid()))));

ALTER POLICY canjes_insert ON public.canjes_recompensas
  WITH CHECK (es_admin() OR (cliente_id IN ( SELECT clientes.id FROM clientes WHERE clientes.usuario_id = (select auth.uid()))));

COMMIT;
