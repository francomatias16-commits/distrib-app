-- 540_reconstruccion_retroactiva_calcular_deuda_cliente_cons_01_02_03.sql
--
-- Etapa 6 (consistencia e2e), sesión 2026-08-24. Reconstrucción retroactiva:
-- esta versión de calcular_deuda_cliente() ya estaba vigente en producción
-- (aplicada fuera de este flujo de migraciones, sin archivo en el repo).
-- Se documenta acá para que repo y producción queden consistentes.
--
-- Fix original (migración 066): SUM(CASE WHEN tipo='factura' THEN monto
-- ELSE -monto END) sobre cta_cte, calculado ahí mismo.
-- Versión vigente (esta): delega en clientes.saldo_deuda, mantenido por el
-- trigger sync_saldo_deuda_cliente (CASE completo: factura/debito/cargo/
-- nota_debito como deuda; cobro/credito/nota_credito/pago como pago;
-- excluye anulado). Evita duplicar la lógica de signos en dos lugares.
--
-- Ver también 541 (CONS-04): calcular_score_cliente ahora también delega
-- en esta función en vez de recalcular por su cuenta.

CREATE OR REPLACE FUNCTION public.calcular_deuda_cliente(p_cliente_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(saldo_deuda, 0) FROM public.clientes WHERE id = p_cliente_id;
$function$;

COMMENT ON FUNCTION public.calcular_deuda_cliente IS
  'Deuda total actual del cliente (no solo vencida). Delega en '
  'clientes.saldo_deuda, mantenido por el trigger sync_saldo_deuda_cliente '
  '(CASE completo por tipo de cta_cte, excluye anulado). Usada por la '
  'acción de cobranza del semáforo (score.js), reportes de priorización '
  'de cobranza, y desde esta migración también por el componente Deuda '
  'de calcular_score_cliente() (ver 541, CONS-04).';
