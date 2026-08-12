-- 262_rpc_facturas_lista_server_side.sql
-- Reemplaza el patrón "traer hasta 300 facturas y filtrar en el navegador"
-- (facturacion.js, cargarFacturas()) por dos RPC server-side:
--
--   fn_facturas_contadores()  -> los 4 valores de las tarjetas KPI,
--                                calculados sobre TODO el universo de
--                                facturas de la empresa (no solo las
--                                últimas 300 cargadas).
--   fn_facturas_lista(...)    -> página filtrada (búsqueda, estado, rango
--                                de fechas) con paginación real via
--                                LIMIT/OFFSET y total_count con
--                                COUNT(*) OVER().
--
-- Mismo criterio que las migraciones 256 (productos), 257 (pedidos),
-- 259 (cheques) y 261 (riesgo de cheques). Ver AUDITORIA_FILTROS_v280,
-- punto 4: "Cheques / Riesgo de cheques / Facturación: mismo tratamiento".
--
-- Excluye tipo = 'NC_C' en ambas funciones, igual que la query original
-- de facturacion.js (.not('tipo','eq','NC_C')).

-- ============================================================
-- fn_facturas_contadores: KPIs sobre el universo completo
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_facturas_contadores()
RETURNS TABLE(
  cant_pendientes    bigint,
  cant_error_afip    bigint,
  cant_emitidas_mes  bigint,
  monto_emitidas_mes numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
  v_inicio_mes date := date_trunc('month', CURRENT_DATE)::date;
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE f.estado::text = 'pendiente'),
    COUNT(*) FILTER (WHERE f.estado::text = 'error_afip'),
    COUNT(*) FILTER (WHERE f.estado::text = 'emitida' AND f.fecha_emision >= v_inicio_mes),
    COALESCE(SUM(f.total) FILTER (WHERE f.estado::text = 'emitida' AND f.fecha_emision >= v_inicio_mes), 0)
  FROM public.facturas f
  WHERE f.empresa_id = v_empresa_id
    AND f.tipo IS DISTINCT FROM 'NC_C';
END;
$function$;

-- ============================================================
-- fn_facturas_lista: página filtrada + paginada
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_facturas_lista(
  p_busqueda    text    DEFAULT NULL,
  p_estado      text    DEFAULT NULL,
  p_fecha_desde date    DEFAULT NULL,
  p_fecha_hasta date    DEFAULT NULL,
  p_limit       integer DEFAULT 200,
  p_offset      integer DEFAULT 0
)
RETURNS TABLE(
  id                  uuid,
  tipo                text,
  numero              text,
  cae                 text,
  cae_vto             date,
  neto                numeric,
  iva                 numeric,
  total               numeric,
  estado              text,
  pdf_url             text,
  fecha_emision       timestamptz,
  vencimiento         date,
  total_cobrado       numeric,
  pedido_id           uuid,
  notas_error         text,
  cliente_id          uuid,
  cliente_razon_social text,
  cliente_telefono    text,
  cliente_email       text,
  total_count         bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  SELECT f.id, f.tipo, f.numero, f.cae, f.cae_vto,
         f.neto, f.iva, f.total, f.estado::text,
         f.pdf_url, f.fecha_emision, f.vencimiento,
         f.total_cobrado, f.pedido_id, f.notas_error,
         f.cliente_id, cli.razon_social, cli.telefono, cli.email,
         COUNT(*) OVER() AS total_count
  FROM public.facturas f
  LEFT JOIN public.clientes cli ON cli.id = f.cliente_id
  WHERE f.empresa_id = v_empresa_id
    AND f.tipo IS DISTINCT FROM 'NC_C'
    AND (p_estado IS NULL OR p_estado = '' OR f.estado::text = p_estado)
    AND (p_fecha_desde IS NULL OR f.fecha_emision >= p_fecha_desde)
    AND (p_fecha_hasta IS NULL OR f.fecha_emision < (p_fecha_hasta + 1))
    AND (
      p_busqueda IS NULL OR p_busqueda = '' OR
      (
        COALESCE(cli.razon_social, '') || ' ' || COALESCE(f.numero, '') || ' ' || COALESCE(f.pedido_id::text, '')
      ) ILIKE '%' || p_busqueda || '%'
    )
  ORDER BY f.fecha_emision DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

-- ============================================================
-- Grants (mismo criterio que 258_fix_grants_fn_productos_lista_contadores)
-- ============================================================
GRANT EXECUTE ON FUNCTION public.fn_facturas_contadores() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_facturas_lista(text, text, date, date, integer, integer) TO authenticated, service_role;
