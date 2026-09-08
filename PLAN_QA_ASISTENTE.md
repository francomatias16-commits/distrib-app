# Plan de QA del asistente IA (2026-09-07)

## 0. Por qué existe este plan

`PLAN_COBERTURA_TOOLS_ASISTENTE.md` arrancó de un síntoma: un cliente
preguntó algo puntual y el asistente cayó al fallback genérico. Ese plan
resuelve la causa de **ese** caso (huecos entre RPCs y tools). Este plan
resuelve algo distinto y más de fondo: **hoy no existe ningún proceso que
detecte ese tipo de falla antes de que la vea un cliente**, ni forma de
saber si el asistente responde bien de verdad, más allá de "elige la tool
correcta" (que es todo lo que prueba `tests/asistente/` hoy).

Relevamiento del estado actual:

| Capa | Qué prueba | Dónde | Contra modelo real |
|---|---|---|---|
| Ejecución de tools | Cada `execute()` arma bien la query y propaga errores | `tests/asistente/*.test.js` (28 archivos) | No — DB mockeada |
| Selección de tools | `seleccionarToolsRelevantes()` elige la tool correcta para una pregunta | `cobertura-seleccion-tools.test.js` | No — función pura, sin LLM |
| Cobertura RPC↔tool | Toda RPC relevante tiene su tool, toda tool apunta a una RPC real | `scripts/audit-asistente-tools.js` | No — estático |
| **Calidad de la respuesta final** | ¿El texto que recibe el usuario es correcto? | **No existe** | — |
| **Comparación entre proveedores** | Gemini vs. Groq vs. OpenRouter para la misma pregunta | **No existe** | — |
| **Detección de fallas reales en producción** | Conversaciones que cayeron a fallback o quedaron sin resolver | **No existe** | — |
| **Calidad del `resumen()` de tools de escritura** | Que no prometa algo que no pasó, que sea inequívoco | **No existe** | — |

Las primeras tres filas están bien y no se tocan. Las últimas cuatro son
el objeto de este plan.

## 1. Capa 1 — Corpus de selección más realista — ✅ implementada (2026-09-08)

`cobertura-seleccion-tools.test.js` prueba una sola redacción "prolija"
por tool. En producción las preguntas no vienen así: hay errores de
tipeo, sinónimos, jerga rioplatense, preguntas compuestas y repreguntas
cortas (el propio archivo documenta que una repregunta corta — *"y
20000"* — ya rompió el selector una vez).

**Acción:** por cada tool con al menos 1 caso hoy, sumar 2-3 variantes:
una con error de tipeo/sin tildes, una con sinónimo o forma coloquial, y
(para tools de dominio con seguimiento típico) una repregunta corta con
contexto previo. Sigue siendo determinístico y sin costo de cuota — se
agrega directo a `cobertura-seleccion-tools.test.js`, no hace falta
infraestructura nueva.

Regla de alta: cada vez que un caso real de producción (Capa 3) revele
que el selector eligió mal, ese caso se suma acá **primero** (test en
rojo) y recién después se ajusta la `description`/keywords de la tool —
mismo criterio que ya declara el comentario de cabecera del archivo.

### Qué se agregó

- **`CASOS_VARIANTES`** (nuevo array en `cobertura-seleccion-tools.test.js`,
  después de `CASOS`) — 2 variantes por cada una de las 53 tools únicas
  que ya tenían caso en `CASOS` (106 casos): una de tipeo/sin tildes
  (`"cuantos clientes tienen mas de 150000 en deudaa"`) y una de
  sinónimo/forma coloquial rioplatense (`"quiénes son los clientes que
  más me deben"`, `"cargame un cliente nuevo"`). Cada variante se validó
  a mano contra `seleccionarToolsRelevantes()` real antes de sumarla —
  **no se tocó ninguna `description` de tool para "hacerla pasar"**;
  donde una redacción rompía por ambigüedad real del vocabulario
  (`consultar_preferencias_notificaciones` con la palabra clave del
  nombre mal escrita, sin ningún otro término del dominio en la frase),
  se reformuló la pregunta en vez de tocar la tool.
- **`CASOS_SEGUIMIENTO`** (dentro de la sección de repreguntas cortas) —
  sumadas 9 repreguntas cortas más a las 3 que ya existían (12 en total),
  cubriendo `consultar_puntos_cliente`, `listar_notas_credito`,
  `listar_movimientos_caja`, `listar_cobros`,
  `listar_reglas_precio_asistente`, `listar_movimientos_bancarios_pendientes`,
  `consultar_ranking_ahorro_proveedores`, `listar_facturas` y
  `listar_pedidos_por_filtro` — todas tools que NO están en
  `TOOLS_NUCLEO_FALLBACK` (mismo criterio que ya documenta el comentario
  del bloque: si estuvieran, el caso "sola" pasaría igual sin probar
  nada real sobre el bug de contexto perdido).
- Suite completa corrida en verde: **132 archivos, 1919 tests** (1795
  antes de esta capa + 106 + 24 nuevos = 1919). Ningún caso quedó en
  rojo — no hizo falta tocar ninguna `description`/keyword de tool real
  en esta pasada; si una corrida futura de Capa 3 encuentra un caso real
  que el selector pierda, ESE es el que se suma en rojo primero.

## 2. Capa 2 — Eval contra modelo real (lo que falta del todo)

Nada de lo que existe llama de verdad a Gemini/Groq/OpenRouter. Esta capa
lo agrega, como proceso **aparte de CI** (consume cuota real, no debe
correr en cada PR).

### 2.1 Dataset

`tests/asistente/evals/casos.json` — cada caso:

```json
{
  "id": "clientes-deuda-01",
  "rol": "dueno",
  "pregunta": "cuántos clientes tienen más de 150000 en deuda",
  "historial": [],
  "tool_esperada": "listar_clientes_por_deuda",
  "criterio_respuesta": "Debe mencionar una cantidad de clientes y el umbral de $150.000."
}
```

`historial` permite casos multi-turno (repreguntas cortas, correcciones
— ver `fase1-prompt-correccion.test.js` para los escenarios ya
identificados como delicados). `criterio_respuesta` es lenguaje natural,
no un string exacto: lo evalúa el juez (ver 2.3), no un `includes()`.

Semilla inicial entregada con este plan: 12 casos cubriendo los dominios
con incidentes reales documentados (clientes/deuda, pedidos, stock,
facturación, una repregunta corta, y un caso de tool de escritura con
confirmación pendiente).

### 2.2 Script `scripts/eval-asistente.js`

Corre cada caso contra un proveedor elegido (`--provider=gemini|groq|openrouter`,
default los tres), reusando **las mismas funciones que usa producción**
(`armarSystemPrompt`, `buscarArticulosRelevantes`, `esquemaParaGemini`,
`esquemaParaOpenAI`, `ejecutarTool`, `responderConFallback`) contra una
empresa de prueba real en Supabase — mismo patrón que
`scripts/seed-demo-loadtest.js` (variable `EMPRESA_ID`, nunca hardcodeada).
Fuerza el proveedor sin pasar por la cadena de fallback completa, para
poder comparar cada uno de forma aislada.

Por cada caso registra: tool(s) llamada(s) vs. esperada, tiempo de
respuesta, y el texto final. Entregado junto con este plan (ver archivo).

### 2.3 El juez

Para calificar el texto libre de la respuesta contra `criterio_respuesta`,
una segunda llamada (misma función `responderConFallback`, sin tools) con
un prompt tipo:

> Pregunta del usuario: "{pregunta}". Respuesta del asistente: "{texto}".
> Criterio: "{criterio_respuesta}". ¿La respuesta cumple el criterio?
> Contestá solo PASA o NO_PASA seguido de un motivo en una línea.

No reemplaza revisión humana — es un primer filtro barato para no tener
que leer las 12+ respuestas a mano cada vez que se corre. Casos NO_PASA
se revisan siempre a mano antes de decidir si es un bug real o un falso
negativo del juez.

### 2.4 Cuándo correr esto

No en CI. Cadencia propuesta: manual antes de cualquier cambio grande al
system prompt, al catálogo de tools, o a `asistente-providers.js`; y
aparte, cada vez que se agregue un caso nuevo por la Capa 3.

## 3. Capa 3 — Loop de producción → regresión — ✅ implementada (2026-09-07)

Hoy `asistente_conversaciones`/`asistente_mensajes` guardan todo, pero
nadie las revisa de forma sistemática para encontrar fallas. El hallazgo
que originó `PLAN_COBERTURA_TOOLS_ASISTENTE.md` salió de un reclamo
puntual de un cliente, no de un proceso.

**Acción:** una query (no un cron automático por ahora — no hay
suficiente volumen de conversaciones todavía para justificar
automatizarlo del todo) sobre `asistente_mensajes` que liste candidatos a
revisar:

- Conversaciones donde `toolsUsadas` vino vacío pero la pregunta contiene
  palabras de dominio conocidas (mismo diccionario de
  `palabrasSignificativas()`, reutilizado — no reinventar uno nuevo).
- Conversaciones donde el mismo usuario repreguntó dentro del minuto
  siguiente (señal de que la primera respuesta no le sirvió).
- Conversaciones que terminaron en `proveedor: 'groq'` u `'openrouter'`
  (Gemini agotado) — son el escenario de mayor riesgo por el catálogo
  filtrado, conviene mirarlas primero.

Cada resultado revisado a mano que resulte ser una falla real se
convierte en: (a) un caso nuevo en la Capa 1 si fue un problema de
selección, (b) un caso nuevo en la Capa 2 si fue un problema de calidad
de respuesta, o (c) un hueco de cobertura para
`PLAN_COBERTURA_TOOLS_ASISTENTE.md` si fue una RPC/tool faltante.

### Qué hacía falta y qué se agregó

Ninguna de las tres señales se podía calcular todavía: `asistente_uso` no
sabía a qué conversación pertenecía cada turno ni qué tools se habían
llamado (`toolsUsadas` ya lo devolvía `responderConFallback()` pero se
descartaba sin persistir, ver el comentario viejo en
`lib/handlers/asistente.js` línea ~754).

1. **Migración `600_asistente_uso_conversacion_y_tools.sql`** — agrega
   `conversacion_id` (nullable, FK a `asistente_conversaciones`, filas
   viejas quedan sin asociar) y `tools_usadas` (`jsonb NOT NULL DEFAULT
   '[]'`) a `asistente_uso`, más índices por `conversacion_id` y por
   `(proveedor_usado, creado_en)` para el chequeo de fallback.
2. **`lib/repos/asistente.js`** — `insertarUsoAsistente()` acepta los dos
   campos nuevos (`conversacion_id = null`, `tools_usadas = []` por
   default, así ningún llamador viejo se rompe).
3. **`lib/handlers/asistente.js`** — `registrarUso()` ahora recibe
   `conversacionId`/`toolsUsadas` y los pasa al repo. Se persiste solo el
   **nombre** de cada tool llamada (`toolsUsadas.map(t => t.nombre)`), no
   `args`/`resultado` completos — es lo único que necesita la Capa 3 y
   evita duplicar en `asistente_uso` datos de negocio que ya viven en las
   tablas que cada tool tocó.
4. **`palabrasSignificativas()`** ahora se exporta desde
   `lib/asistente-tools/index.js` (y el barrel `lib/asistente-tools.js`)
   para que el script de detección use el mismo diccionario que el
   selector real, sin reinventarlo.
5. **`scripts/detectar-fallas-asistente.js`** — implementa las tres
   señales de arriba contra Supabase real (`SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY`, `--dias=N` default 7, `--json`).
   `SIN_TOOL` filtra `tools_usadas` vacío en JS (no con `.eq()` contra la
   columna jsonb, para no depender de cómo PostgREST/supabase-js
   serialicen la igualdad) y después chequea vocabulario de dominio
   contra el catálogo completo de `TOOLS`. `REPREGUNTA` ordena
   `asistente_mensajes` por conversación+fecha y busca turnos `user`
   consecutivos con menos de 60s de diferencia. `FALLBACK` filtra
   `proveedor_usado in (groq, openrouter)`. Agregado como
   `npm run detectar:fallas-asistente` (y `:json`).
6. Tests: `tests/repos/asistente.test.js` (los dos campos nuevos y sus
   defaults). El script en sí no tiene test unitario — mismo criterio que
   `scripts/eval-asistente.js` y `scripts/audit-resumenes-asistente.js`:
   son procesos manuales contra Supabase real, no lógica pura mockeable
   sin reimplementar la query.

### Pendiente real (no automatizable todavía)

No hay volumen de conversaciones en producción para saber si las 3
señales dan señal útil o mucho ruido — la primera corrida real de
`npm run detectar:fallas-asistente` va a decir si hace falta ajustar los
umbrales (los 60s de REPREGUNTA y qué cuenta como "palabra de dominio").
No convertir ningún WARN de esa primera corrida en caso de Capa 1/2 sin
revisarlo a mano primero.

## 4. Capa 4 — QA de tools de escritura (`requiereConfirmacion: true`) — ✅ implementada (2026-09-08)

Estas son las únicas tools donde un error de calidad no es solo "el
usuario no obtuvo el dato": es una acción real (anular factura, dar de
baja un cliente) ejecutada porque el `resumen()` no fue lo bastante claro
antes de que el usuario tocara Confirmar.

### Bug real encontrado al armar esta capa (ya corregido)

`resumen()` de `anular_factura` y `emitir_factura`
(`lib/asistente-tools/facturacion.js`) hacía `if (factura.ambiguo) return
factura;` — devuelve un **objeto**, no un string, cuando la referencia es
ambigua (2+ facturas/pedidos recientes del mismo cliente). `ejecutarTool()`
inserta lo que sea que devuelva `resumen()` tal cual en la columna
`resumen TEXT NOT NULL` de `asistente_acciones_pendientes` (migración
419) — eso rompe el insert en el **primer** llamado a la tool (antes de
que exista ninguna propuesta pendiente), en vez de pedirle al usuario que
elija un candidato.

Es el mismo bug que ya se había encontrado y corregido del lado de
`execute()` (ver el comentario largo ahí, y
`tests/asistente/facturacion-ambiguedad-execute.test.js`) — pero nunca se
generalizó como chequeo, así que sobrevivió del lado de `resumen()`, que
corre antes. Fix: `resumen()` ahora tira `throw ambiguo({...})` con la
misma lista de candidatos que ya arma `execute()`, en vez de devolver el
objeto. Test de regresión:
`tests/asistente/facturacion-resumen-ambiguedad.test.js`.

### Qué queda implementado

1. **`scripts/audit-resumenes-asistente.js`** — auditoría estática (sin
   Supabase, sin cuota de IA) sobre las 48 tools con
   `requiereConfirmacion: true`:
   - ERROR: `resumen()`/`execute()` propagan un `.ambiguo` crudo con
     `return` en vez de `throw` (generalización del bug de arriba — así
     una tool nueva no lo reintroduce).
   - ERROR: falta `resumen()` o `execute()` (contrato roto).
   - WARN: `resumen()` sin ninguna interpolación de datos (texto
     probablemente genérico).
   - WARN: `resumen()` con una frase que puede leerse como "ya se hizo".
   - Corrido sobre el catálogo actual: **0 errores, 0 warnings** (después
     del fix de arriba). Agregado a `npm run audit:all`.
2. **`tests/asistente/facturacion-resumen-ambiguedad.test.js`** — prueba
   el caso puntual encontrado, mismo harness que el test ya existente del
   lado de `execute()`.

### Checklist que queda para revisión manual puntual (no automatizable con regex)

- [ ] Que el monto/nombre en el `resumen()` sea el dato real de la
      operación, no un placeholder — el script solo detecta *ausencia*
      de interpolación, no si la interpolación es la correcta.
- [ ] Que `execute()` re-valide el estado en el momento de ejecutar (no
      solo cuando se armó el resumen) — ya es el patrón en
      `anular_factura`/`emitir_factura`/`anular_venta_pos`, revisar que
      las tools de escritura nuevas lo repliquen.

## 5. Qué NO cambia

- Los 28 archivos de `tests/asistente/*.test.js` existentes.
- `scripts/audit-asistente-tools.js`.
- El criterio de `PLAN_COBERTURA_TOOLS_ASISTENTE.md` para agregar tools
  nuevas — este plan es complementario, no lo reemplaza.

## 6. Orden de ejecución propuesto

1. ~~**Capa 1** — sumar variantes al corpus de selección existente~~ ✅
   **hecho (2026-09-08)** — 106 variantes de tipeo/sinónimo + 9
   repreguntas cortas nuevas, ver sección 1.
2. **Capa 2** — dataset semilla + `scripts/eval-asistente.js` (entregados
   con este plan, listos para correr con credenciales reales; **no
   corrido todavía** contra un proveedor real).
3. ~~**Capa 4** — checklist de tools de escritura~~ ✅ **hecho
   (2026-09-08)** — `scripts/audit-resumenes-asistente.js` + fix real
   encontrado y corregido en `facturacion.js` (ver sección 4).
4. ~~**Capa 3** — query de detección sobre conversaciones reales~~ ✅
   **hecho (2026-09-07)** — `scripts/detectar-fallas-asistente.js`, ver
   sección 3. Todavía no corrida contra producción real (falta volumen).

Las 4 capas están implementadas. Lo único pendiente de verdad es
**correr** Capa 2 y Capa 3 contra datos/proveedores reales — ninguna de
las dos corre en CI a propósito (consumen cuota o necesitan volumen de
conversaciones) — y revisar a mano lo que salga.

## 7. Checklist reutilizable (por cada bug real de asistente encontrado)

- [ ] ¿Fue de selección (eligió mal la tool)? → caso nuevo en
      `cobertura-seleccion-tools.test.js`.
- [ ] ¿Fue de calidad de respuesta (eligió bien, contestó mal)? → caso
      nuevo en `tests/asistente/evals/casos.json`.
- [ ] ¿Fue de cobertura (no había tool para eso)? → seguir el proceso de
      `PLAN_COBERTURA_TOOLS_ASISTENTE.md`.
- [ ] ¿Fue de un `resumen()` ambiguo en una tool de escritura? → revisar
      checklist de la Capa 4 para esa tool puntual.
