-- 264_rpc_notas_credito_lista_server_side.sql
-- Módulo "Notas de crédito" (pestaña AFIP dentro de facturacion.html,
-- notas-credito.js) — distinto del módulo "Notas" (cta_cte, migración 263).
--
-- Problema encontrado en cargarNotasCredito():
--   1. NC manuales: ya pegaba a /api/notas-credito, que SÍ pagina server-side
--      (lib/handlers/facturas.js, handleNotasCredito, .range()+count:'exact')
--      — pero el frontend nunca mandaba page/limit ni usaba `total`, así que
--      en la práctica siempre traía la página 1 de 50 y no había forma de
--      ver el resto ni de buscar por texto (no existe parámetro de búsqueda
--      en el handler).
--   2. NC generadas por anulación AFIP (facturas.tipo='NC_C'): consulta
--      DIRECTA sin ningún .limit() — peor que un "tope de seguridad", acá
--      no hay tope en absoluto.
--   3. Ambas listas se mergeaban y ordenaban en el navegador, sin paginación
--      de UI ni búsqueda.
--
-- Fix: una sola RPC que unifica ambas fuentes (UNION ALL) con búsqueda,
-- filtro de estado y paginación real vía LIMIT/OFFSET + COUNT(*) OVER().
-- El endpoint /api/notas-credito (lectura por id, alta, emisión AFIP) no se
-- toca — sigue sirviendo el detalle y las mutaciones.

-- ============================================================
-- Índice de apoyo para el lado "AFIP" de la unión (facturas.tipo='NC_C'
-- no estaba cubierto por ningún índice, solo por empresa_id/estado sueltos)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_facturas_empresa_tipo_nc_fecha
  ON public.facturas (empresa_id, fecha_emision DESC)
  WHERE tipo = 'NC_C';

-- ============================================================
-- fn_notas_credito_lista: unifica notas_credito (manuales) +
-- facturas tipo='NC_C' (anulaciones AFIP), filtra y pagina
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_notas_credito_lista(
  p_busqueda text    DEFAULT NULL,
  p_estado   text    DEFAULT NULL,
  p_limit    integer DEFAULT 50,
  p_offset   integer DEFAULT 0
)
RETURNS TABLE(
  id                       uuid,
  fuente                   text,   -- 'manual' | 'afip'
  tipo                     text,
  numero                   text,
  estado                   text,
  motivo                   text,
  total                    numeric,
  fecha_emision            timestamptz,
  cae                      text,
  pdf_url                  text,
  cliente_id               uuid,
  cliente_razon_social     text,
  cliente_nombre_fantasia  text,
  factura_numero           text,
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
  WITH todas AS (
    SELECT nc.id, 'manual'::text AS fuente, nc.tipo, nc.numero, nc.estado, nc.motivo,
           nc.total, nc.fecha_emision, nc.cae, nc.pdf_url, nc.cliente_id,
           cli.razon_social AS cliente_razon_social, cli.nombre_fantasia AS cliente_nombre_fantasia,
           fo.numero AS factura_numero
    FROM public.notas_credito nc
    LEFT JOIN public.clientes cli ON cli.id = nc.cliente_id
    LEFT JOIN public.facturas fo  ON fo.id = nc.factura_id
    WHERE nc.empresa_id = v_empresa_id

    UNION ALL

    SELECT f.id, 'afip'::text AS fuente, 'C'::text AS tipo, f.numero, f.estado::text,
           'Anulación de factura'::text AS motivo,
           f.total, f.fecha_emision, f.cae, f.pdf_url, f.cliente_id,
           cli.razon_social, cli.nombre_fantasia,
           fo.numero AS factura_numero
    FROM public.facturas f
    LEFT JOIN public.clientes cli ON cli.id = f.cliente_id
    LEFT JOIN public.facturas fo  ON fo.id = f.factura_origen_id
    WHERE f.empresa_id = v_empresa_id
      AND f.tipo = 'NC_C'
  )
  SELECT t.*, COUNT(*) OVER() AS total_count
  FROM todas t
  WHERE (p_estado IS NULL OR p_estado = '' OR t.estado = p_estado)
    AND (
      p_busqueda IS NULL OR p_busqueda = '' OR
      (
        COALESCE(t.numero, '') || ' ' || COALESCE(t.cliente_razon_social, '') || ' ' ||
        COALESCE(t.cliente_nombre_fantasia, '') || ' ' || COALESCE(t.factura_numero, '')
      ) ILIKE '%' || p_busqueda || '%'
    )
  ORDER BY t.fecha_emision DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_notas_credito_lista(text, text, integer, integer) TO authenticated, service_role;
