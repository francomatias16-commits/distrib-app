-- ─────────────────────────────────────────────────────────────────────────
-- 512_fn_cheques_contadores_depositado_anulado.sql
-- Fix de consistencia en la pantalla de Cheques: los contadores de arriba
-- (Todos / En cartera / Cobrado (mes) / Rechazados / Anulados) no sumaban
-- contra el total real de cheques paginado. Causa: fn_cheques_contadores()
-- (migración 259) nunca calculó "depositado" (sin tab/contador propio, un
-- cheque en ese estado quedaba en la tabla pero invisible arriba) ni
-- "anulado" (declarado en el tipo de retorno pero jamás agregado al SELECT,
-- por lo que "Anulados" siempre mostraba 0).
--
-- Se agregan monto_depositado/cant_depositado y monto_anulado/cant_anulado
-- al tipo de retorno. Ya no se puede usar CREATE OR REPLACE porque cambia
-- la forma de las columnas de salida (OUT params) — hay que hacer DROP +
-- CREATE. El frontend (cheques.js) se actualiza en el mismo cambio: agrega
-- la pestaña "Depositados" y corrige el mapeo `cant_anulados` (bug real,
-- con "s" de más, nunca hubiera coincidido con la columna `cant_anulado`
-- que devuelve esta función).
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_cheques_contadores();

CREATE FUNCTION public.fn_cheques_contadores()
 RETURNS TABLE(
   monto_cartera numeric, cant_cartera bigint,
   monto_proximos numeric, cant_proximos bigint,
   monto_cobrado_mes numeric, cant_cobrado_mes bigint,
   monto_rechazados numeric, cant_rechazados bigint,
   monto_depositado numeric, cant_depositado bigint,
   monto_anulado numeric, cant_anulado bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
  v_hoy        date := CURRENT_DATE;
  v_en3        date := CURRENT_DATE + INTERVAL '3 days';
  v_inicio_mes date := date_trunc('month', CURRENT_DATE)::date;
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(c.monto) FILTER (WHERE c.estado = 'en_cartera'), 0),
    COUNT(*)              FILTER (WHERE c.estado = 'en_cartera'),
    COALESCE(SUM(c.monto) FILTER (
      WHERE c.estado = 'en_cartera' AND c.vencimiento BETWEEN v_hoy AND v_en3
    ), 0),
    COUNT(*)              FILTER (
      WHERE c.estado = 'en_cartera' AND c.vencimiento BETWEEN v_hoy AND v_en3
    ),
    COALESCE(SUM(c.monto) FILTER (
      WHERE c.estado = 'cobrado' AND c.vencimiento >= v_inicio_mes
    ), 0),
    COUNT(*)              FILTER (
      WHERE c.estado = 'cobrado' AND c.vencimiento >= v_inicio_mes
    ),
    COALESCE(SUM(c.monto) FILTER (WHERE c.estado = 'rechazado'), 0),
    COUNT(*)              FILTER (WHERE c.estado = 'rechazado'),
    COALESCE(SUM(c.monto) FILTER (WHERE c.estado = 'depositado'), 0),
    COUNT(*)              FILTER (WHERE c.estado = 'depositado'),
    COALESCE(SUM(c.monto) FILTER (WHERE c.estado = 'anulado'), 0),
    COUNT(*)              FILTER (WHERE c.estado = 'anulado')
  FROM public.cheques c
  WHERE c.empresa_id = v_empresa_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_cheques_contadores() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cheques_contadores() TO authenticated, service_role;
