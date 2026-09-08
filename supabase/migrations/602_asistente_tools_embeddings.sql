-- =============================================================
-- 602_asistente_tools_embeddings.sql
--
-- Frente 2 de PLAN_OPTIMIZACION_ASISTENTE_2026.md — selección de tools
-- por similitud semántica. Mismo patrón que 195_asistente_ayuda.sql
-- (RAG de artículos de ayuda), aplicado ahora al catálogo de tools del
-- asistente (lib/asistente-tools.js, ver TOOLS) para que
-- seleccionarToolsRelevantes() (lib/asistente-tools/index.js) deje de
-- depender únicamente de que la pregunta comparta raíz de palabra con
-- el nombre/description de la tool (ej. "morosos" no encuentra
-- listar_clientes_por_deuda si "moroso" no está en su description).
--
-- Contenido:
--   1) TABLA asistente_tools_embeddings — una fila por tool (tool_nombre
--      como PK, no un id nuevo: no hace falta relacionar por FK con
--      nada, y simplifica el upsert de
--      scripts/generar-embeddings-tools.js). Se carga a mano corriendo
--      ese script — no en cada deploy ni con un cron.
--   2) RPC buscar_tools_asistente_rpc() — búsqueda semántica por
--      similitud coseno, SIN filtrar por rol acá (a diferencia de
--      buscar_articulos_asistente): el filtro por rol ya lo hace
--      seleccionarToolsRelevantes() en JS contra toolsDelRol, que es
--      quien de verdad conoce los roles de cada tool
--      (lib/asistente-tools/*.js) — duplicar ese filtro acá adentro
--      solo agregaría una segunda fuente de verdad para mantener
--      sincronizada.
--   3) Columna nueva metodo_seleccion_tools en asistente_uso (ya tiene
--      cayo_en_nucleo_fallback/cantidad_tools_con_match/
--      tool_finalmente_usada de la migración 601) — cuál de los 3
--      caminos de selección se usó realmente en el request:
--      'semantica' | 'keywords' | 'nucleo_fallback'.
--
-- Acceso: mismo criterio que asistente_articulos — todo pasa por el
-- handler con la service role key, no hay acceso directo desde el
-- cliente.
-- =============================================================

-- ============================================================
-- TABLA: asistente_tools_embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS public.asistente_tools_embeddings (
  tool_nombre     TEXT PRIMARY KEY,
  embedding       vector(768),
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.asistente_tools_embeddings ENABLE ROW LEVEL SECURITY;

-- Sin política de SELECT para authenticated/anon: a diferencia de
-- asistente_articulos (contenido que eventualmente se le muestra al
-- usuario), esto es puro dato interno de infraestructura del asistente
-- — solo lo lee la RPC (SECURITY DEFINER) y lo escribe el script con
-- service role.
REVOKE ALL ON public.asistente_tools_embeddings FROM anon, authenticated;

-- ============================================================
-- RPC: buscar_tools_asistente_rpc
-- Búsqueda semántica por similitud coseno (1 - distancia), sin filtro
-- de rol (ver nota arriba). match_threshold más laxo (0.55 en el
-- handler) que el de artículos (0.5 allá, pero threshold de default acá
-- también 0.5 por consistencia con buscar_articulos_asistente — el
-- handler pasa su propio 0.55 explícito) porque acá el peor caso de un
-- falso positivo es sugerir una tool de más entre el top-N, nunca
-- esconderle una tool al modelo que el keyword sí hubiera encontrado
-- (seleccionarToolsRelevantes cae a keyword si la sugerencia semántica
-- no trae nada usable para el rol).
--
-- search_path incluye 'extensions' porque vector vive en ese schema
-- desde la migración fase5_1_mover_pg_trgm_vector_a_extensions — sin
-- esto, la función falla en producción al no encontrar el tipo/operador
-- vector.
-- ============================================================
CREATE OR REPLACE FUNCTION public.buscar_tools_asistente_rpc(
  query_embedding  vector(768),
  match_count      INT DEFAULT 8,
  match_threshold  FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  tool_nombre  TEXT,
  similarity   FLOAT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    t.tool_nombre,
    1 - (t.embedding <=> query_embedding) AS similarity
  FROM public.asistente_tools_embeddings t
  WHERE t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) >= match_threshold
  ORDER BY t.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1);
$$;

REVOKE ALL ON FUNCTION public.buscar_tools_asistente_rpc(vector, INT, FLOAT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buscar_tools_asistente_rpc(vector, INT, FLOAT) TO service_role;

COMMENT ON TABLE public.asistente_tools_embeddings IS
  'Embeddings (gemini-embedding-001, 768 dims) de name+description de cada tool de lib/asistente-tools.js. Cargada a mano vía scripts/generar-embeddings-tools.js cada vez que se agrega/edita/borra una tool. Usada por buscar_tools_asistente_rpc() para la selección semántica del Frente 2 de PLAN_OPTIMIZACION_ASISTENTE_2026.md.';
COMMENT ON FUNCTION public.buscar_tools_asistente_rpc IS
  'Búsqueda semántica (similitud coseno) sobre asistente_tools_embeddings, SIN filtrar por rol (eso lo hace seleccionarToolsRelevantes() en JS). Llamada desde lib/handlers/asistente.js con la service role key.';

-- ============================================================
-- asistente_uso: columna nueva para saber qué camino de selección se
-- usó en cada request (semántica / keywords / núcleo de fallback).
-- ============================================================
ALTER TABLE public.asistente_uso
  ADD COLUMN IF NOT EXISTS metodo_seleccion_tools TEXT
    CHECK (metodo_seleccion_tools IN ('semantica', 'keywords', 'nucleo_fallback'));

COMMENT ON COLUMN public.asistente_uso.metodo_seleccion_tools IS
  'Cuál de los 3 caminos usó seleccionarToolsRelevantes() en este request: semantica (Frente 2, hubo sugerencia utilizable de buscar_tools_asistente_rpc), keywords (matcheo por palabra clave de siempre) o nucleo_fallback (ninguno de los dos matcheó, se usó TOOLS_NUCLEO_FALLBACK). NULL en filas anteriores a esta migración o cuando no hubo pregunta con tools armadas.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '602_asistente_tools_embeddings.sql', '602', 'claude-session',
        'Frente 2 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: tabla asistente_tools_embeddings + RPC buscar_tools_asistente_rpc() (selección de tools por similitud semántica, sin filtro de rol en SQL) y columna metodo_seleccion_tools en asistente_uso (semantica|keywords|nucleo_fallback).')
ON CONFLICT (carpeta, archivo) DO NOTHING;
