-- ─────────────────────────────────────────────────────────────────────────
-- 261_rpc_riesgo_cheques_lista_server_side.sql
-- Auditoría de filtros v280, ítem 4 del plan de acción, siguiente pantalla
-- tras Cheques (259/260): frontend/admin/js/riesgo-cheques.js.
--
-- Problema: `cargarRiesgoCheques()` traía hasta 1000 cheques crudos
-- (`.limit(1000), // tope de seguridad, igual que cheques.js`) con el join
-- a `clientes`, y agrupaba por cliente a mano en JS (objeto `porCliente`,
-- sumando monto/cantidad de cartera y de rechazados por estado) para
-- después quedarse solo con los clientes con cartera o rechazados > 0.
-- Es exactamente el patrón de la sección 2 de la auditoría: la agregación
-- que hoy se hace recorriendo el array en el navegador es una sola query
-- GROUP BY en Postgres.
--
-- Se agrega fn_riesgo_cheques_lista(): agregación por cliente (monto y
-- cantidad de cartera+depositado, monto y cantidad de rechazados, score y
-- categoría de riesgo del cliente) resuelta enteramente en SQL, ya
-- filtrada a los clientes con exposición actual o antecedentes (mismo
-- criterio que el `Object.values(porCliente).filter(...)` de hoy), sin el
-- techo de 1000 cheques.
--
-- Lo que NO se toca: `cargarAlertasPorCliente()` y `cargarDeudaPorCliente()`
-- siguen pegando a /api/score (alertas de score, cobranza priorizada) tal
-- cual — son fuentes externas de bajo volumen, ya documentadas en el header
-- del archivo como por qué no se llaman directo por RPC (permisos de
-- v_cobranza_priorizada). El merge de esos dos mapas sobre el resultado de
-- esta RPC se sigue haciendo en JS, igual que antes.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_riesgo_cheques_lista()
 RETURNS TABLE(
   id uuid, nombre text, cuit text,
   score integer, categoria text,
   cartera_monto numeric, cartera_cantidad bigint,
   rechazados_monto numeric, rechazados_cantidad bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  SELECT
    cli.id,
    COALESCE(cli.nombre_fantasia, cli.razon_social, 'Cliente') AS nombre,
    cli.cuit,
    COALESCE(cli.score_actual, 50)        AS score,
    COALESCE(cli.score_categoria, 'normal') AS categoria,
    COALESCE(SUM(c.monto) FILTER (WHERE c.estado IN ('en_cartera', 'depositado')), 0) AS cartera_monto,
    COUNT(*)              FILTER (WHERE c.estado IN ('en_cartera', 'depositado'))     AS cartera_cantidad,
    COALESCE(SUM(c.monto) FILTER (WHERE c.estado = 'rechazado'), 0)                   AS rechazados_monto,
    COUNT(*)              FILTER (WHERE c.estado = 'rechazado')                       AS rechazados_cantidad
  FROM public.cheques c
  JOIN public.clientes cli ON cli.id = c.cliente_id
  WHERE c.empresa_id = v_empresa_id
  GROUP BY cli.id, cli.nombre_fantasia, cli.razon_social, cli.cuit, cli.score_actual, cli.score_categoria
  HAVING
    COUNT(*) FILTER (WHERE c.estado IN ('en_cartera', 'depositado')) > 0
    OR COUNT(*) FILTER (WHERE c.estado = 'rechazado') > 0
  ORDER BY COALESCE(cli.score_actual, 50) ASC; -- peor score primero, igual que el sort() actual en JS
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_riesgo_cheques_lista() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_riesgo_cheques_lista() TO authenticated, service_role;
