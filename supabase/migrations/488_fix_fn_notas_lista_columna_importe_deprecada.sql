-- Fix NOTASCTACTE-AUDIT-01: fn_notas_lista devolvía cc.importe, columna de
-- cta_cte deprecada desde 2026-07-03 (ningún RPC la escribe más — ver
-- comment de la columna). emitir_nota_cta_cte sí inserta correctamente en
-- "monto", pero la pantalla "Notas" (frontend/admin/js/notas.js, que
-- renderiza n.importe) mostraba el importe en blanco/null para toda nota
-- de crédito/débito emitida desde esa fecha.
--
-- Verificado en vivo contra la única nota de crédito real en producción:
-- monto=2400.00, importe=NULL antes del fix. Con el fix, fn_notas_lista
-- devuelve importe=2400.00 correctamente.
--
-- Fix: leer cc.monto en vez de cc.importe. Se mantiene el nombre de la
-- columna de salida "importe" (mismo RETURNS TABLE) para no romper el
-- contrato con notas.js, que ya lee n.importe.
--
-- NOTA: esta migración ya fue aplicada directamente en Supabase
-- (jgiquzjwoedmzwqgzubr) durante la auditoría y verificada en vivo. Se
-- versiona acá para que quede en el repo / historial de migraciones.

CREATE OR REPLACE FUNCTION public.fn_notas_lista(
  p_busqueda text    DEFAULT NULL,
  p_tipo     text    DEFAULT NULL,
  p_limit    integer DEFAULT 200,
  p_offset   integer DEFAULT 0
)
RETURNS TABLE(
  id                       uuid,
  tipo                     text,
  fecha                    timestamptz,
  nro_comprobante          text,
  importe                  numeric,
  cliente_id               uuid,
  cliente_razon_social     text,
  cliente_nombre_fantasia  text,
  anulado                  boolean,
  descripcion              text,
  total_count              bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  SELECT cc.id, cc.tipo, cc.fecha, cc.nro_comprobante, cc.monto AS importe,
         cc.cliente_id, cli.razon_social, cli.nombre_fantasia,
         cc.anulado, cc.descripcion,
         COUNT(*) OVER() AS total_count
  FROM public.cta_cte cc
  LEFT JOIN public.clientes cli ON cli.id = cc.cliente_id
  WHERE cc.empresa_id = v_empresa_id
    AND cc.tipo IN ('nota_credito', 'nota_debito')
    AND (p_tipo IS NULL OR p_tipo = '' OR cc.tipo = p_tipo)
    AND (
      p_busqueda IS NULL OR p_busqueda = '' OR
      (
        COALESCE(cli.razon_social, '') || ' ' || COALESCE(cli.nombre_fantasia, '') || ' ' || COALESCE(cc.nro_comprobante, '')
      ) ILIKE '%' || p_busqueda || '%'
    )
  ORDER BY cc.fecha DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;
