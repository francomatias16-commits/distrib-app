-- ─────────────────────────────────────────────────────────────────────────
-- 259_rpc_cheques_lista_server_side.sql
-- Auditoría de filtros v280, ítem 4 del plan de acción: mismo tratamiento
-- que productos (256) y pedidos (257) para la pantalla de Cheques
-- (frontend/admin/js/cheques.js).
--
-- Problema: `cargarCheques()` traía hasta 500 cheques (`.limit(500) //
-- tope de seguridad`) y todo el filtrado de texto (cliente/banco/número),
-- el chip de estado y el checkbox "solo vencidos" se resolvían después con
-- `Array.filter()` en el navegador. Volumen actual bajo (189 filas en el
-- tenant demo), pero el mismo patrón de "tope fijo que en la práctica
-- esconde resultados fuera de las primeras N filas" que ya se corrigió en
-- productos/pedidos.
--
-- Se agrega:
--   - fn_cheques_lista(...)      -> página ya filtrada/ordenada por texto
--                                    (número, banco, cliente), estado y
--                                    "solo vencidos", con total_count vía
--                                    window function para LIMIT/OFFSET real.
--   - fn_cheques_contadores()    -> los 4 totales de las tarjetas KPI
--                                    (cartera, próximos a vencer, cobrado
--                                    del mes, rechazados) calculados sobre
--                                    TODO el universo de cheques de la
--                                    empresa, no sobre la página actual ni
--                                    sobre el recorte de 500 filas — mismo
--                                    motivo que fn_productos_contadores.
--
-- Nota sobre columnas de vencimiento: se usa `vencimiento` para los KPIs
-- (igual que actualizarKPIs() en JS hoy) y `COALESCE(fecha_vto,
-- vencimiento)` para "solo vencidos" (igual que esVencido() en JS, que ya
-- documenta por qué fecha_vto es la columna confiable ahí). No se cambia
-- ese criterio, solo se mueve a SQL tal cual estaba en JS.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cheques_contadores()
 RETURNS TABLE(
   monto_cartera numeric, cant_cartera bigint,
   monto_proximos numeric, cant_proximos bigint,
   monto_cobrado_mes numeric, cant_cobrado_mes bigint,
   monto_rechazados numeric, cant_rechazados bigint
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
    COUNT(*)              FILTER (WHERE c.estado = 'rechazado')
  FROM public.cheques c
  WHERE c.empresa_id = v_empresa_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cheques_lista(
  p_busqueda      text    DEFAULT NULL,
  p_estado        text    DEFAULT NULL,
  p_solo_vencidos boolean DEFAULT false,
  p_limit         integer DEFAULT 100,
  p_offset        integer DEFAULT 0
)
 RETURNS TABLE(
   id uuid, banco text, numero text, monto numeric,
   vencimiento date, fecha_vto date, estado text,
   cobro_id uuid, notas text, cliente_id uuid,
   cliente_razon_social text, cliente_nombre_fantasia text,
   total_count bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
  v_hoy        date := CURRENT_DATE;
BEGIN
  RETURN QUERY
  SELECT c.id, c.banco, c.numero, c.monto,
         c.vencimiento, c.fecha_vto, c.estado,
         c.cobro_id, c.notas, c.cliente_id,
         cli.razon_social, cli.nombre_fantasia,
         COUNT(*) OVER() AS total_count
  FROM public.cheques c
  LEFT JOIN public.clientes cli ON cli.id = c.cliente_id
  WHERE c.empresa_id = v_empresa_id
    AND (p_estado IS NULL OR p_estado = '' OR c.estado = p_estado)
    AND (
      p_busqueda IS NULL OR p_busqueda = '' OR
      (
        COALESCE(c.numero, '') || ' ' || COALESCE(c.banco, '') || ' ' ||
        COALESCE(cli.razon_social, '') || ' ' || COALESCE(cli.nombre_fantasia, '')
      ) ILIKE '%' || p_busqueda || '%'
    )
    AND (
      NOT p_solo_vencidos OR
      (c.estado = 'en_cartera' AND COALESCE(c.fecha_vto, c.vencimiento) < v_hoy)
    )
  ORDER BY c.vencimiento ASC NULLS LAST, c.id
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

-- Mismo criterio de grants que 258 (fn_productos_*): RPCs de panel admin,
-- llamadas siempre con el JWT del usuario logueado a través del backend;
-- sin caso de uso legítimo desde anon.
REVOKE EXECUTE ON FUNCTION public.fn_cheques_contadores() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fn_cheques_lista(text, text, boolean, integer, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_cheques_contadores() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_cheques_lista(text, text, boolean, integer, integer) TO authenticated, service_role;
