-- 585_fn_pedidos_lista_order_by_updated_at.sql
-- Regla "ítem modificado sube al tope" (2026-09), parte pedidos.
-- fn_pedidos_lista (migración 257) ordenaba por created_at DESC, así que
-- confirmar/despachar/cancelar un pedido viejo no lo traía a la vista sin
-- buscarlo en toda la lista. Se agrega updated_at al output (necesario
-- porque el ORDER BY solo puede referenciar columnas expuestas por la CTE
-- `base`, que se propagan a la salida vía `b.*`) y se ordena por esa
-- columna. Requiere DROP+CREATE porque cambia el RETURNS TABLE.
--
-- Depende de 584 (trigger trg_pedidos_updated_at manteniendo pedidos.updated_at al día).
--
-- Aplicada en producción vía Supabase MCP el 2026-09-03.

DROP FUNCTION IF EXISTS public.fn_pedidos_lista(text, text, uuid, uuid, text, uuid, date, date, numeric, boolean, boolean, integer, integer);

CREATE FUNCTION public.fn_pedidos_lista(
  p_busqueda text DEFAULT NULL::text,
  p_estado text DEFAULT NULL::text,
  p_vendedor_id uuid DEFAULT NULL::uuid,
  p_zona_id uuid DEFAULT NULL::uuid,
  p_canal text DEFAULT NULL::text,
  p_cliente_id uuid DEFAULT NULL::uuid,
  p_fecha_desde date DEFAULT NULL::date,
  p_fecha_hasta date DEFAULT NULL::date,
  p_monto_min numeric DEFAULT NULL::numeric,
  p_sin_facturar boolean DEFAULT false,
  p_sin_despachar boolean DEFAULT false,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  id uuid, estado text, subtotal numeric, descuento numeric, iva_total numeric, total numeric,
  remito_nro integer, notas_cliente text, fecha_pedido timestamp with time zone, fecha_entrega date,
  created_at timestamp with time zone, updated_at timestamp with time zone, canal text, factura_id uuid,
  fecha_despacho timestamp with time zone, vendedor_id uuid, cliente_id uuid, cliente_razon_social text,
  cliente_nombre_fantasia text, cliente_cuit text, cliente_telefono text, cliente_domicilio text,
  cliente_localidad text, cliente_condicion_iva text, zona_id uuid, zona_nombre text,
  factura_estado text, factura_error_detalle text, forma_pago text, total_count bigint
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
      p.created_at, p.updated_at, p.canal, p.factura_id, p.fecha_despacho, p.vendedor_id,
      c.id AS cliente_id, c.razon_social AS cliente_razon_social,
      c.nombre_fantasia AS cliente_nombre_fantasia, c.cuit AS cliente_cuit,
      c.telefono AS cliente_telefono, c.domicilio AS cliente_domicilio,
      c.localidad AS cliente_localidad, c.condicion_iva AS cliente_condicion_iva,
      z.id AS zona_id, z.nombre AS zona_nombre,
      f.estado::text AS factura_estado, f.notas_error AS factura_error_detalle,
      p.forma_pago
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
  ORDER BY b.updated_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_pedidos_lista(text, text, uuid, uuid, text, uuid, date, date, numeric, boolean, boolean, integer, integer)
  TO anon, authenticated, service_role;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES (
  'supabase/migrations',
  '585_fn_pedidos_lista_order_by_updated_at.sql',
  '585',
  'claude-session',
  'Regla "ítem modificado sube al tope": fn_pedidos_lista ordenaba por created_at DESC. Se agrega updated_at al RETURNS TABLE (requirió DROP+CREATE) y se ordena por esa columna, apoyándose en el trigger trg_pedidos_updated_at agregado en 584.'
);
