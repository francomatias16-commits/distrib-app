-- ─────────────────────────────────────────────────────────────────────────
-- 257_rpc_pedidos_lista_server_side.sql
-- Auditoría de filtros v280, siguiente punto tras productos.js: la pantalla
-- de Pedidos (admin) traía hasta 200 registros con .limit(200) y hacía TODO
-- el trabajo en el navegador — filtros (estado, vendedor, zona, canal,
-- cliente, rango de fechas, monto mínimo, "sin facturar"/"sin despachar",
-- búsqueda por cliente/id), orden y paginación (PEDIDOS_POR_PAGINA=20 sobre
-- el array `filtrados` en memoria). Quedó documentado como pendiente en el
-- propio CHANGELOG_v211_pedidos_paginacion.md ("si en el futuro se quiere
-- paginar del lado del servidor...").
--
-- Efectos del límite de 200 que esto corrige de paso:
--   - Pedidos más viejos que los 200 últimos eran directamente invisibles
--     para cualquier filtro (ej. buscar un pedido de hace 2 semanas con
--     mucho volumen de pedidos nuevos en el medio no lo traía).
--   - El panel lateral (total del mes, facturado del mes, conteo por
--     estado) se calculaba solo sobre esos 200, subestimando los números
--     en empresas con alto volumen.
--   - El filtro de "Vendedor" estaba roto: comparaba contra `p.usuarios?.id`
--     pero la query nunca hacía join a `usuarios`, solo traía `vendedor_id`
--     crudo — por lo tanto, al elegir un vendedor, JS filtraba TODO (0
--     resultados) en vez de filtrar por ese vendedor. Se corrige acá
--     comparando directo contra `p.vendedor_id`.
--
-- Mismo patrón que fn_productos_lista/fn_productos_contadores (256) y
-- cliente_productos_disponibles (255): función server-side con
-- COUNT(*) OVER() para paginación real vía LIMIT/OFFSET, más una función
-- de contadores separada para el panel lateral (no depende de la página
-- ni de los filtros activos, igual que antes).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_pedidos_lista(
  p_busqueda      text    DEFAULT NULL,
  p_estado        text    DEFAULT NULL,
  p_vendedor_id   uuid    DEFAULT NULL,
  p_zona_id       uuid    DEFAULT NULL,
  p_canal         text    DEFAULT NULL,
  p_cliente_id    uuid    DEFAULT NULL,
  p_fecha_desde   date    DEFAULT NULL,
  p_fecha_hasta   date    DEFAULT NULL,
  p_monto_min     numeric DEFAULT NULL,
  p_sin_facturar  boolean DEFAULT false,
  p_sin_despachar boolean DEFAULT false,
  p_limit         integer DEFAULT 20,
  p_offset        integer DEFAULT 0
)
RETURNS TABLE (
  id                     uuid,
  estado                 text,
  subtotal               numeric,
  descuento              numeric,
  iva_total              numeric,
  total                  numeric,
  remito_nro             integer,
  notas_cliente          text,
  fecha_pedido           timestamptz,
  fecha_entrega          date,
  created_at             timestamptz,
  canal                  text,
  factura_id             uuid,
  fecha_despacho         timestamptz,
  vendedor_id            uuid,
  cliente_id             uuid,
  cliente_razon_social   text,
  cliente_nombre_fantasia text,
  cliente_cuit           text,
  cliente_telefono       text,
  cliente_domicilio      text,
  cliente_localidad      text,
  cliente_condicion_iva  text,
  zona_id                uuid,
  zona_nombre            text,
  total_count            bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid := public.get_empresa_id();
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      p.id, p.estado::text AS estado, p.subtotal, p.descuento, p.iva_total, p.total,
      p.remito_nro, p.notas_cliente, p.fecha_pedido, p.fecha_entrega,
      p.created_at, p.canal, p.factura_id, p.fecha_despacho, p.vendedor_id,
      c.id AS cliente_id, c.razon_social AS cliente_razon_social,
      c.nombre_fantasia AS cliente_nombre_fantasia, c.cuit AS cliente_cuit,
      c.telefono AS cliente_telefono, c.domicilio AS cliente_domicilio,
      c.localidad AS cliente_localidad, c.condicion_iva AS cliente_condicion_iva,
      z.id AS zona_id, z.nombre AS zona_nombre
    FROM public.pedidos p
    LEFT JOIN public.clientes c ON c.id = p.cliente_id
    LEFT JOIN public.zonas z    ON z.id = c.zona_id
    WHERE p.empresa_id = v_empresa_id
      AND (p_estado IS NULL OR p_estado = '' OR p.estado::text = p_estado)
      AND (p_vendedor_id IS NULL OR p.vendedor_id = p_vendedor_id)
      AND (p_zona_id IS NULL OR c.zona_id = p_zona_id)
      AND (p_canal IS NULL OR p_canal = '' OR p.canal = p_canal)
      AND (p_cliente_id IS NULL OR p.cliente_id = p_cliente_id)
      -- Igual que el filtro JS original: un pedido sin fecha_entrega
      -- cargada NO se excluye por el rango de fechas, solo se excluyen los
      -- que sí tienen fecha y caen fuera del rango.
      AND (p_fecha_desde IS NULL OR p.fecha_entrega IS NULL OR p.fecha_entrega >= p_fecha_desde)
      AND (p_fecha_hasta IS NULL OR p.fecha_entrega IS NULL OR p.fecha_entrega <= p_fecha_hasta)
      AND (p_monto_min IS NULL OR p_monto_min <= 0 OR p.total >= p_monto_min)
      AND (NOT p_sin_facturar  OR (p.factura_id IS NULL AND p.estado::text <> 'cancelado'))
      AND (NOT p_sin_despachar OR (p.fecha_despacho IS NULL AND p.estado::text IN ('confirmado','preparando')))
      AND (
        p_busqueda IS NULL OR p_busqueda = '' OR
        COALESCE(c.nombre_fantasia, c.razon_social, '') ILIKE '%' || p_busqueda || '%' OR
        lower(right(p.id::text, 6)) LIKE '%' || lower(p_busqueda) || '%'
      )
  )
  SELECT b.*, COUNT(*) OVER() AS total_count
  FROM base b
  ORDER BY b.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_pedidos_stats_mes()
RETURNS TABLE (
  total_mes          bigint,
  facturado_mes      numeric,
  conteo_confirmado  bigint,
  conteo_preparando  bigint,
  conteo_despachado  bigint,
  conteo_entregado   bigint
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
    COUNT(*) FILTER (
      WHERE date_trunc('month', p.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
          = date_trunc('month', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
        AND p.estado::text <> 'cancelado'
    ) AS total_mes,
    COALESCE(SUM(p.total) FILTER (
      WHERE date_trunc('month', p.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
          = date_trunc('month', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
        AND p.estado::text <> 'cancelado'
    ), 0) AS facturado_mes,
    COUNT(*) FILTER (WHERE p.estado::text = 'confirmado') AS conteo_confirmado,
    COUNT(*) FILTER (WHERE p.estado::text = 'preparando') AS conteo_preparando,
    COUNT(*) FILTER (WHERE p.estado::text = 'despachado') AS conteo_despachado,
    COUNT(*) FILTER (WHERE p.estado::text = 'entregado')  AS conteo_entregado
  FROM public.pedidos p
  WHERE p.empresa_id = v_empresa_id;
END;
$function$;

-- Se llaman desde el navegador (panel admin) con el JWT del usuario logueado,
-- no con service_role, así que necesitan EXECUTE para 'authenticated'. A
-- diferencia de lo encontrado en 256, acá NO se otorga a 'anon' desde el
-- vamos (son datos de pedidos/facturación, no un catálogo público).
REVOKE ALL ON FUNCTION public.fn_pedidos_lista(text,text,uuid,uuid,text,uuid,date,date,numeric,boolean,boolean,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_pedidos_lista(text,text,uuid,uuid,text,uuid,date,date,numeric,boolean,boolean,integer,integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_pedidos_stats_mes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_pedidos_stats_mes() TO authenticated, service_role;
