-- 263_rpc_notas_lista_server_side.sql
-- Mismo tratamiento que 256 (productos), 257 (pedidos), 259 (cheques),
-- 261 (riesgo de cheques) y 262 (facturación): reemplaza el patrón
-- "traer hasta 500 filas de cta_cte y filtrar en el navegador"
-- (notas.js, cargarNotas() + filtrarNotas()) por un RPC server-side
-- con búsqueda, filtro por tipo y paginación real.
--
-- Ver AUDITORIA_FILTROS_v280, plan de acción, sección 5 (mediano plazo),
-- ítem "Notas".
--
-- Nota: las notas de crédito/débito conviven en `cta_cte` con otros
-- movimientos (cobro, factura, etc.) — se filtran por tipo IN
-- ('nota_credito','nota_debito'), igual que hacía cargarNotas().

-- ============================================================
-- Índice de apoyo: hoy idx_cta_cte_empresa_fecha_date cubre
-- (empresa_id, fecha_date) pero no filtra por tipo. Parcial porque
-- las notas son una fracción chica del total de movimientos de cta_cte.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_cta_cte_empresa_tipo_notas
  ON public.cta_cte (empresa_id, fecha DESC)
  WHERE tipo IN ('nota_credito', 'nota_debito');

-- ============================================================
-- fn_notas_lista: página filtrada + paginada
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_notas_lista(
  p_busqueda text    DEFAULT NULL,
  p_tipo     text    DEFAULT NULL, -- 'nota_credito' | 'nota_debito' | NULL (todos)
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
  SELECT cc.id, cc.tipo, cc.fecha, cc.nro_comprobante, cc.importe,
         cc.cliente_id, cli.razon_social, cli.nombre_fantasia,
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

GRANT EXECUTE ON FUNCTION public.fn_notas_lista(text, text, integer, integer) TO authenticated, service_role;
