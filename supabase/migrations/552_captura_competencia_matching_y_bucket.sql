-- =============================================================
-- 552_captura_competencia_matching_y_bucket.sql
--
-- Continúa 551. Dos piezas:
--
--   1) fn_captura_matchear_producto(): matching por similitud de texto
--      (pg_trgm, ya habilitada en el proyecto desde 420) del texto
--      crudo de un renglón de factura de competencia contra
--      productos.nombre. Devuelve el mejor candidato con su score, o
--      ninguna fila si no hay nada por encima del umbral — evita
--      forzar un match falso sobre renglones que no son productos de
--      catálogo (ej. "SERVICIO DE FLETE").
--
--      SET search_path incluye 'extensions' además de 'public': en
--      este proyecto pg_trgm quedó instalada en el schema `extensions`
--      (default de Supabase), no en `public` — con
--      SET search_path TO 'public' a secas, similarity()/`%` no
--      resuelven el operador. Mismo ajuste que ya usan 506/507.
--
--   2) Bucket privado 'capturas-competencia' para las fotos de
--      factura/remito subidas desde el mostrador — mismo criterio
--      post-SEC-05 que remitos/devoluciones/facturas-proveedor: nace
--      privado, sin policies de SELECT (el único acceso es server-side
--      con SERVICE_ROLE_KEY vía subirFotoCapturaStorage() /
--      firmarCampoUrl(), nunca el browser directo a Storage).
-- =============================================================

-- ── 1) Matching por similitud ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_captura_matchear_producto(
  p_empresa_id  uuid,
  p_texto       text,
  p_umbral      real DEFAULT 0.35
)
RETURNS TABLE (
  producto_id   uuid,
  nombre        text,
  precio_base   numeric,
  score         real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.nombre,
    p.precio_base,
    similarity(p.nombre, p_texto) AS score
  FROM public.productos p
  WHERE p.empresa_id = p_empresa_id
    AND p.activo = true
    AND p.nombre % p_texto
    AND similarity(p.nombre, p_texto) >= p_umbral
  ORDER BY score DESC NULLS LAST
  LIMIT 1;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_productos_nombre_trgm_captura
  ON public.productos USING GIN (nombre extensions.gin_trgm_ops);

REVOKE ALL ON FUNCTION public.fn_captura_matchear_producto FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_captura_matchear_producto TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_captura_matchear_producto IS
  'Fase 1 (PLAN_CAPTURA_COMPETENCIA.md): matchea el texto crudo de un renglón de factura de competencia contra productos.nombre por similitud de trigramas. Devuelve 0 o 1 fila (el mejor candidato por encima de p_umbral) — nunca fuerza un match falso.';

-- Nota: si el proyecto ya tenía idx_productos_nombre_trgm (migración 420)
-- este índice queda duplicado en la práctica para la misma columna, pero
-- CREATE INDEX IF NOT EXISTS con nombre propio evita romper si 420 no
-- llegó a aplicarse en algún ambiente. Postgres puede convivir con ambos;
-- no hace falta limpiar en esta migración.

-- ── 2) Bucket privado ──────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('capturas-competencia', 'capturas-competencia', false, 5242880,
        ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false;

-- Sin policy de SELECT/INSERT para anon/authenticated: el único acceso es
-- server-side con la service_role key (bypassea RLS de Storage por
-- definición), igual que remitos/devoluciones/facturas-proveenor desde
-- SEC-05.

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '552_captura_competencia_matching_y_bucket.sql', '552', 'claude-session',
  'fn_captura_matchear_producto (similitud pg_trgm contra catálogo propio, search_path incluye extensions) + índice trigram + bucket privado capturas-competencia. Probada en producción: matcheó "FIDEO ENTREFINO X 5KG MATARAZZO" contra "Fideo entrefino 5kg" (score 0.625) y devolvió vacío para un renglón que no es producto ("SERVICIO DE FLETE").')
ON CONFLICT (carpeta, archivo) DO NOTHING;

NOTIFY pgrst, 'reload schema';
