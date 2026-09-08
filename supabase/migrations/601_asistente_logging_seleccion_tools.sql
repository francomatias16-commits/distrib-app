-- =============================================================
-- 601_asistente_logging_seleccion_tools.sql
--
-- Frente 3 de PLAN_OPTIMIZACION_ASISTENTE_2026.md — logging de fallas de
-- selección de tools. Hoy no hay forma de saber, sin leer logs de
-- producción a mano, cuándo seleccionarToolsRelevantes() (Groq/OpenRouter,
-- ver lib/asistente-tools/index.js) no encontró ningún match por keyword
-- y cayó al set curado TOOLS_NUCLEO_FALLBACK, ni si esa pregunta terminó
-- de todas formas con una tool ejecutada (típicamente porque el turno
-- resolvió con Gemini, que sí recibe el catálogo completo del rol sin
-- este filtro).
--
-- Se agregan 3 columnas a la tabla existente asistente_uso (195_asistente_
-- ayuda.sql) en vez de crear una tabla nueva: es un log por request 1:1
-- con esa tabla, no una entidad propia.
-- =============================================================

ALTER TABLE public.asistente_uso
  ADD COLUMN IF NOT EXISTS cayo_en_nucleo_fallback  BOOLEAN,
  ADD COLUMN IF NOT EXISTS cantidad_tools_con_match INT,
  ADD COLUMN IF NOT EXISTS tool_finalmente_usada    TEXT;

COMMENT ON COLUMN public.asistente_uso.cayo_en_nucleo_fallback IS
  'true si seleccionarToolsRelevantes() no encontró ningún match por keyword para esta pregunta y usó el set curado TOOLS_NUCLEO_FALLBACK en su lugar. NULL en filas anteriores a esta migración. No aplica cuando no hubo pregunta con tools (ej. saludo sin esquemaOpenAI armado).';
COMMENT ON COLUMN public.asistente_uso.cantidad_tools_con_match IS
  'Cantidad de tools que matchearon por keyword antes de recortar a TOOLS_MAX_PROVEEDOR_TPM_CHICO. 0 cuando cayo_en_nucleo_fallback es true.';
COMMENT ON COLUMN public.asistente_uso.tool_finalmente_usada IS
  'Nombre de la última tool efectivamente ejecutada en el turno (toolsUsadas), sea cual sea el proveedor que respondió. NULL si el turno no ejecutó ninguna tool.';

-- ============================================================
-- VISTA: asistente_candidatos_sinonimo
-- Revisión semanal (sección "Diseño propuesto" del Frente 3): preguntas
-- que cayeron en el fallback por keyword pero terminaron ejecutando una
-- tool igual — candidatas a nuevo sinónimo/keyword en la descripción de
-- esa tool, o a caso de prueba para el Frente 2 (selección semántica).
-- No reemplaza un dashboard: es la query mínima que el plan pide para
-- no tener que leer logs a mano.
-- ============================================================
CREATE OR REPLACE VIEW public.asistente_candidatos_sinonimo AS
SELECT
  u.id,
  u.empresa_id,
  u.usuario_id,
  u.pregunta,
  u.proveedor_usado,
  u.tool_finalmente_usada,
  u.creado_en
FROM public.asistente_uso u
WHERE u.cayo_en_nucleo_fallback = true
  AND u.tool_finalmente_usada IS NOT NULL
ORDER BY u.creado_en DESC;

COMMENT ON VIEW public.asistente_candidatos_sinonimo IS
  'Frente 3 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: preguntas que el selector por keyword no supo matchear (cayó a TOOLS_NUCLEO_FALLBACK) pero terminaron ejecutando una tool de todas formas. Revisión semanal manual, no automatizada.';

-- Misma política de acceso que asistente_uso (RLS ya heredado, la vista
-- corre con los privilegios de quien consulta — security_invoker por
-- defecto en vistas normales de Postgres, no hace falta declararlo).
GRANT SELECT ON public.asistente_candidatos_sinonimo TO authenticated;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('supabase/migrations', '601_asistente_logging_seleccion_tools.sql', '601', 'claude-session',
        'Frente 3 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: 3 columnas nuevas en asistente_uso (cayo_en_nucleo_fallback, cantidad_tools_con_match, tool_finalmente_usada) para poder medir cuándo seleccionarToolsRelevantes() no matchea ninguna tool por keyword, más la vista asistente_candidatos_sinonimo para la revisión semanal de candidatos a sinónimo/keyword nuevo.')
ON CONFLICT (carpeta, archivo) DO NOTHING;
