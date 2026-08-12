-- =============================================================
-- 195_asistente_ayuda.sql
-- Asistente de ayuda interno (chatbot RAG sobre la base de conocimiento
-- de docs/ayuda/*.md, con fallback Gemini -> Groq -> OpenRouter, ver
-- lib/handlers/asistente.js y lib/asistente-providers.js).
--
-- Contenido:
--   1) Extensión pgvector (embeddings de 768 dims, gemini-embedding-001).
--   2) TABLA asistente_articulos — base de conocimiento (global, no
--      tenant-scoped: los artículos de ayuda son los mismos para todas
--      las empresas del SaaS). Se carga vía
--      scripts/generar-embeddings-asistente.js desde docs/ayuda/*.md.
--   3) TABLA asistente_uso — log de consultas por usuario, usado tanto
--      para rate limiting (lib/handlers/asistente.js) como para
--      métricas de uso a futuro.
--   4) RPC buscar_articulos_asistente() — búsqueda semántica por
--      similitud coseno, filtrada por rol del usuario.
--
-- Acceso: igual que el resto del proyecto, todo pasa por los handlers
-- con la service role key (ver lib/repos/_db.js) — no hay acceso
-- directo desde el cliente, por eso se revoca anon/authenticated.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- TABLA: asistente_articulos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.asistente_articulos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  titulo          TEXT NOT NULL,
  contenido       TEXT NOT NULL,
  categoria       TEXT,
  -- Roles que pueden ver este artículo (rol_usuario + 'proveedor', que no
  -- forma parte del enum porque el portal de proveedores se autentica vía
  -- link firmado, no vía auth.users — ver lib/handlers/portal_proveedor.js).
  -- Se guarda como TEXT[] en vez de rol_usuario[] por ese motivo.
  -- NULL = visible para cualquier rol.
  roles           TEXT[],
  embedding       vector(768),
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asistente_articulos_categoria ON public.asistente_articulos(categoria);
CREATE INDEX IF NOT EXISTS idx_asistente_articulos_roles ON public.asistente_articulos USING GIN(roles);

-- ============================================================
-- TABLA: asistente_uso
-- ============================================================
CREATE TABLE IF NOT EXISTS public.asistente_uso (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id              UUID REFERENCES public.usuarios(id) ON DELETE CASCADE,
  empresa_id              UUID REFERENCES public.empresas(id) ON DELETE CASCADE,
  pregunta                TEXT NOT NULL,
  proveedor_usado         TEXT CHECK (proveedor_usado IN ('gemini', 'groq', 'openrouter')),
  articulos_encontrados   INT NOT NULL DEFAULT 0,
  latencia_ms             INT,
  creado_en               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice usado por rateLimit() en lib/handlers/asistente.js:
-- WHERE usuario_id = ? AND creado_en >= ?
CREATE INDEX IF NOT EXISTS idx_asistente_uso_usuario_fecha ON public.asistente_uso(usuario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_asistente_uso_empresa_fecha ON public.asistente_uso(empresa_id, creado_en DESC);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.asistente_articulos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asistente_uso       ENABLE ROW LEVEL SECURITY;

-- asistente_articulos: contenido global de solo lectura para autenticados
-- (defensa en profundidad — el handler igual filtra por rol vía la RPC).
DROP POLICY IF EXISTS asistente_articulos_select_authenticated ON public.asistente_articulos;
CREATE POLICY asistente_articulos_select_authenticated ON public.asistente_articulos
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- asistente_uso: cada empresa ve solo su propio historial (paneles de
-- métricas futuros); la escritura la hace siempre el handler con service role.
DROP POLICY IF EXISTS asistente_uso_empresa ON public.asistente_uso;
CREATE POLICY asistente_uso_empresa ON public.asistente_uso
  FOR SELECT USING (empresa_id IS NOT DISTINCT FROM public.get_empresa_id());

-- Sin grants de escritura a anon/authenticated: el handler y el script de
-- carga de embeddings usan siempre la service role key.
REVOKE ALL ON public.asistente_articulos FROM anon, authenticated;
REVOKE ALL ON public.asistente_uso       FROM anon, authenticated;
GRANT SELECT ON public.asistente_articulos TO authenticated;
GRANT SELECT ON public.asistente_uso       TO authenticated;

-- ============================================================
-- RPC: buscar_articulos_asistente
-- Búsqueda semántica por similitud coseno (1 - distancia), filtrada
-- opcionalmente por rol. p_rol = NULL trae artículos de cualquier rol.
-- ============================================================
CREATE OR REPLACE FUNCTION public.buscar_articulos_asistente(
  query_embedding  vector(768),
  p_rol            TEXT DEFAULT NULL,
  match_count      INT DEFAULT 3,
  match_threshold  FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  slug        TEXT,
  titulo      TEXT,
  contenido   TEXT,
  categoria   TEXT,
  similarity  FLOAT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.slug,
    a.titulo,
    a.contenido,
    a.categoria,
    1 - (a.embedding <=> query_embedding) AS similarity
  FROM public.asistente_articulos a
  WHERE a.embedding IS NOT NULL
    AND (p_rol IS NULL OR a.roles IS NULL OR p_rol = ANY(a.roles))
    AND 1 - (a.embedding <=> query_embedding) >= match_threshold
  ORDER BY a.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1);
$$;

REVOKE ALL ON FUNCTION public.buscar_articulos_asistente(vector, TEXT, INT, FLOAT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buscar_articulos_asistente(vector, TEXT, INT, FLOAT) TO service_role;

COMMENT ON TABLE public.asistente_articulos IS
  'Base de conocimiento del asistente de ayuda (RAG). Cargada desde docs/ayuda/*.md vía scripts/generar-embeddings-asistente.js. Global, no tenant-scoped.';
COMMENT ON TABLE public.asistente_uso IS
  'Log de consultas al asistente de ayuda (/api/asistente). Usado para rate limiting y métricas de uso por empresa.';
COMMENT ON FUNCTION public.buscar_articulos_asistente IS
  'Búsqueda semántica (similitud coseno) sobre asistente_articulos, filtrada por rol. Llamada desde lib/handlers/asistente.js con la service role key.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '195_asistente_ayuda.sql', '195', 'claude-session',
        'Base de datos del asistente de ayuda: pgvector, asistente_articulos, asistente_uso, RPC buscar_articulos_asistente().')
ON CONFLICT (carpeta, archivo) DO NOTHING;
