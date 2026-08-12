-- Hallazgo 1, Etapa 1 (Pedidos) de la auditoría por módulos: el filtro
-- "sin facturar" (p_sin_facturar) y el badge de estado de fn_pedidos_lista
-- solo miraban p.factura_id IS NULL. Pero factura_id se completa apenas se
-- CREA el registro en facturas, aunque quede en estado 'pendiente' o
-- 'error_afip' (nunca se emitió con éxito). Resultado real hoy: 375
-- pedidos con factura fallida que "desaparecen" del filtro sin-facturar y
-- no muestran botón para reintentar. Fix: se agrega el join a facturas y
-- se expone factura_estado/factura_error_detalle en el resultado, y
-- p_sin_facturar ahora también captura facturas pendiente/error_afip.
--
-- Aplicada en producción vía apply_migration (nombre real:
-- fix_pedidos_sinfacturar_incluye_factura_error).
DROP FUNCTION IF EXISTS public.fn_pedidos_lista(text,text,uuid,uuid,text,uuid,date,date,numeric,boolean,boolean,integer,integer);

CREATE FUNCTION public.fn_pedidos_lista(
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
RETURNS TABLE(
  id uuid, estado text, subtotal numeric, descuento numeric, iva_total numeric, total numeric,
  remito_nro integer, notas_cliente text, fecha_pedido timestamptz, fecha_entrega date,
  created_at timestamptz, canal text, factura_id uuid, fecha_despacho timestamptz, vendedor_id uuid,
  cliente_id uuid, cliente_razon_social text, cliente_nombre_fantasia text, cliente_cuit text,
  cliente_telefono text, cliente_domicilio text, cliente_localidad text, cliente_condicion_iva text,
  zona_id uuid, zona_nombre text,
  factura_estado text, factura_error_detalle text,
  total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
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
      z.id AS zona_id, z.nombre AS zona_nombre,
      f.estado::text AS factura_estado, f.notas_error AS factura_error_detalle
    FROM public.pedidos p
    LEFT JOIN public.clientes c ON c.id = p.cliente_id
    LEFT JOIN public.zonas z    ON z.id = c.zona_id
    LEFT JOIN public.facturas f ON f.id = p.factura_id
    WHERE p.empresa_id = v_empresa_id
      AND (p_estado IS NULL OR p_estado = '' OR p.estado::text = p_estado)
      AND (p_vendedor_id IS NULL OR p.vendedor_id = p_vendedor_id)
      AND (p_zona_id IS NULL OR c.zona_id = p_zona_id)
      AND (p_canal IS NULL OR p_canal = '' OR p.canal = p_canal)
      AND (p_cliente_id IS NULL OR p.cliente_id = p_cliente_id)
      AND (p_fecha_desde IS NULL OR p.fecha_entrega IS NULL OR p.fecha_entrega >= p_fecha_desde)
      AND (p_fecha_hasta IS NULL OR p.fecha_entrega IS NULL OR p.fecha_entrega <= p_fecha_hasta)
      AND (p_monto_min IS NULL OR p_monto_min <= 0 OR p.total >= p_monto_min)
      AND (
        NOT p_sin_facturar OR (
          p.estado::text <> 'cancelado'
          AND (p.factura_id IS NULL OR f.estado::text IN ('pendiente','error_afip'))
        )
      )
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

REVOKE ALL ON FUNCTION public.fn_pedidos_lista(text,text,uuid,uuid,text,uuid,date,date,numeric,boolean,boolean,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_pedidos_lista(text,text,uuid,uuid,text,uuid,date,date,numeric,boolean,boolean,integer,integer) TO authenticated, service_role;

-- Default privileges de Supabase otorgan EXECUTE a anon a toda función
-- nueva en public — el REVOKE ALL FROM PUBLIC de arriba no alcanza a anon
-- (rol explícito). fn_pedidos_lista no tiene ningún caller sin sesión
-- (deriva todo de get_empresa_id()), así que se revoca explícitamente,
-- mismo patrón que SEC-012.
REVOKE EXECUTE ON FUNCTION public.fn_pedidos_lista(text,text,uuid,uuid,text,uuid,date,date,numeric,boolean,boolean,integer,integer) FROM anon;
