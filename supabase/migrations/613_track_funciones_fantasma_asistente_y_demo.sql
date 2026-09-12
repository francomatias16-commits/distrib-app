-- =============================================================
-- 613_track_funciones_fantasma_asistente_y_demo.sql
--
-- Trackea las 5 funciones que `npm run audit:funciones-fantasma` reportó
-- como "fantasma" (ver plan-auditoria-fluxo.md / Etapa 0): viven en
-- pg_proc (schema public) pero no tenían ningún CREATE FUNCTION en
-- supabase/migrations/, así que un `supabase db reset` / recrear el
-- proyecto desde cero NO las traería de vuelta. Mismo caso que
-- forzar_cierre_turno_caja / las 34 de la migración 492 / las 7 de la
-- migración 569 — se crearon en algún momento a mano desde el SQL editor
-- de Supabase y nunca quedaron versionadas.
--
-- Los cuerpos de acá abajo son la definición REAL sacada de producción
-- con pg_get_functiondef(oid) (vía Supabase MCP, proyecto
-- jgiquzjwoedmzwqgzubr), no una reconstrucción — copia exacta de lo que
-- ya está corriendo. Este archivo es CREATE OR REPLACE puro: no cambia
-- comportamiento ni grants (CREATE OR REPLACE preserva los privilegios
-- ya otorgados), solo lo deja versionado en el repo.
--
-- Las 3 primeras son las que usa el asistente para responder preguntas
-- de facturación y valorización/distribución de stock — si se perdían en
-- una reconstrucción, el asistente no rompía con un error visible, solo
-- fallaba en dar esas respuestas o las daba mal (riesgo silencioso, el
-- mismo tipo que motivó el resto de esta auditoría). La 4ta
-- (fn_reportes_stock_distribucion_asistente) es la misma familia. La 5ta
-- (fn_rodar_stock_demo) es de la ventana rodante de datos demo — no toca
-- dinero real, se trackea igual por completitud del barrido.
--
-- Ninguna de las 5 es función de trigger (todas se llaman directo como
-- RPC), así que no hace falta CREATE TRIGGER adicional.
-- =============================================================

-- ════════════════════════════════════════════════════════════════════
-- 1. fn_facturas_contadores_asistente — contadores de facturas (pendientes,
--    error AFIP, emitidas del mes) para que el asistente responda
--    preguntas de facturación sin exponerle la tabla completa.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_facturas_contadores_asistente(p_empresa_id uuid)
 RETURNS TABLE(cant_pendientes bigint, cant_error_afip bigint, cant_emitidas_mes bigint, monto_emitidas_mes numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inicio_mes date := date_trunc('month', CURRENT_DATE)::date;
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE f.estado::text = 'pendiente'),
    COUNT(*) FILTER (WHERE f.estado::text = 'error_afip'),
    COUNT(*) FILTER (WHERE f.estado::text = 'emitida' AND f.fecha_emision >= v_inicio_mes),
    COALESCE(SUM(f.total) FILTER (WHERE f.estado::text = 'emitida' AND f.fecha_emision >= v_inicio_mes), 0)
  FROM public.facturas f
  WHERE f.empresa_id = p_empresa_id
    AND f.tipo IS DISTINCT FROM 'NC_C';
END;
$function$;

-- ════════════════════════════════════════════════════════════════════
-- 2. fn_facturas_lista_asistente — listado de facturas con datos del
--    cliente, para que el asistente pueda responder "¿qué facturas
--    tiene pendientes tal cliente?" sin acceso directo a las tablas.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_facturas_lista_asistente(p_empresa_id uuid, p_busqueda text DEFAULT NULL::text, p_estado text DEFAULT NULL::text, p_fecha_desde date DEFAULT NULL::date, p_fecha_hasta date DEFAULT NULL::date, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, tipo text, numero text, cae text, cae_vto date, neto numeric, iva numeric, total numeric, estado text, pdf_url text, fecha_emision timestamp with time zone, vencimiento date, total_cobrado numeric, pedido_id uuid, notas_error text, cliente_id uuid, cliente_razon_social text, cliente_telefono text, cliente_email text, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  WHERE f.empresa_id = p_empresa_id
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

-- ════════════════════════════════════════════════════════════════════
-- 3. fn_reportes_stock_valorizacion_asistente — valorización de stock
--    (unidades y costo total) agrupada por depósito, versión del
--    asistente de fn_reportes_stock_valorizacion.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_reportes_stock_valorizacion_asistente(p_empresa_id uuid)
 RETURNS TABLE(deposito_id uuid, deposito_nombre text, cantidad_productos bigint, unidades numeric, costo_total numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    d.id                                    AS deposito_id,
    COALESCE(d.nombre, 'Sin nombre')::text  AS deposito_nombre,
    COUNT(*)::bigint                        AS cantidad_productos,
    COALESCE(SUM(s.cantidad), 0)::numeric   AS unidades,
    COALESCE(SUM(s.cantidad * s.costo_promedio), 0)::numeric AS costo_total
  FROM public.stock s
  JOIN public.depositos d ON d.id = s.deposito_id
  WHERE d.empresa_id = p_empresa_id
  GROUP BY d.id, d.nombre
  ORDER BY costo_total DESC;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════
-- 4. fn_reportes_stock_distribucion_asistente — valor de stock agrupado
--    por categoría, versión del asistente de
--    fn_reportes_stock_distribucion.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_reportes_stock_distribucion_asistente(p_empresa_id uuid, p_deposito_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(categoria_nombre text, valor_total numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT COALESCE(c.nombre, 'Sin categoría') AS categoria_nombre,
         SUM(s.cantidad * s.costo_promedio) AS valor_total
  FROM public.stock s
  JOIN public.depositos d ON d.id = s.deposito_id
  JOIN public.productos p ON p.id = s.producto_id
  LEFT JOIN public.categorias c ON c.id = p.categoria_id
  WHERE d.empresa_id = p_empresa_id
    AND (p_deposito_id IS NULL OR s.deposito_id = p_deposito_id)
  GROUP BY COALESCE(c.nombre, 'Sin categoría')
  ORDER BY valor_total DESC;
END;
$function$;

-- ════════════════════════════════════════════════════════════════════
-- 5. fn_rodar_stock_demo — ventana rodante de datos demo: toca
--    updated_at de stock de la empresa demo para que siempre se vea
--    "reciente". Sin efecto sobre datos reales (aborta si la empresa no
--    tiene es_demo=true).
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_rodar_stock_demo(p_empresa_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
BEGIN
  v_empresa_id := COALESCE(p_empresa_id, (SELECT id FROM empresas WHERE es_demo = true LIMIT 1));
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay ninguna empresa con es_demo=true para rodar stock';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM empresas WHERE id = v_empresa_id AND es_demo = true) THEN
    RAISE EXCEPTION 'La empresa % no tiene es_demo=true — abortado por seguridad', v_empresa_id;
  END IF;

  UPDATE stock s
  SET updated_at = now()
  FROM depositos d
  WHERE d.id = s.deposito_id
    AND d.empresa_id = v_empresa_id;
END;
$function$;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '613_track_funciones_fantasma_asistente_y_demo.sql', '613', 'claude-session',
        'Versiona las 5 funciones fantasma de audit:funciones-fantasma: fn_facturas_contadores_asistente, fn_facturas_lista_asistente, fn_reportes_stock_valorizacion_asistente, fn_reportes_stock_distribucion_asistente (usadas por el asistente para facturación/stock) y fn_rodar_stock_demo (ventana rodante demo). CREATE OR REPLACE puro con la definición real capturada vía pg_get_functiondef desde producción — no cambia comportamiento ni grants.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
