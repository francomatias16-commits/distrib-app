-- ═══════════════════════════════════════════════════════════════════════════════
-- 420_asistente_busqueda_aproximada_pg_trgm.sql
--
-- Contexto: lib/asistente-tools.js resolvía texto libre del usuario a
-- cliente_id/producto_id con un ILIKE %texto% exacto (buscarClientePorTexto /
-- buscarProductoPorTexto, ver 001_schema.sql para las columnas). Cuando el
-- pedido se dicta por voz y el reconocimiento transcribe mal un nombre propio
-- ("El Cotyllon" -> "Otoclass"), el ILIKE no matchea nada aunque un humano
-- reconocería a qué cliente se refería.
--
-- Esta migración agrega búsqueda por similitud de trigramas (pg_trgm) como
-- reemplazo de ese ILIKE, expuesta vía dos RPCs SECURITY DEFINER que
-- lib/asistente-tools.js llama con la service role key. La decisión de
-- autoelegir el mejor candidato vs. preguntarle al usuario queda del lado de
-- Node (elegirMejorCandidato() en asistente-tools.js), no acá: estas
-- funciones solo devuelven candidatos ordenados por similitud DESC.
--
-- Seguridad: mismo patrón que registrar_cobro_completo (417) — SECURITY
-- DEFINER, search_path fijo, y tenant check explícito porque estas funciones
-- no dependen únicamente de RLS (se llaman con service_role, que la
-- atraviesa). auth.role() = 'service_role' es el camino normal (handler del
-- asistente); el chequeo contra get_empresa_id() queda como defensa en
-- profundidad si alguna vez se llaman con una sesión de usuario normal.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Índices GIN trigram — sin esto, similarity()/`%` sobre razon_social sería
-- un seq scan completo de la tabla en cada búsqueda del asistente.
CREATE INDEX IF NOT EXISTS idx_clientes_razon_social_trgm
  ON public.clientes USING GIN (razon_social gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clientes_nombre_fantasia_trgm
  ON public.clientes USING GIN (nombre_fantasia gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_productos_nombre_trgm
  ON public.productos USING GIN (nombre gin_trgm_ops);

-- ============================================================
-- RPC: buscar_clientes_asistente
-- Similitud contra razon_social y nombre_fantasia (el mayor de los dos);
-- CUIT y teléfono se comparan aparte con ILIKE simple, ya que ahí no tiene
-- sentido "parecido por voz" sino coincidencia de dígitos.
-- ============================================================
CREATE OR REPLACE FUNCTION public.buscar_clientes_asistente(
  p_empresa_id  UUID,
  p_texto       TEXT,
  p_limite      INT DEFAULT 6
)
RETURNS TABLE (
  id            UUID,
  razon_social  TEXT,
  activo        BOOLEAN,
  similitud     REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.razon_social,
    c.activo,
    GREATEST(
      similarity(c.razon_social, p_texto),
      similarity(coalesce(c.nombre_fantasia, ''), p_texto)
    ) AS similitud
  FROM public.clientes c
  WHERE c.empresa_id = p_empresa_id
    AND (
      c.razon_social % p_texto
      OR c.nombre_fantasia % p_texto
      OR c.cuit ILIKE '%' || p_texto || '%'
      OR c.telefono ILIKE '%' || p_texto || '%'
    )
  ORDER BY similitud DESC NULLS LAST
  LIMIT p_limite;
END;
$$;

-- ============================================================
-- RPC: buscar_productos_asistente
-- Mismo criterio contra nombre; codigo se compara con ILIKE simple.
-- Solo trae productos activos (mismo filtro que ya aplicaba
-- buscarProductoPorTexto en Node).
-- ============================================================
CREATE OR REPLACE FUNCTION public.buscar_productos_asistente(
  p_empresa_id  UUID,
  p_texto       TEXT,
  p_limite      INT DEFAULT 6
)
RETURNS TABLE (
  id         UUID,
  nombre     TEXT,
  similitud  REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.nombre,
    similarity(p.nombre, p_texto) AS similitud
  FROM public.productos p
  WHERE p.empresa_id = p_empresa_id
    AND p.activo = true
    AND (
      p.nombre % p_texto
      OR p.codigo ILIKE '%' || p_texto || '%'
    )
  ORDER BY similitud DESC NULLS LAST
  LIMIT p_limite;
END;
$$;

-- Sin acceso directo desde el cliente: el asistente siempre llama con la
-- service role key (ver lib/repos/_db.js), igual que el resto de las RPCs
-- del handler de asistente.
REVOKE ALL ON FUNCTION public.buscar_clientes_asistente FROM PUBLIC;
REVOKE ALL ON FUNCTION public.buscar_productos_asistente FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buscar_clientes_asistente  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.buscar_productos_asistente TO authenticated, service_role;
