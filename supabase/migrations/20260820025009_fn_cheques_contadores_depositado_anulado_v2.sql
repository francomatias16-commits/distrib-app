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
