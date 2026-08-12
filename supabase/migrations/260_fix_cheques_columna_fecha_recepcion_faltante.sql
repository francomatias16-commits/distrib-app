-- ─────────────────────────────────────────────────────────────────────────
-- 260_fix_cheques_columna_fecha_recepcion_faltante.sql
-- BUG encontrado de paso al mover cheques.js a server-side (259): guardarCheque()
-- manda `fecha_recepcion` y `observaciones` en el payload de POST/PATCH a
-- /rest/v1/cheques, pero la tabla `cheques` nunca tuvo columna
-- `fecha_recepcion`, y la columna real de texto libre es `notas`, no
-- `observaciones`. Confirmado con un INSERT de prueba contra la base real:
--
--   ERROR: 42703: column "fecha_recepcion" of relation "cheques" does not exist
--
-- Efecto: dar de alta o editar CUALQUIER cheque desde el panel admin falla
-- hoy (PostgREST rechaza el body por columna inexistente en el schema
-- cache). No es un problema de performance como el resto de la auditoría —
-- es una función rota. El fix de `observaciones` -> `notas` va en el JS
-- (no requiere SQL, la columna `notas` ya existe); esta migración resuelve
-- la parte de base de datos: falta la columna `fecha_recepcion` que el
-- formulario (input#cheque-recepcion) siempre asumió que existía.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.cheques ADD COLUMN IF NOT EXISTS fecha_recepcion date;

-- Reemplaza fn_cheques_lista (259) para exponer fecha_recepcion también en
-- la lista, así editarCheque() puede precargar el campo en el modal.
-- DROP explícito porque cambia el RETURNS TABLE (agrega una columna) y
-- Postgres no permite CREATE OR REPLACE cuando cambia el tipo de retorno.
DROP FUNCTION IF EXISTS public.fn_cheques_lista(text, text, boolean, integer, integer);

CREATE FUNCTION public.fn_cheques_lista(
  p_busqueda      text    DEFAULT NULL,
  p_estado        text    DEFAULT NULL,
  p_solo_vencidos boolean DEFAULT false,
  p_limit         integer DEFAULT 100,
  p_offset        integer DEFAULT 0
)
 RETURNS TABLE(
   id uuid, banco text, numero text, monto numeric,
   vencimiento date, fecha_vto date, fecha_recepcion date, estado text,
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
         c.vencimiento, c.fecha_vto, c.fecha_recepcion, c.estado,
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

REVOKE EXECUTE ON FUNCTION public.fn_cheques_lista(text, text, boolean, integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_cheques_lista(text, text, boolean, integer, integer) TO authenticated, service_role;
