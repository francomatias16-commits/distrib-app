# Plan de QA del asistente de WhatsApp (2026-09-08)

## 0. Por qué existe este plan y de dónde sale

`PLAN_QA_ASISTENTE.md` diseñó 4 capas de QA para el asistente de ayuda del
dashboard (`lib/handlers/asistente.js` + `lib/asistente-tools/`). Este
documento evalúa, capa por capa, si ese mismo diseño sirve para el
asistente de pedidos por WhatsApp (`lib/whatsapp-pedido-tools.js` +
`lib/handlers/notif.js`) y define qué falta para poder aplicarlo de
verdad, en vez de asumir que es un copy-paste.

No son el mismo asistente. Comparten la pieza más cara de reemplazar
(`responderConFallback()` en `lib/asistente-providers.js` — la cadena
Gemini→Groq→OpenRouter con rotación de keys y circuit breaker) pero el
contrato de tools, el modelo de usuario y el mecanismo de confirmación
son distintos por diseño:

| | Asistente de ayuda (dashboard) | Asistente de WhatsApp |
|---|---|---|
| Usuario | Empleado/dueño logueado, con `rol` | Cliente identificado por teléfono, sin login |
| Catálogo de tools | `lib/asistente-tools/*.js` — 66 tools con `requiereConfirmacion: true` | `lib/whatsapp-pedido-tools.js` — 6 tools, ninguna con `resumen()`/confirmación propia |
| Confirmación de una acción real | La tool arma `resumen()` → queda en `asistente_acciones_pendientes` → el usuario toca "Confirmar" | El modelo **nunca** confirma el pedido; un "sí" determinístico del cliente dispara `crearPedidoDesdeBorrador()` en `lib/handlers/notif.js`, fuera del control del modelo |
| Conversación persistida | `asistente_conversaciones` / `asistente_mensajes` | `whatsapp_conversaciones` / `whatsapp_mensajes` |
| Qué tool se usó / qué proveedor respondió | `asistente_uso.tools_usadas` + `asistente_uso.proveedor_usado` (migración 600) | `responderConFallback()` ya devuelve `proveedor` y `toolsUsadas` pero `notif.js` solo los **loguea a consola** (`[whatsapp-webhook] respuesta de ${resultado.proveedor}...`) — no se persiste en ninguna tabla |

Relevamiento de lo que existe hoy del lado de WhatsApp, mismo criterio
que la tabla de la sección 0 de `PLAN_QA_ASISTENTE.md`:

| Capa | Qué prueba | Dónde | Contra modelo real |
|---|---|---|---|
| Ejecución de tools | Cada `execute()` de `whatsapp-pedido-tools.js` arma bien la query | `tests/handlers/whatsapp-pedido-tools.test.js`, `whatsapp-pedido-borrador.test.js` | No — DB mockeada |
| Motor de conversación (estados, borrador, tope de plan) | `tests/handlers/whatsapp-motor-conversacion.test.js`, `whatsapp-tope-plan.test.js` | No — DB mockeada |
| Selección de tools con corpus realista | **No existe** (no hay equivalente de `cobertura-seleccion-tools.test.js`) | — |
| Calidad de la respuesta final contra modelo real | **No existe** | — |
| Detección de fallas reales en producción | **No existe** (y falta la instrumentación mínima — ver Capa 3 abajo) | — |
| QA del borrador de pedido (equivalente a los `resumen()` ambiguos) | **No existe** una auditoría estática; sí hay tests puntuales | Parcial |

## 1. Capa 1 — no aplica como test unitario; se resuelve absorbida en la Capa 2 — ✅ resuelto (2026-09-08)

**Corrección sobre el diseño original de esta sección:** al ir a
implementarla apareció una diferencia estructural que invalida el plan
tal como estaba escrito. `PLAN_QA_ASISTENTE.md` prueba
`seleccionarToolsRelevantes()` — una función pura que, de las 66 tools
del rol, **filtra por keyword** cuáles se le declaran al modelo (existe
porque 66 tools de una es demasiado catálogo para declarar siempre).
`lib/whatsapp-pedido-tools.js` no tiene una función equivalente: las 6
tools (`esquemaPedidoWhatsAppGemini()`/`esquemaPedidoWhatsAppOpenAI()`)
se declaran **siempre todas, sin filtro**, porque son pocas. No hay
ninguna función determinística de selección para testear como unidad —
un test que "pruebe la selección" estaría probando código que no existe.

Lo que sí es un riesgo real y equivalente en espíritu — que, dado un
mensaje del cliente con las 6 tools siempre disponibles, el modelo elija
la correcta — **solo se puede medir contra un modelo real**, no con una
función pura. Eso es exactamente la Capa 2. Por eso esta capa no se
implementa como test separado: el corpus de variantes (typo, coloquial
rioplatense, repregunta corta) que iba a vivir acá se armó directo como
el dataset de la Capa 2 (`tests/handlers/evals-whatsapp/casos.json`,
sección 2 más abajo) — no hay una Capa 1 aparte para WhatsApp, hay una
Capa 2 con un dataset más grande de lo que hubiera tenido el asistente
del dashboard (que si necesita las dos capas, porque ahí sí existe la
función pura de selección para testear barato y sin cuota).

**Qué se agregó:** nada en esta sección — ver sección 2, que absorbe lo
que iba a ser esta capa.

## 2. Capa 2 — Eval contra modelo real — ✅ implementada (2026-09-08)

**Aplica casi sin cambios de infraestructura**, porque
`scripts/eval-asistente.js` ya reusa `responderConFallback()`, que es
exactamente lo que usa `notif.js`. La diferencia real está en qué
funciones de armado de prompt/tools se invocan.

**Acción — dos caminos, elegir uno:**

- **(a) Generalizar el script existente**: `scripts/eval-asistente.js`
  recibe un flag `--target=asistente|whatsapp` (default `asistente`,
  no rompe el uso actual) que selecciona qué `armarSystemPrompt`/
  esquema de tools/`ejecutar` usar. Evita duplicar la lógica de
  llamar a los 3 proveedores, medir latencia y correr el juez.
- **(b) Script aparte** `scripts/eval-asistente-whatsapp.js`, si el
  armado de prompt de WhatsApp diverge demasiado como para que el
  flag ensucie el script original (a juzgar por `notif.js`, el
  system prompt de WhatsApp es fijo por tenant/catálogo, no arma un
  RAG de artículos como `buscarArticulosRelevantes()` — con lo cual
  el script generalizado tendría una rama entera que no aplica).

Dado que ya hay una asimetría real (RAG de artículos existe solo del
lado dashboard), se eligió **(b)** — menos condicionales ocultando dos
flujos distintos.

### 2.1 Prerrequisito de código — ✅ hecho

Para que el script reuse el prompt real de producción (mismo criterio
que ya exige la Capa 2 original: "no reimplementa nada del pipeline
real"), el prompt de `procesarConAsistente()` en `lib/handlers/notif.js`
—que antes estaba pegado a mano dentro de esa función— se extrajo a
`armarSystemPromptWhatsApp()`, exportada desde el mismo archivo. Es
texto estático (no depende de la conversación), así que no recibe
argumentos; `procesarConAsistente()` la llama igual que antes, sin
cambio de comportamiento. Sin esto, el script de eval hubiera tenido
que mantener una copia del prompt pegada a mano — exactamente el tipo
de duplicación que la Capa 2 original evita reusando
`armarSystemPrompt()`.

### 2.2 Dataset — ✅ hecho

`tests/handlers/evals-whatsapp/casos.json` — mismo formato que
`tests/asistente/evals/casos.json` pero con `tool_esperada` apuntando
al catálogo de `whatsapp-pedido-tools.js` y `criterio_respuesta`
centrado en pedidos: ¿ofreció el precio real (no `precio_base`)?,
¿el borrador quedó con la cantidad correcta?, ¿derivó a un humano
cuando correspondía?

Este dataset absorbe lo que iba a ser la Capa 1 (ver sección 1): además
de 1 caso prolijo por tool (las 6 tools cubiertas), suma variantes de
typo/sin tildes y forma coloquial rioplatense sobre
`buscar_productos`/`agregar_item` (3 casos), 3 casos con `historial`
multi-turno (seguimiento de un producto ya identificado, repregunta
corta tipo "y ponéle 4"), 2 casos de `derivar_humano` (pedido explícito
de hablar con alguien vs. motivo de negocio — precio especial por
volumen) y 1 caso explícito de **no** derivar ante una respuesta
ambigua ("si" sin cantidad — ver el FIX documentado en la propia tool
sobre no derivar por cansancio), más 1 caso de "sin acceso a
catálogo/herramientas" (fallback del propio prompt, texto de
`armarSystemPromptWhatsApp().sinTools`). 13 casos en total.

### 2.3 Script — ✅ hecho

`scripts/eval-asistente-whatsapp.js`, mismo patrón que
`scripts/eval-asistente.js`: reusa `armarSystemPromptWhatsApp()`,
`esquemaPedidoWhatsAppGemini/OpenAI`, `ejecutarToolPedidoWhatsApp` y
`responderConFallback` — no reimplementa nada del pipeline real. Crea
una fila real en `whatsapp_conversaciones` por caso (se borra al
final, mismo patrón de `crearConversacionDePrueba`/
`borrarConversacionDePrueba` del script original, acá vía
`crearConversacion`/delete directo). El juez es el mismo mecanismo
(segunda llamada a `responderConFallback` sin tools) — no se
reinventó, es agnóstico de qué asistente se está evaluando.

Requiere en el entorno: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`GEMINI_API_KEY`/`GROQ_API_KEY`/`OPENROUTER_API_KEY` (según proveedor),
y `EMPRESA_ID`/`CLIENTE_ID` de prueba (un cliente real de esa empresa,
igual que `USUARIO_ID` en el script original — acá hace falta porque
`buscar_productos` resuelve precio real por cliente).

Agregado a `package.json`: `eval:whatsapp` / `eval:whatsapp:json`.

**Primera corrida real hecha (2026-09-08), solo `--provider=gemini`**
(el usuario decidió no usar Groq/OpenRouter y rotar 2 keys de Gemini
free vía `GEMINI_API_KEYS`): de los 13 casos, solo 5 llegaron a
ejecutarse antes de que las dos keys agotaran su cuota diaria — el
resto cayó en cascada por cuota agotada y circuit breaker abierto (ver
el mensaje corregido en `lib/asistente-providers.js`, sección 8). De
esos 5 con señal real: 3 pasaron (`buscar-productos-typo-01`,
`buscar-productos-coloquial-01`, y parcialmente
`agregar-item-batch-01` que se quedó sin cuota a mitad de tool), y 2
`NO_PASA` — ambos revisados a mano con el usuario (obligatorio según
la nota de la sección 2.4/cabecera del script, el juez es un primer
filtro, no un reemplazo):

- `buscar-productos-directo-01`: el juez lo rechazó por mostrar precios
  de productos sin stock, pero el `criterio_respuesta` real solo pedía
  "sin inventar precios ni marcas" — y no se inventó nada (todo salía
  de `buscar_productos`, catálogo real). Se interpretó como un criterio
  de UX real y válido para agregar (no listar precios de todo sin
  stock de una), no como un bug del bot en sí — resuelto igual, ver
  fix de prompt abajo.
- `agregar-item-simple-01`: la tool se llamó bien, pero el texto
  final ("Listo, anotado. ¿Algo más?") no nombraba el producto ni la
  cantidad agregada — esto sí incumplía el `criterio_respuesta` tal
  cual estaba escrito. Hallazgo real.

**Ambos casos derivaron en un fix de prompt** en
`armarSystemPromptWhatsApp()` (`lib/handlers/notif.js`), con OK
explícito del usuario — ver detalle completo en la sección 8. Falta
re-correr el eval completo (con cuota fresca — la de esta sesión ya
se agotó) para confirmar que el fix realmente resuelve los dos casos y
no introduce una regresión en el resto del dataset.

### 2.4 Cuándo correr esto

Igual criterio que el original: no en CI (consume cuota real). Manual
antes de tocar el system prompt de WhatsApp, el catálogo de
`whatsapp-pedido-tools.js`, o `asistente-providers.js` (que es
compartido — un cambio ahí puede afectar a los dos asistentes a la
vez, motivo de más para correr ambos evals cuando se toca ese
archivo).

## 3. Capa 3 — Loop de producción → regresión — ✅ implementada (2026-09-08)

**Estado real vs. lo que decía esta sección al escribirla** (quedaba
abajo el análisis original, sin editar, porque el razonamiento sigue
siendo correcto — es la base de lo que se implementó):

**Lo que faltaba, concretamente:**

1. `notif.js` ya recibe `resultado.proveedor` y `resultado.toolsUsadas`
   de `responderConFallback()` (ver el `console.log` de observabilidad
   agregado en 2026-08-30) pero no los persiste — solo quedan en logs
   de Vercel, no son consultables.
2. `whatsapp_mensajes`/`whatsapp_conversaciones` no tienen columnas
   equivalentes a `asistente_uso.tools_usadas` /
   `asistente_uso.proveedor_usado`.
3. Sin esas columnas, las 3 señales de `detectar-fallas-asistente.js`
   (SIN_TOOL, REPREGUNTA, FALLBACK) no se pueden calcular del lado de
   WhatsApp: REPREGUNTA sí se podría armar hoy mismo con
   `whatsapp_mensajes` + timestamps (no depende de la instrumentación
   nueva), pero SIN_TOOL y FALLBACK necesitan sí o sí lo de los puntos
   1-2.

**Acción propuesta, en orden** (dejada como quedó escrita — es lo que
efectivamente se implementó, con dos ajustes reales encontrados al
codear, anotados abajo de cada punto):

1. Migración `604_whatsapp_uso_conversacion_y_tools.sql` (era el
   siguiente número libre después de 603) — agrega
   `tools_usadas jsonb NOT NULL DEFAULT '[]'` y `proveedor_usado text`
   a `whatsapp_mensajes` (no a `whatsapp_conversaciones`, mismo
   razonamiento documentado para `asistente_uso`: es por turno, no por
   conversación). Índice por `(proveedor_usado, created_at)`, parcial
   (`WHERE proveedor_usado IS NOT NULL`) para no indexar filas
   entrantes/históricas que nunca lo van a tener.
2. `lib/handlers/notif.js` — `procesarConAsistente()` arma
   `usoAsistente = { toolsUsadas: resultado.toolsUsadas, proveedor: resultado.proveedor }`
   junto al `console.log` existente (no lo reemplaza) y se lo pasa como
   5º parámetro opcional a `responderYRegistrar()`, que lo reenvía a
   `registrarMensaje()` → `registrarMensajeWhatsapp()`. Los ~9 call
   sites restantes de `responderYRegistrar()` (avisos fijos, derivación,
   confirmación de pedido) no cambian — el parámetro queda `undefined` y
   no se manda nada, quedan con el DEFAULT de la migración.
   **Ajuste real sobre el punto 1 de esta lista** (`resultado.toolsUsadas.map(t => t.nombre)`):
   no hacía falta el `.map()` — `resultado.toolsUsadas` que devuelve
   `responderConFallback()` ya es un array de objetos `{nombre, args, ok, resultado}`
   completo (ver `lib/asistente-providers.js`), no de strings sueltos;
   se persiste tal cual en la columna `jsonb`, sin transformarlo — da
   más información util para Capa 3 que solo el nombre.
3. `scripts/detectar-fallas-asistente-whatsapp.js` — mismas 3 señales,
   contra `whatsapp_mensajes` (no hay `asistente_mensajes`/
   `asistente_uso` separados del lado de WhatsApp).
   **Ajuste real sobre este punto**: no hizo falta un diccionario de
   dominio nuevo — `TOOLS`/`palabrasSignificativas` son reusables tal
   cual (`TOOLS` se exporta desde `whatsapp-pedido-tools.js`,
   `palabrasSignificativas` desde `lib/asistente-tools.js`), la función
   de matching es genérica (nombre/descripción de cada tool vs.
   palabras del mensaje), no hardcodea vocabulario del dashboard.
   **Diferencia real de implementación no anticipada acá**: como no hay
   una fila con `pregunta` propia (a diferencia de `asistente_uso`), el
   script arma el emparejamiento mensaje-entrante → mensaje-saliente
   recorriendo `whatsapp_mensajes` ordenado por conversación y fecha, y
   se queda con el último `in` visto antes de cada `out` — un paso que
   no hacía falta del lado del dashboard.
4. Agregado a `package.json`:
   `detectar:fallas-asistente-whatsapp` / `detectar:fallas-asistente-whatsapp:json`
   (no `detectar:fallas-whatsapp` como decía el borrador de este punto —
   se ajustó el nombre para seguir el mismo patrón que ya usan los
   scripts del dashboard, `detectar:fallas-asistente`).

**No arrancar en limpio sin haber corrido esto en producción durante un
tiempo antes de confiar en las señales** — mismo motivo que ya
documenta la Capa 3 original: sin volumen no se sabe si SIN_TOOL/
REPREGUNTA/FALLBACK son útiles o ruido, y acá encima las columnas
nuevas van a estar vacías (NULL/`[]`) para todo mensaje anterior a la
migración 604 — con `--dias` grande hay que tenerlo presente antes de
confiar en el conteo.

## 4. Capa 4 — QA de "tools de escritura" — ✅ implementada (2026-09-08), con 1 hallazgo real

**El motivo por el que existe la Capa 4 original no puede reproducirse
en WhatsApp tal cual está planteado.** Esa capa audita `resumen()` de
tools con `requiereConfirmacion: true` porque ahí un texto ambiguo
puede hacer que el usuario confirme algo que no entendió. Las tools de
`whatsapp-pedido-tools.js` no tienen `resumen()` ni `requiereConfirmacion`
— por diseño explícito (ver el comentario de cabecera del archivo): el
modelo arma un borrador, nunca confirma la acción real; eso lo hace un
"sí" determinístico fuera del alcance del modelo. El bug de fondo que
motivó la Capa 4 (un `.ambiguo` devuelto con `return` en vez de `throw`,
insertado tal cual en una columna `NOT NULL`) no tiene dónde ocurrir en
esta arquitectura.

**Lo que sí es un riesgo real y equivalente en espíritu** es que el
*borrador* que arma el modelo, tool por tool, no refleje lo que
después se factura — el mismo tipo de discrepancia pero un paso antes
de la confirmación humana en vez de en el texto de confirmación. Ya
hay un FIX documentado en el propio archivo (`buscar_productos`
resolviendo precio real vía `resolver_precios_cliente` en vez de
`precio_base`, para que la cotización que ve el cliente sea la misma
que termina facturando `crearPedidoDesdeItemsWhatsapp`), lo cual
confirma que esta clase de bug ya pasó al menos una vez acá también.

**Implementado en `scripts/audit-borrador-whatsapp.js`** (auditoría
estática, sin Supabase, sin cuota, sobre `lib/whatsapp-pedido-tools.js`)
— con checks ajustados respecto al borrador original de esta sección
tras revisar el código real de las 6 tools:

- ERROR: la tool no tiene `execute()` (contrato roto).
- ERROR: `execute()` lee el borrador con `obtenerBorrador()` pero nunca
  lo persiste (ni con `guardarBorrador()` ni con un `.update()` directo
  sobre `whatsapp_conversaciones`, que es el patrón legítimo que usa
  `proponer_confirmacion` cuando solo cambia `estado` y no toca
  `items`) — el cambio se pierde en silencio y el modelo recibe la
  respuesta como si hubiera funcionado.
- WARN: una tool que busca un `producto_id` en el borrador con
  `find`/`filter` sin distinguir "no estaba" de "se sacó" — silent
  no-op.
- WARN: un total/subtotal armado con suma manual (`+`/`+=`) en vez de
  vía `calcularTotalesPedido()` — mismo invariante de "nunca sumes vos
  mismo los precios" que ya exige `armarSystemPromptWhatsApp()` al
  modelo; si el propio servidor no lo respeta tampoco hay forma de
  exigírselo de manera consistente.

**No se implementó el ERROR sobre precio real** (`buscar_productos`
resolviendo vía `resolver_precios_cliente` en vez de `precio_base`) que
proponía el borrador original de esta sección: es un chequeo específico
de una sola tool (`buscar_productos` es la única que resuelve precio),
no un patrón repetible sobre las 6 — se dejó afuera del script y queda
como ítem del checklist manual de abajo, igual que el resto de lo que
no es automatizable con regex sin generar falsos positivos.

**Hallazgo real corriendo el script sobre el código actual** (no
hipotético — confirmado con `node scripts/audit-borrador-whatsapp.js`):

- `quitar_item` filtra el borrador con
  `.filter((i) => i.producto_id !== args.producto_id)` sin comprobar
  antes si ese `producto_id` existía. Si el modelo (o el propio
  cliente, vía un `producto_id` viejo de una búsqueda anterior en la
  misma conversación) manda un `producto_id` que ya no está en el
  borrador, la tool devuelve el borrador sin cambios — sin error, sin
  ninguna señal — y el modelo puede perfectamente decirle al cliente
  "listo, lo saqué" sin que sea cierto. **Corregido (2026-09-08,
  continuación de sesión, con OK explícito del usuario)**: `quitar_item`
  ahora busca el `producto_id` antes de filtrar y lanza
  `Error('quitar_item: ese producto no está en el borrador actual')`
  si no lo encuentra — mismo criterio que ya usaba `modificar_cantidad`
  para su propio `producto_id` inexistente. Test agregado en
  `tests/handlers/whatsapp-pedido-tools.test.js` (mock de
  `whatsapp_conversaciones` que revienta si se llega a un segundo
  `.update()`/guardado, para confirmar que el early-throw corta antes
  de persistir). Suite completa vuelta a correr después del fix: 136
  archivos, 1961 tests, todo verde.

Se ajustó una vez el propio heurístico del script durante esta sesión:
la primera versión marcaba `proponer_confirmacion` como ERROR
bloqueante (falso positivo — lee el borrador pero legítimamente no
llama `guardarBorrador()`, porque solo cambia `estado` con un `.update()`
directo). Se corrigió reconociendo ese `.update()` directo sobre
`whatsapp_conversaciones` como persistencia válida — sigue detectando
el caso real si otra tool nueva reproduce el mismo patrón sin razón.

Agregado a `npm run audit:all` (corre después de
`audit-resumenes-asistente.js`).

Checklist manual (no automatizable con regex, mismo criterio que la
Capa 4 original):
- [ ] Que el precio mostrado en la conversación sea el mismo que
      termina en la factura/pedido real, no una aproximación (el ERROR
      de precio real que no se automatizó, ver arriba).
- [ ] Que `crearPedidoDesdeBorrador()` re-valide stock/precio al
      momento del "sí" del cliente, no solo cuando se armó el borrador
      (mismo patrón que ya exige la Capa 4 original para
      `anular_factura`/`emitir_factura`).
- [ ] `quitar_item` — decidir y aplicar el fix del hallazgo real de
      arriba (silent no-op con `producto_id` inexistente).

## 5. Qué NO cambia

- Los tests existentes de `tests/handlers/whatsapp-*.test.js`.
- El contrato de tools de `whatsapp-pedido-tools.js` (sin `resumen()`,
  sin `requiereConfirmacion`) — no se está proponiendo migrarlo al
  patrón del dashboard, son dos diseños válidos para dos contextos
  distintos (usuario logueado con UI de confirmación vs. cliente por
  chat con confirmación de una palabra).
- `lib/asistente-providers.js` se sigue usando compartido — cualquier
  cambio ahí impacta a los dos asistentes, así que un cambio a ese
  archivo debería correr el eval de Capa 2 de **ambos**, no solo el
  que motivó el cambio.

## 6. Orden de ejecución — estado final (2026-09-08)

1. ~~**Capa 1** — corpus de selección propio para WhatsApp~~ — no
   aplica, absorbida en la Capa 2 (ver sección 1).
2. **Capa 2** — ✅ dataset (13 casos) + `scripts/eval-asistente-whatsapp.js`
   entregados y **corridos una vez contra Gemini real** (ver sección 2.3
   para el detalle). De 5 casos con señal real, 2 `NO_PASA` — ambos
   revisados, uno derivó en fix de prompt (confirmar producto+cantidad
   en `agregar_item`) y el otro en un ajuste de UX (avisar sin-stock
   antes de listar precios). **Pendiente real**: falta re-correr el
   dataset completo con cuota fresca para confirmar el fix y cubrir los
   8 casos que no llegaron a ejecutarse por cuota agotada.
3. **Capa 3** — ✅ migración 604 **aplicada contra la base real**
   (verificado), persistencia en `notif.js`/`whatsapp-bot.js` con
   tests, y `scripts/detectar-fallas-asistente-whatsapp.js` entregado.
   **Pendiente real**: no correr el script de detección todavía — sin
   volumen post-migración las señales no dicen nada (ver nota de la
   sección 3).
4. **Capa 4** — ✅ `scripts/audit-borrador-whatsapp.js` entregado,
   corrido contra el código real. El único hallazgo (`quitar_item`) ya
   fue corregido con su test — ver sección 4. Agregado a `audit:all`.

## 7. Checklist reutilizable (por cada bug real del asistente de WhatsApp)

- [ ] ¿Fue de selección (eligió mal la tool)? → caso nuevo en
      `cobertura-seleccion-tools-whatsapp.test.js`.
- [ ] ¿Fue de calidad de respuesta (eligió bien, contestó mal)? → caso
      nuevo en `tests/handlers/evals-whatsapp/casos.json`.
- [ ] ¿Fue de cobertura (no había tool para eso)? → mismo criterio que
      `PLAN_COBERTURA_TOOLS_ASISTENTE.md`, pero contra
      `whatsapp-pedido-tools.js`.
- [ ] ¿Fue el borrador/precio mostrado distinto de lo facturado? →
      revisar checklist de la Capa 4 de este plan.

## 8. Estado final de esta sesión (2026-09-08) y qué falta antes de producción

**Implementado y verificado en esta pasada:**
- Migración `604_whatsapp_uso_conversacion_y_tools.sql` — **aplicada
  contra la base real** (`jgiquzjwoedmzwqgzubr`) con `Supabase:apply_migration`,
  con OK explícito del usuario. Verificado después con
  `information_schema.columns`: `tools_usadas jsonb NOT NULL DEFAULT
  '[]'` y `proveedor_usado text NULL` están creadas; no había conflicto
  de numeración (603 era la última migración aplicada).
- `lib/repos/whatsapp-bot.js` — `registrarMensajeWhatsapp()` con
  `tools_usadas`/`proveedor_usado` opcionales.
- `lib/handlers/notif.js` — `armarSystemPromptWhatsApp()` exportada,
  persistencia de uso del asistente en el mensaje saliente.
- `lib/whatsapp-pedido-tools.js` — **fix de `quitar_item`** (con OK
  explícito del usuario): ahora rechaza con error explícito si el
  `producto_id` no está en el borrador, en vez de hacer un silent
  no-op. Ver detalle en la sección 4.
- `lib/asistente-providers.js` — mensaje de error corregido en
  `llamarGemini()`: si todas las keys de `GEMINI_API_KEYS` ya agotaron
  su cuota dentro del mismo proceso, ahora tira
  `"Todas las keys de Gemini configuradas (N) ya agotaron su cuota en
  este proceso — no es un problema de configuración."` en vez del
  mensaje engañoso `"Sin GEMINI_API_KEYS configuradas."` (hallazgo real
  corriendo `eval-asistente-whatsapp.js` contra cuentas free — dos keys
  se agotaron a los pocos casos y el resto de la corrida mostraba un
  error que parecía de configuración sin serlo).
- `lib/handlers/notif.js` — `armarSystemPromptWhatsApp()`: dos ajustes
  de prompt con OK explícito del usuario, motivados por los dos
  `NO_PASA` reales de la primera corrida del eval contra Gemini:
  1. Después de `agregar_item`/`modificar_cantidad`, el texto de
     respuesta ahora tiene que nombrar producto + cantidad
     explícitamente (antes podía responder solo "Listo, anotado" sin
     decir qué se agregó).
  2. Ante productos sin stock, ahora primero avisa la falta de stock y
     pregunta si igual quiere ver precios/alternativas, en vez de
     listar de una las 6 variantes con precio.
  Test de regresión de texto en
  `tests/handlers/whatsapp-system-prompt.test.js` (3 casos) — no
  reemplaza el eval real (que evalúa lo que efectivamente contesta el
  modelo), solo confirma que la instrucción sigue en el prompt.
- Suite completa: **137 archivos, 1964 tests, todo verde**
  (`npx vitest run`) — corrida de nuevo después de los tres fixes de
  esta pasada.
- `tests/handlers/evals-whatsapp/casos.json` (13 casos) +
  `scripts/eval-asistente-whatsapp.js` — **sigue sin correr contra un
  proveedor real.** Se resolvieron `EMPRESA_ID` (`Distribuidora del
  Litoral S.A.`, `4462586e-e11a-4d34-a405-17103bb9cf9f`, `es_demo=true`)
  y `CLIENTE_ID` (`Fiambrería La Merced`,
  `67f371cc-bbf3-46fc-d2cc-88374fdfdf7e`, activo, sin bloquear) vía
  consulta directa a Supabase, pero el sandbox de esta sesión solo
  tiene salida de red habilitada hacia registries de paquetes (npm,
  pypi, github), no hacia las APIs de Gemini/Groq/OpenRouter — no se
  puede ejecutar el eval desde acá aunque se tengan las API keys.
  Comando listo para correr en un entorno con esa salida de red
  habilitada:
  `EMPRESA_ID=4462586e-e11a-4d34-a405-17103bb9cf9f CLIENTE_ID=67f371cc-bbf3-46fc-d2cc-88374fdfdf7e npm run eval:asistente-whatsapp`
- `scripts/detectar-fallas-asistente-whatsapp.js` (falla limpio sin
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, verificado).
- `scripts/audit-borrador-whatsapp.js` — corrido contra el código real:
  1 hallazgo (`quitar_item`), ya corregido esta pasada (ver sección 4).
- `package.json` — 8 scripts nuevos (`eval:asistente-whatsapp[:json]`,
  `detectar:fallas-asistente-whatsapp[:json]`,
  `audit:borrador-whatsapp[:json]`, y sumado a `audit:all`).

**Pendiente real, en orden de qué desbloquea qué:**
1. Correr `eval-asistente-whatsapp.js` contra un proveedor real al
   menos una vez (desde un entorno con salida de red a Gemini/Groq/
   OpenRouter), con los IDs ya resueltos arriba, para saber si el
   dataset de 13 casos realmente pasa o hace falta ajustar
   `criterio_respuesta`/prompts.
2. Dejar `detectar-fallas-asistente-whatsapp.js` corriendo (a mano o en
   un cron) ahora que la migración 604 ya está aplicada — todavía sin
   volumen post-migración, así que las primeras corridas van a tener
   poca señal hasta que se acumulen mensajes salientes nuevos.
