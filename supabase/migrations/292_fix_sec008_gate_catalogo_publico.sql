-- Auditoría 2026, SEC-008 (severidad media, decisión de negocio confirmada
-- 2026-07-11 sesión 9: "No, hay que restringirlo"). Aplicada en producción
-- como "fix_sec008_gate_catalogo_publico".
--
-- Hallazgo: cliente_productos_disponibles (SECURITY DEFINER) devuelve
-- catálogo completo (precios, stock) de CUALQUIER empresa recibiendo
-- p_empresa_id sin validar sesión. Confirmado GRANT EXECUTE directo a
-- anon Y authenticated vía PostgREST (bypasea el backend por completo).
-- Las tablas productos/categorias no son el vector (RLS ya filtra por
-- get_empresa_id()) — el vector es este RPC SECURITY DEFINER.
--
-- Fix (2 capas, igual que se decidió en la sesión anterior):
--   1) SQL (esta migración): la función ahora exige que la empresa tenga
--      el flag empresas.config->>'catalogo_publico_habilitado' = true
--      para cualquier caller que NO sea el dueño de esos datos (i.e. no
--      service_role Y no un usuario autenticado de esa misma empresa).
--      Si no está habilitado, devuelve 0 filas (no error, para no filtrar
--      si la empresa existe o no).
--   2) Node (lib/handlers/stock.js, resolverEmpresaCliente): mismo chequeo
--      antes de aceptar el fallback ?empresa_id= — se aplica en el mismo
--      commit/deploy, ver CHANGELOG correspondiente.
--
-- Default: catalogo_publico_habilitado = false (secure by default). Esto
-- es un breaking change intencional para links de catálogo público
-- existentes — el dueño de cada empresa deberá habilitarlo explícitamente
-- (config->'catalogo_publico_habilitado' = true) para las empresas que
-- realmente usan el catálogo sin login como herramienta comercial.

CREATE OR REPLACE FUNCTION public.cliente_productos_disponibles(p_empresa_id uuid, p_categoria uuid DEFAULT NULL::uuid, p_busqueda text DEFAULT NULL::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, codigo text, nombre text, descripcion text, unidad text, precio_base numeric, foto_url text, categoria_id uuid, categoria_nombre text, stock_disponible numeric, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- SEC-008 fix: si el caller no es el backend (service_role) ni un
  -- usuario autenticado que pertenece a esta misma empresa, sólo se
  -- permite continuar si la empresa habilitó explícitamente el catálogo
  -- público. Caso contrario, se devuelve un resultado vacío (sin error,
  -- para no revelar si p_empresa_id existe).
  IF auth.role() <> 'service_role'
     AND public.get_empresa_id() IS DISTINCT FROM p_empresa_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.empresas e
       WHERE e.id = p_empresa_id
         AND COALESCE((e.config->>'catalogo_publico_habilitado')::boolean, false) = true
    ) THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH stock_por_producto AS (
    SELECT s.producto_id,
           SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) AS disponible
    FROM public.stock s
    JOIN public.depositos d ON d.id = s.deposito_id
    WHERE d.empresa_id = p_empresa_id
    GROUP BY s.producto_id
    HAVING SUM(GREATEST(0, COALESCE(s.cantidad, 0) - COALESCE(s.cantidad_reservada, 0))) > 0
  )
  SELECT
    p.id, p.codigo, p.nombre, p.descripcion, p.unidad, p.precio_base,
    p.foto_url, p.categoria_id, c.nombre AS categoria_nombre,
    sp.disponible AS stock_disponible,
    COUNT(*) OVER() AS total_count
  FROM public.productos p
  JOIN stock_por_producto sp ON sp.producto_id = p.id
  LEFT JOIN public.categorias c ON c.id = p.categoria_id
  WHERE p.empresa_id = p_empresa_id
    AND p.activo = true
    AND (p_categoria IS NULL OR p.categoria_id = p_categoria)
    AND (
      p_busqueda IS NULL OR p_busqueda = '' OR (
        p.nombre      ILIKE '%' || p_busqueda || '%' OR
        p.codigo      ILIKE '%' || p_busqueda || '%' OR
        p.descripcion ILIKE '%' || p_busqueda || '%'
      )
    )
  ORDER BY p.nombre
  LIMIT p_limit OFFSET p_offset;
END;
$function$;
