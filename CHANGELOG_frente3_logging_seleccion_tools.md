# Frente 3 — Logging de fallas de selección de tools (PLAN_OPTIMIZACION_ASISTENTE_2026.md)

## Problema

No había forma de saber, sin leer logs de producción a mano, cuándo
`seleccionarToolsRelevantes()` (filtro por keyword usado para Groq/
OpenRouter) no encontraba ningún match y caía al set curado
`TOOLS_NUCLEO_FALLBACK`, ni si esa pregunta terminaba de todas formas con
una tool ejecutada (típicamente porque Gemini, que recibe el catálogo
completo sin este filtro, resolvió el turno).

## Qué se hizo

- **Migración 601** (`supabase/migrations/601_asistente_logging_seleccion_tools.sql`,
  aplicada y verificada en producción): 3 columnas nuevas en la tabla
  existente `asistente_uso` — `cayo_en_nucleo_fallback` (boolean),
  `cantidad_tools_con_match` (int), `tool_finalmente_usada` (text). Se
  extendió la tabla existente en vez de crear una nueva: es un dato 1:1
  por request, no una entidad propia.
- **Vista `public.asistente_candidatos_sinonimo`**: filtra las filas con
  `cayo_en_nucleo_fallback = true` y `tool_finalmente_usada` no nula —
  la consulta de revisión semanal que pide el plan, sin necesidad de
  dashboard nuevo.
- **`lib/asistente-tools/index.js`**: `seleccionarToolsRelevantes()` y
  `esquemaParaOpenAI()` ahora aceptan un 3er parámetro opcional
  `metaOut`, que mutan con `{ cayoEnNucleoFallback, cantidadToolsConMatch }`.
  Parámetro opcional a propósito — ningún call site existente (incluido
  el test de cobertura) se entera del cambio si no lo pasa.
- **`lib/handlers/asistente.js`**: arma `metaSeleccionTools = {}`, se lo
  pasa a `esquemaParaOpenAI()`, y junto con `tool_finalmente_usada`
  (última entrada de `toolsUsadas`, sea cual sea el proveedor que
  respondió el turno) se lo pasa a `registrarUso()`.
- **`lib/repos/asistente.js`**: `insertarUsoAsistente()` acepta y
  propaga los 3 campos nuevos al insert (todos opcionales, mismo
  criterio fail-open del resto del archivo).

## Tests

- `tests/asistente/cobertura-seleccion-tools.test.js`: 4 casos nuevos
  para el contrato de `metaOut` (fallback, match real, sin metaOut,
  propagación desde `esquemaParaOpenAI`).
- `tests/repos/asistente-uso.test.js` (nuevo): 2 casos — propaga los
  campos nuevos, y no rompe si no se pasan.
- Suite completa: **1810/1810 OK** (132 archivos, antes 1804/1804 —
  6 tests nuevos, cero regresiones).

## Para vos

- No requiere nada de tu parte además de este deploy: la migración ya
  está aplicada, y el logging arranca solo desde el próximo request al
  asistente.
- Para la revisión semanal que menciona el plan:
  `select * from asistente_candidatos_sinonimo;` (o filtrando por
  `empresa_id` si querés acotarlo a una sola empresa).
- Con esto, el Frente 4 (cierre del plan de voz) ya puede empezar a
  juntar los datos de uso real que le faltaban — solo hace falta dejarlo
  correr un tiempo en producción.
- Siguiente en la cola del plan: **Frente 2** (selección semántica por
  embeddings), el de mayor diseño pendiente.
