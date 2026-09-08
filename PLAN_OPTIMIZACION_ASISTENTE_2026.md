# Plan de Optimización del Asistente AI (distrib-app)

> Estado (2026-09-07): Frentes 1, 3 y 5 cerrados en sesiones anteriores.
> **Frente 2 cerrado en código en esta sesión** — ver detalle al final
> de esa sección; queda pendiente aplicar la migración en producción
> (bloqueado por permisos del entorno, no por diseño). Sigue abierto el
> Frente 4 (depende de datos reales).

Base: análisis de `lib/asistente-tools/` (19 módulos, 98 tools),
`lib/handlers/asistente.js`, `lib/asistente-providers.js`,
`PLAN_COBERTURA_TOOLS_ASISTENTE.md` y
`PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`.

Cinco frentes, en orden de ejecución sugerido. Cada uno es independiente
— se puede mergear y desplegar por separado sin esperar a los demás.

---

## Frente 1 — Cerrar los frentes ya abiertos en PLAN_COBERTURA_TOOLS_ASISTENTE.md — ✅ cerrado

Ver `PLAN_COBERTURA_TOOLS_ASISTENTE.md`: migración 600 registrada,
Frentes 3/4/5 de ese plan confirmados completos en código, suite completa
1804/1804 OK.

---

## Frente 2 — Selección de tools por similitud semántica (embeddings) — 🟡 cerrado en código (2026-09-07), falta aplicar en producción

**Problema actual:** `seleccionarToolsRelevantes()` en
`lib/asistente-tools/index.js` matchea por palabras clave con stemming
casero. Falla cuando el usuario usa un sinónimo que no comparte raíz con
el nombre/descripción de la tool (ej. "morosos" no encuentra
`listar_clientes_por_deuda` si "moroso" no está escrito en su
descripción). Esto solo afecta a Groq/OpenRouter (Gemini recibe el
catálogo completo del rol, sin filtrar).

**Por qué conviene ahora:** el proyecto ya tiene toda la infraestructura
de embeddings funcionando para los artículos de ayuda
(`scripts/generar-embeddings-asistente.js`, tabla `asistente_articulos`
con columna `embedding`, RPC `buscar_articulos_asistente`,
`gemini-embedding-001` a 768 dims). Es reusar el mismo patrón, no
construir uno nuevo.

### Diseño implementado
1. **Migración SQL** (`602_asistente_tools_embeddings.sql`) — tabla
   `asistente_tools_embeddings`: `tool_nombre TEXT PK, embedding
   VECTOR(768)`; RPC `buscar_tools_asistente_rpc(query_embedding,
   match_count, match_threshold)` SIN filtro de rol en SQL (lo hace JS);
   columna `metodo_seleccion_tools` en `asistente_uso`.
2. **Script** `scripts/generar-embeddings-tools.js`: recorre `TOOLS`,
   embebe `name + description` de cada una con `taskType:
   RETRIEVAL_DOCUMENT`, hace upsert a la tabla nueva y borra tools
   fantasma. Se corre a mano (`npm run cargar-embeddings-tools`) cada
   vez que se agrega/edita/borra una tool — no en cada deploy.
3. **En el handler** (`lib/handlers/asistente.js`): el embedding de la
   pregunta se genera una sola vez y se comparte entre la búsqueda de
   artículos y la de tools (`buscarToolsRelevantesPorEmbedding()`,
   fail-open — un fallo de la RPC no tumba el turno).
4. **Fallback de keywords como red de seguridad**: si la búsqueda
   semántica no trae nada utilizable para el rol actual (RPC caída, sin
   cuota, catálogo cambiado y embeddings no regenerados, o
   simplemente no se pasó parámetro), `seleccionarToolsRelevantes()`
   sigue de largo al matcheo por keyword existente, sin romper ningún
   caller viejo.
5. **`TOOLS_NUCLEO_FALLBACK`** se mantiene igual para preguntas sin
   ningún match ni semántico ni por keyword.

Detalle completo, tests agregados y hallazgos (2 tests con premisa
incorrecta corregidos durante la verificación) en
`CHANGELOG_v1007_frente2_seleccion_semantica_tools.md`. Suite completa
1823/1823 OK.

### Pendiente (no es código, es infraestructura del entorno)
- [ ] Aplicar `602_asistente_tools_embeddings.sql` en producción — el
      Supabase MCP disponible en la sesión donde se escribió el código
      no tenía permisos sobre el proyecto; queda del lado del usuario.
- [ ] Correr `npm run cargar-embeddings-tools` una vez aplicada la
      migración (y de nuevo cada vez que cambie el catálogo de tools).
- [ ] Con datos reales corriendo, revisar `metodo_seleccion_tools` en
      `asistente_uso` para medir cuánto aporta la capa semántica sobre
      el keyword solo (insumo también para el Frente 4).

---

## Frente 3 — Logging de fallas de selección de tools — ✅ cerrado (2026-09-07)

**Problema actual:** no hay forma de saber, sin leer manualmente los
logs de producción, cuándo el asistente no encontró ninguna tool
relevante o el usuario tuvo que reformular. Las dos correcciones ya
hechas (v1066/v1067) salieron de que alguien notó el caso a mano.

### Diseño propuesto
1. Agregar columnas a `asistente_uso` (o tabla nueva
   `asistente_selecciones_tool`):
   `cayo_en_nucleo_fallback BOOLEAN`, `cantidad_tools_con_match INT`,
   `tool_finalmente_usada TEXT NULL`.
2. Registrar esos datos en `registrarUso()` del handler, sin bloquear la
   respuesta al usuario (mismo criterio fail-open que ya usan en todo el
   archivo).
3. Una vista o query simple (no hace falta dashboard nuevo todavía) para
   revisar semanalmente: preguntas que cayeron en `TOOLS_NUCLEO_FALLBACK`
   pero terminaron con una tool ejecutada de todas formas (esas son las
   candidatas a nuevo sinónimo/keyword, o a caso de prueba para el
   Frente 2).

### Tareas
- [x] Migración SQL (columnas nuevas) — migración `601_asistente_logging_
      seleccion_tools.sql`: `cayo_en_nucleo_fallback`,
      `cantidad_tools_con_match`, `tool_finalmente_usada` agregadas a
      `asistente_uso`, aplicada y verificada en producción vía Supabase MCP.
- [x] Modificar `registrarUso()` para completar los campos nuevos —
      `seleccionarToolsRelevantes()`/`esquemaParaOpenAI()` ahora aceptan
      un 3er parámetro opcional `metaOut` que mutan con
      `{ cayoEnNucleoFallback, cantidadToolsConMatch }`; el handler lo
      pasa a `registrarUso()` junto con `tool_finalmente_usada` (última
      entrada de `toolsUsadas`, sea cual sea el proveedor que respondió).
- [x] Query/vista de revisión semanal — vista
      `public.asistente_candidatos_sinonimo`: preguntas con
      `cayo_en_nucleo_fallback = true` que igual terminaron ejecutando
      una tool (candidatas a nuevo sinónimo/keyword, o caso de prueba
      para el Frente 2).

**Verificación:** 6 tests nuevos (metaOut en
`cobertura-seleccion-tools.test.js`, propagación de campos en
`tests/repos/asistente-uso.test.js`), suite completa 1810/1810 OK.

---

## Frente 4 — Cierre del plan de voz (validación real) — 🟡 depende de datos reales, no es código

`PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md` ya tiene la cobertura de
tools prácticamente completa (todas las filas 🔴/🟠 resueltas o
excluidas con justificación). Lo que falta es exactamente lo que ya
marca el propio plan como pendiente:

### Tareas (copiadas del checklist original, sin inventar nada nuevo)
- [ ] Cada tool de escritura nueva probada con al menos un caso real
      **por voz dictada** contra el frontend desplegado (no alcanza con
      probar la RPC).
- [ ] Al menos una sesión de prueba end-to-end por fase: dictar → resumen
      correcto → confirmar → estado final idéntico a como quedaría hecho
      a mano (mismo registro en auditoría).
- [ ] Datos de uso real de la Fase A (tool por voz vs. a mano) antes de
      encarar la Fase B — **con el Frente 3 ya cerrado, esto ya se puede
      empezar a juntar**: dejar correr el asistente en producción unas
      semanas y después consultar `asistente_uso` /
      `asistente_candidatos_sinonimo` / `asistente_fase_a_uso_semanal`.

### Vistas de revisión (migración `603_asistente_frente4_vistas_revision.sql`)
Preparadas en esta sesión, mismo criterio que `asistente_candidatos_
sinonimo` (migración 601) — consulta lista para correr, no un dashboard
nuevo:
- `asistente_fase_a_uso_semanal` — cuenta por semana cuántas veces se
  ejecutó cada una de las 5 tools de escritura de la Fase A
  (`registrar_cobro_cliente`, `crear_producto`, `editar_producto`,
  `anular_factura`, `emitir_factura`) vía el asistente. Es la mitad
  automatizable de la tarea de arriba — la otra mitad (uso manual desde
  el panel para comparar) no tiene un log unificado para cruzar
  automáticamente todavía.
- `asistente_metodo_seleccion_resumen` — de yapa, para el Frente 2: una
  vez aplicada la migración 602 y cargados los embeddings, muestra
  semana a semana cuánto se resolvió por `semantica` vs. `keywords` vs.
  `nucleo_fallback`, para confirmar el impacto real de la selección
  semántica en producción.

**Pendiente:** igual que la 602, esta migración todavía no se pudo
aplicar en producción desde este entorno (sin permisos del Supabase MCP
sobre el proyecto) — queda del lado del usuario.

---

## Frente 5 — Soporte de más formatos de archivo (PDF, Word, Excel, etc.) — ✅ cerrado

Ver `CHANGELOG_v953_asistente_frente5_multiformato_pdf_word_excel_csv.md`:
`validarArchivoPorContenido()` extendida, `extraer-texto-archivo.js`
nuevo, handler ramificando imagen vs. documento, dependencias
`pdf-parse`/`mammoth`/`xlsx` sumadas. Suite propia 373/373 OK.

---

## Orden de ejecución sugerido

1. ~~Frente 1~~ ✅
2. ~~Frente 5~~ ✅
3. ~~Frente 3~~ ✅
4. ~~Frente 2~~ 🟡 cerrado en código — falta aplicar la migración 602 y
   correr `cargar-embeddings-tools` en producción (pendiente del
   usuario, ver sección del Frente 2)
5. **Frente 4** (cierre del plan de voz) — ya se pueden empezar a juntar
   datos de uso real con el Frente 3 andando (y ahora también
   `metodo_seleccion_tools` del Frente 2); falta la parte que no es
   código (pruebas manuales por voz).
