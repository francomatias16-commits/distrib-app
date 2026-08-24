-- ─────────────────────────────────────────────────────────────────────────
-- 522_fn_cheques_lista_filtro_proximos.sql
-- Aplica la migración que estaba escrita en el repo local
-- (513_fn_cheques_lista_filtro_proximos.sql, plain-numbered) pero nunca se
-- había corrido contra la base. El frontend v908 (cheques.js) ya estaba
-- llamando a fn_cheques_lista con el parámetro p_solo_proximos, pero la
-- función en producción seguía con la firma vieja de 5 parámetros ->
-- PostgREST no encontraba ninguna sobrecarga que matchee -> "No se
-- pudieron cargar los cheques" en la pantalla de Cheques (bug reportado
-- 20/8, capturado en la pantalla de Cheques con "Cargando..." infinito).
--
-- Agrega p_solo_proximos a fn_cheques_lista(...), con el mismo criterio
-- que ya usa fn_cheques_contadores() para cant_proximos/monto_proximos:
-- estado = 'en_cartera' AND vencimiento BETWEEN hoy y hoy+3.
--
-- DROP explícito de la firma vieja antes de crear la nueva: agregar un
-- parámetro (aunque tenga DEFAULT) cambia la lista de tipos de entrada,
-- así que CREATE OR REPLACE no alcanza -- crearía un overload nuevo al
-- lado del viejo en vez de reemplazarlo.
-- ─────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_cheques_lista(text, text, boolean, integer, integer);

CREATE FUNCTION public.fn_cheques_lista(
  p_busqueda      text    DEFAULT NULL,
  p_estado        text    DEFAULT NULL,
  p_solo_vencidos boolean DEFAULT false,
  p_limit         integer DEFAULT 100,
  p_offset        integer DEFAULT 0,
  p_solo_proximos boolean DEFAULT false
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
  v_en3        date := CURRENT_DATE + INTERVAL '3 days';
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
    AND (
      NOT p_solo_proximos OR
      (c.estado = 'en_cartera' AND c.vencimiento BETWEEN v_hoy AND v_en3)
    )
  ORDER BY c.vencimiento ASC NULLS LAST, c.id
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_cheques_lista(text, text, boolean, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cheques_lista(text, text, boolean, integer, integer, boolean) TO authenticated, service_role;
