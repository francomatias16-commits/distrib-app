# v1007 — Frente 2 de PLAN_OPTIMIZACION_ASISTENTE_2026.md: selección de
tools por similitud semántica (embeddings)

## Problema

`seleccionarToolsRelevantes()` (`lib/asistente-tools/index.js`), usada
para recortar el catálogo de tools que reciben Groq/OpenRouter (Gemini
recibe el catálogo completo del rol, sin filtrar), matcheaba por
palabras clave con stemming casero. Fallaba cuando la pregunta usaba un
sinónimo sin raíz compartida con el nombre/description de la tool —
caso documentado en `tests/asistente/cobertura-seleccion-tools.test.js`:
"morosos" sola (sin la palabra "clientes") no encontraba
`listar_clientes_por_deuda`.

## Diseño

Mismo patrón que el RAG de artículos de ayuda
(`scripts/generar-embeddings-asistente.js` / `asistente_articulos` /
`buscar_articulos_asistente`, `gemini-embedding-001` a 768 dims),
aplicado ahora al catálogo de tools:

1. **Migración `602_asistente_tools_embeddings.sql`**: tabla
   `asistente_tools_embeddings` (`tool_nombre TEXT PK`,
   `embedding vector(768)`), RPC `buscar_tools_asistente_rpc()` — SIN
   filtro de rol en SQL (a diferencia de `buscar_articulos_asistente`):
   el filtro por rol de las tools ya lo hace
   `seleccionarToolsRelevantes()` en JS contra `toolsDelRol`, duplicarlo
   en SQL solo agregaría una segunda fuente de verdad para mantener
   sincronizada. También suma la columna `metodo_seleccion_tools` a
   `asistente_uso` (`'semantica' | 'keywords' | 'nucleo_fallback'`),
   continuación directa del logging del Frente 3 (migración 601).
2. **`scripts/generar-embeddings-tools.js`**: análogo al de artículos —
   recorre `TOOLS`, embebe `name + description` de cada una
   (`taskType: RETRIEVAL_DOCUMENT`), hace upsert a la tabla nueva y
   borra filas "fantasma" (tools renombradas/eliminadas del catálogo).
   Se corre a mano (`npm run cargar-embeddings-tools`), no en cada
   deploy ni con un cron.
3. **`lib/repos/asistente.js`**: `buscarToolsAsistenteRpc()` nueva
   (análoga a `buscarArticulosAsistenteRpc`, sin `p_rol`);
   `insertarUsoAsistente()` suma el campo opcional
   `metodo_seleccion_tools`.
4. **`lib/handlers/asistente.js`**: genera el embedding de la pregunta
   UNA sola vez y lo comparte entre la búsqueda semántica de artículos
   (ya existía) y la de tools (nueva) — evita pagar el costo/latencia de
   Gemini dos veces por el mismo texto, riesgo que el propio plan
   señalaba en la sección "Riesgo a vigilar" del Frente 2.
   `buscarToolsRelevantesPorEmbedding()` es fail-open: si la RPC falla
   (red, cuota, RPC caída) devuelve `null` y loguea, sin tumbar el
   turno — la keyword de siempre sigue como red de seguridad.
5. **`lib/asistente-tools/index.js`**: `seleccionarToolsRelevantes()` /
   `esquemaParaOpenAI()` suman el 4to parámetro opcional
   `sugerenciasSemanticas` (array de `tool_nombre` ya ordenado por
   similitud). Si al menos una sobrevive el filtro de rol, se usa esa
   selección directa y ni se llega a evaluar keywords; si no hay
   sugerencia utilizable (RPC caída, ninguna del rol actual, o
   simplemente no se pasó — todos los callers viejos siguen andando
   igual), se sigue de largo al matcheo por keyword de siempre, y de ahí
   a `TOOLS_NUCLEO_FALLBACK` si tampoco matchea nada. `metaOut` ahora
   también registra `metodoSeleccion` (`'semantica' | 'keywords' |
   'nucleo_fallback'`) para que el handler lo pase a `registrarUso()`.

## Tests

`tests/asistente/cobertura-seleccion-tools.test.js` extendido con:

- Caso de sinónimo documentado ANTES del fix (como pide el propio
  archivo): "morosos" sola NO matchea por keyword; CON la sugerencia
  semántica simulada (`['listar_clientes_por_deuda']`) SÍ la incluye.
  (Nota: "clientes morosos" completo ya matcheaba igual por keyword —
  por la palabra "clientes", literal en el nombre de la tool
  `listar_CLIENTES_por_deuda` — no por ningún sinónimo de "moroso"; ese
  caso no hubiera documentado un gap real.)
- `sugerenciasSemanticas` válida para el rol → la usa directa, sin
  evaluar keywords, `metodoSeleccion="semantica"`.
- Respeta el orden por similitud recibido (no reordena).
- Descarta las tools de la sugerencia que no son del rol actual, se
  queda con el resto.
- Sugerencia sin ninguna tool válida para el rol → cae a keyword (caso
  probado con rol `depositero`/`consultar_stock_critico`, no
  `vendedor`: esa tool ni siquiera está en los roles de `vendedor`, así
  que con ese rol el caso no probaba nada real).
- `sugerenciasSemanticas` vacío (`[]`) o `null`/`undefined` → se
  comporta como si no se hubiera pasado.
- `esquemaParaOpenAI` propaga el 4to parámetro sin cambiar la forma del
  esquema.
- Respeta `TOOLS_MAX_PROVEEDOR_TPM_CHICO` también en la rama semántica.

`tests/repos/asistente-uso.test.js` sumó cobertura de
`metodo_seleccion_tools` (propagado y `undefined` cuando no se pasa).
`tests/asistente/fase1-prompt-correccion.test.js` sumó
`buscarToolsAsistenteRpc: vi.fn()` al mock manual de
`lib/repos/asistente.js` (mock explícito por clave — sin el `vi.fn()`
nuevo, la key llegaba `undefined` al importar el handler real).

Suite completa: **132 archivos / 1823 tests**, todos verdes.

## Pendiente (fuera de alcance de este entorno)

- **Aplicar la migración 602 en producción** — el Supabase MCP
  disponible en esta sesión no tiene permisos sobre el proyecto
  (`jgiquzjwoedmzwqgzubr`); queda del lado del usuario, igual criterio
  que otras migraciones de esta línea de trabajo cuando no hay
  credenciales en el entorno.
- **Correr `npm run cargar-embeddings-tools`** una vez aplicada la
  migración — sin esto la tabla `asistente_tools_embeddings` queda
  vacía y `buscar_tools_asistente_rpc()` no devuelve nada (fail-open:
  `seleccionarToolsRelevantes()` sigue funcionando igual por keyword
  mientras tanto, solo sin el beneficio de la capa semántica).
- Frente 4 del plan (cierre de voz, validación con datos reales) sigue
  como estaba: ahora puede además cruzar `metodo_seleccion_tools` en
  `asistente_uso`/`asistente_candidatos_sinonimo` para ver cuánto
  aporta la capa semántica en producción real.
