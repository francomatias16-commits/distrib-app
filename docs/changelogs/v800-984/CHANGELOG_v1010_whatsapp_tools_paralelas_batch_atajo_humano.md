# v1010 — Asistente de pedidos por WhatsApp: function calling paralelo en Gemini, batch en `agregar_item`, atajo determinístico para pedir un humano, UUID crudo al cliente, `modificar_cantidad` (2026-08-30)

Mejoras encadenadas sobre el motor de pedidos por WhatsApp
(`lib/asistente-providers.js`, `lib/whatsapp-pedido-tools.js`,
`lib/handlers/notif.js`), priorizadas por impacto/riesgo. Se deja
explícitamente afuera de esta entrega el caching de Gemini.

Los puntos 4 y 5 salen de un caso real reportado por un cliente vía
WhatsApp (captura de pantalla): el bot le mostró un UUID interno en vez de
un nombre de producto, y quedó sin poder tomarle un pedido nuevo porque la
conversación había quedado derivada a un humano tras no poder resolver una
respuesta ambigua ("Seguro") a una pregunta compuesta sobre reducir stock.

## 1. Bug: Gemini con function calling paralelo perdía funciones (riesgo de estado inconsistente)

- **`lib/asistente-providers.js` (`llamarGemini`)**: Gemini puede pedir
  varias funciones en la MISMA vuelta (ej. "dame 2 coca y 3 harina" →
  dos llamados a `buscar_productos` en un solo turno). El código leía solo
  la primera (`partes.find(...)`) y descartaba el resto en silencio: el
  `contents` que se mandaba de vuelta quedaba desalineado con lo que el
  modelo realmente pidió (le llegaba un `functionResponse` de una sola
  función cuando había pedido dos), con riesgo de dejar el borrador o la
  conversación en un estado inconsistente, no solo una vuelta de más.
- **Fix**: se juntan TODAS las `functionCall` de la vuelta
  (`partes.filter(...)`) y se ejecutan en orden (no con `Promise.all`,
  a propósito: dos tools de escritura sobre el mismo borrador —
  `agregar_item`, `quitar_item` — hacen leer-modificar-guardar sobre la
  misma fila de `whatsapp_conversaciones`, y correrlas en simultáneo
  arriesgaría que la segunda pise el resultado de la primera). El turno del
  modelo entra al historial como UN mensaje con todas sus `parts`, seguido
  de UN mensaje con el `functionResponse` de cada una en el mismo orden.
- De paso (observabilidad, sin relación con el bug): Gemini, Groq y
  OpenRouter ahora acumulan `usageMetadata`/`usage` de cada response
  (`tokens: { prompt, completion, total }` en el resultado de
  `responderConFallback`) — antes ningún proveedor reportaba consumo, así
  que cualquier ajuste de `maxOutputTokens`/tamaño de historial se hacía a
  ciegas.

## 2. Batch en `agregar_item` (menos vueltas por pedido con varios productos)

- **`lib/whatsapp-pedido-tools.js` (`agregar_item`)**: antes la tool
  aceptaba UN producto por llamado — un pedido de N productos distintos
  gastaba N vueltas de ida y vuelta al modelo (cada una con su propio
  round-trip de red y el historial/tools reenviados de nuevo), sumando
  latencia percibida por el cliente esperando en WhatsApp.
- **Fix**: ahora acepta un array `items` y aplica todos los ítems sobre el
  MISMO borrador, leído una sola vez, en una sola tool call. Se actualizó
  la `description` de la tool para instruirle al modelo mandar todos los
  productos de un mismo mensaje del cliente juntos en un solo llamado.
  Defensivo: si un modelo (sobre todo los gratuitos de Groq/OpenRouter,
  menos disciplinados con schemas nuevos) todavía manda el shape viejo
  (`producto_id`/`nombre`/`cantidad`/`precio` sueltos, sin envolver en
  `items`), se lo toma igual como un array de un solo elemento en vez de
  fallar la tool call entera.
- `lib/handlers/notif.js`: el system prompt del bot ahora incluye la misma
  instrucción (buscar cada producto y después agregarlos todos juntos en
  un solo llamado a `agregar_item`).

## 3. Ajustes chicos

- **`lib/handlers/notif.js` — atajo por palabra clave para pedir un
  humano**: hasta ahora la única vía de derivación por pedido explícito
  del cliente era que el LLM interpretara el mensaje y llamara a la tool
  `derivar_humano`. Punto flojo: si el proveedor de turno cae al fallback
  sin tools (`systemPromptSinTools`) o los tres proveedores están caídos,
  el texto de respuesta le decía al cliente "te paso con un vendedor" pero
  la tool nunca se ejecutaba — la conversación no quedaba en
  `derivada_humano` y no se mandaba push, así que nadie se enteraba hasta
  mirar el panel a mano. Se agrega `REGEX_HABLAR_HUMANO`
  (`/\b(hablar|comunicarme|conectarme|pasame|pásame)\s+con\s+(un[a]?\s+)?(persona|alguien|vendedor|operador|humano|encargado)\b/i`):
  un atajo determinístico que corre ANTES de tocar el LLM, así el resultado
  no depende de qué proveedor esté respondiendo ni de si tiene tools
  disponibles. Se chequea antes que `esperando_confirmacion` a propósito:
  si el cliente pide un humano en medio de una confirmación pendiente, gana
  el pedido de derivación, no el borrador que estaba por confirmarse. No
  reemplaza a `derivar_humano` (sigue cubriendo los casos ambiguos que el
  modelo detecta pero que no matchean ninguna palabra clave fija) — es una
  red de seguridad para el caso más común y explícito.
- **`lib/asistente-providers.js` — `maxTokens` parametrizable**: el límite
  de `maxOutputTokens`/`max_tokens` estaba fijo en cada adaptador (2048
  para Gemini, 800 para Groq/OpenRouter), pensado para el asistente de
  ayuda del admin (diagnósticos largos). Ese mismo adaptador lo usa también
  el bot de pedidos por WhatsApp, donde el propio system prompt le pide
  respuestas "breves, es un chat, no un email" — el margen viejo ahí era
  puro desperdicio de latencia si el modelo se extendía de más. Ahora
  `responderConFallback` acepta un `maxTokens` opcional que se propaga a
  los 3 adaptadores; si no se manda nada, se mantienen los valores de
  siempre (no afecta al asistente de admin).
  - **Wiring** (`lib/handlers/notif.js`, `procesarConAsistente`): el
    parámetro existía desde el punto anterior pero nadie lo estaba
    pasando — `notif.js` seguía llamando a `responderConFallback` sin
    `maxTokens`, así que el bot de WhatsApp seguía usando el límite del
    asistente de admin. Se agrega `MAX_TOKENS_RESPUESTA_WHATSAPP = 300` y
    se manda en el llamado — una respuesta típica del bot es un resumen de
    2-3 líneas o un pedido de confirmación, nunca un texto largo.
- **Log de consumo de tokens** (`lib/handlers/notif.js`,
  `procesarConAsistente`): el punto anterior había agregado el tracking de
  `tokens`/`usage` en los 3 adaptadores, pero `responderConFallback` lo
  devolvía sin que nada lo leyera. Se agrega un `console.log` con
  `proveedor` + `tokens.{prompt,completion,total}` + `conversacionId` en
  cada respuesta del bot — no hay todavía tabla ni dashboard para esto, es
  solo para poder grepear logs de Vercel si hace falta ajustar
  `MAX_TOKENS_RESPUESTA_WHATSAPP` o diagnosticar consumo alto en una
  empresa puntual.

## 4. Bug: UUID crudo llegaba al chat del cliente (condición de carrera de stock)

- **`lib/handlers/notif.js` (`crearPedidoDesdeItemsWhatsapp`)**: hay un
  pre-chequeo de stock en JS (resuelve nombre, mensaje `stock insuficiente
  para "<nombre>"`) ANTES de llamar a la RPC `crear_pedido_cliente`, pero
  esa misma RPC hace un segundo chequeo ATÓMICO justo al reservar — red de
  seguridad contra que el stock haya cambiado entre el pre-chequeo y la
  reserva real. Ese chequeo de la RPC es deliberadamente bare-bones
  (`'Stock insuficiente para producto ' || producto_id`, sin nombre) porque
  en el resto de la app casi nunca se llega a esa rama gracias al
  pre-chequeo. En este caso real SÍ se llegó (condición de carrera real en
  producción) y el `rpcResult.error` con el UUID crudo se pasaba
  directo al cliente por WhatsApp sin resolver.
- **Fix**: se agrega `resolverNombreEnErrorStock()`, que busca el patrón
  `producto <uuid>` en el mensaje de la RPC y lo reemplaza por
  `"<nombre>"` usando el mismo `items[].nombre` que ya viaja en el
  borrador — mismo estilo que el pre-chequeo de JS. Si el `producto_id` del
  error no está en `items` (no debería pasar, pero por las dudas), se deja
  el mensaje original intacto — nunca peor que antes.

## 5. Nueva tool `modificar_cantidad` (fijar cantidad exacta, no sumar)

- **`lib/whatsapp-pedido-tools.js`**: antes, "dejar en N unidades" un
  producto ya agregado al borrador requería que el modelo encadenara
  `quitar_item` + `agregar_item` (que SUMA, no reemplaza) — sin una tool
  directa para esto, el modelo no siempre lo resolvía bien ante una
  respuesta ambigua del cliente después de un "stock insuficiente" (caso
  real: el bot preguntó "¿sacamos unidades o lo quitamos?", el cliente
  contestó "Seguro"/"Si" sin especificar una acción concreta, y tras 2-3
  idas y vueltas sin poder resolverlo terminó derivando a un vendedor).
- **Fix**: se agrega `modificar_cantidad(producto_id, cantidad)`, que fija
  la cantidad final de un ítem YA existente en el borrador en un solo
  llamado (si la cantidad nueva es 0 o menor, quita el ítem — mismo
  resultado que `quitar_item`). Se actualiza el system prompt
  (`lib/handlers/notif.js`) para instruir al modelo a usarla ante pedidos
  de reducción de cantidad, y a preguntar explícitamente la cantidad si el
  cliente no la especificó (en vez de asumir un número).
- Esto no soluciona por sí solo el caso puntual de la captura (ese cliente
  nunca llegó a decir un número), pero le da al modelo la herramienta
  correcta para cuando sí lo haga, reduciendo la chance de terminar
  derivando por esta causa.

## 6. Derivación por ambigüedad: se saca el criterio de "N idas y vueltas"

- **`lib/whatsapp-pedido-tools.js` (`derivar_humano`)**: el criterio de
  "cuándo derivar por no lograr identificar qué quiere el cliente" no es un
  contador en código — es una instrucción en texto libre dentro de la
  `description` de la tool, que el modelo interpreta a su criterio. Estaba
  en "2-3 idas y vueltas", un margen corto que en el caso real de la
  captura (cliente respondiendo "Si"/"Seguro" sin un número concreto)
  derivó antes de que el bot llegara a insistir con la pregunta de otra
  forma.
- Se probó primero subirlo a "5-6", pero cualquier número fijo tiene el
  mismo problema de fondo en menor escala: sigue habiendo un punto en el
  que el bot deriva por cansancio en vez de seguir intentando resolver la
  ambigüedad.
- **Fix final**: se elimina el criterio de cantidad del todo.
  `derivar_humano` ahora deriva SOLO por motivo (el cliente pide
  explícitamente hablar con una persona, o el pedido es demasiado ambiguo
  para resolverlo por chat — precios especiales, reclamos, algo fuera de
  un pedido simple), nunca por cantidad de mensajes. Se agrega una
  instrucción explícita de reformular la pregunta o pedir el dato concreto
  que falta las veces que haga falta, en vez de derivar por no haber
  llegado a una respuesta clara en pocos intentos.
- El corte duro por costo (`MAX_TURNOS_SIN_CONFIRMAR = 20` en
  `lib/handlers/notif.js`) no se tocó y sigue siendo la única red de
  seguridad contra loops largos — es independiente de este criterio (no
  depende de que el modelo decida derivar, corta solo por cantidad de
  mensajes entrantes en la ronda), así que sacar el criterio de ambigüedad
  no deja el flujo sin protección contra un cliente que nunca se resuelve.
- Sin test dedicado: es un cambio de texto de prompt, no de lógica
  determinística — no hay una entrada/salida verificable sin mockear el
  criterio del LLM. Cubierto por revisión manual del texto y por la suite
  existente de `derivar_humano` (ejecución de la tool en sí, sin tocar).

## 7. Corte duro por costo: `MAX_TURNOS_SIN_CONFIRMAR` subido de 20 a 50

- **`lib/handlers/notif.js`**: con el punto 6 (se eliminó el criterio de
  "N idas y vueltas" de `derivar_humano`), este corte defensivo pasó a ser
  el ÚNICO freno del flujo — antes convivía con el criterio textual del
  modelo, que en la práctica solía derivar primero. Con 20 mensajes por
  ronda como único límite, una conversación legítima con varios productos
  y ajustes (agregar, sacar, cambiar cantidades) podía acercarse al tope
  sin ser realmente un loop sin salida.
- **Fix**: se sube a 50. Sigue siendo un corte defensivo real — protege
  contra el caso patológico de un cliente que nunca se resuelve y el bot
  gastando tokens de IA sin fin — pero le da mucho más margen a una
  conversación normal antes de derivar por esta causa.
- **Test actualizado**: `tests/handlers/whatsapp-motor-conversacion.test.js`
  — el mock de conteo de turnos pasa de `21` (>20) a `51` (>50) para seguir
  probando el corte con el umbral nuevo.

## 8. Bug real: conversación derivada bloqueaba mensajes nuevos PARA SIEMPRE

- **Hallazgo**: reportado como "sigue derivando" sobre una conversación que
  se había cortado el día anterior. La causa no tenía nada que ver con los
  puntos 6/7 (ese motivo de derivación era `'Cliente dejó de responder sin
  confirmar el pedido'`, puesto por un cron de Postgres — migración 437,
  `whatsapp_avisar_conversaciones_estancadas`, no por `derivar_humano` ni
  por `MAX_TURNOS_SIN_CONFIRMAR`).
- **Bug real**: `marcarConversacionDerivada` está documentada como
  "el bot deja de intervenir hasta que alguien la libere desde el panel
  admin", pero esa acción no existe — el panel
  (`whatsapp-conversacion-accion`, botones "Tomar"/"Liberar") solo asigna
  `tomada_por` entre vendedores, nunca vuelve a tocar `estado`. Y
  `resolverConversacionWhatsapp` reusa cualquier conversación que no esté
  `'cerrada'`, sin importar cuánto tiempo pasó — así que una conversación
  derivada y nunca tomada por nadie bloqueaba CUALQUIER mensaje futuro de
  ese cliente para siempre (aunque escribiera "Quiero hacer un pedido" al
  día siguiente, seguía cayendo en el mensaje enlatado de espera).
- **Fix**:
  - `lib/repos/whatsapp-bot.js` — `buscarConversacionAbiertaIdPorEmpresa`
    ahora trae también `estado`/`tomada_por`/`ultima_interaccion` (antes
    solo `id`). Se agrega `cerrarConversacionPorExpiracion()`.
  - `lib/handlers/notif.js` — nueva constante
    `UMBRAL_CONVERSACION_DERIVADA_EXPIRA_HORAS = 12`.
    `resolverConversacionWhatsapp` ahora chequea: si la conversación
    existente está `'derivada_humano'`, nadie la tomó (`tomada_por` nulo) y
    pasaron más de 12hs desde el último mensaje, la cierra y crea una
    conversación nueva en vez de reusarla. Si un vendedor SÍ la tomó, nunca
    se auto-cierra por acá — no le pisa la charla a quien la esté
    atendiendo a mano.
  - Nota: esto es un fix de flujo, complementario a los puntos 6 y 7 (que
    tocan CUÁNDO se deriva) — este resuelve QUÉ pasa después, cuando una
    derivación queda sin atender.
- **Test**: `tests/handlers/whatsapp-motor-conversacion.test.js` — tres
  casos nuevos: cierra y arranca de cero si la conversación derivada es
  vieja (>12hs) y sin tomar; NO la cierra si un vendedor la tomó aunque sea
  vieja; NO la cierra si todavía está dentro del umbral.
- **Producción**: se cerraron manualmente (vía Supabase) las 6
  conversaciones que en ese momento estaban `derivada_humano` sin
  `tomada_por` en la base — quedan disponibles para arrancar limpias en el
  próximo mensaje del cliente, sin esperar al próximo deploy.
- **Suite completa: 1232/1232** (77/77 archivos).

## Fuera de alcance (a propósito)

- Caching de respuestas/tools de Gemini — queda para una entrega aparte.
- Dentro de una misma vuelta, las tools se siguen ejecutando en serie
  aunque no todas necesiten serializarse — `buscar_productos` es de solo
  lectura y dos llamados en la misma vuelta podrían ir en paralelo sin el
  riesgo de leer-modificar-guardar que sí aplica a `agregar_item`/
  `quitar_item`. No se tocó en esta entrega.

## Tests

- **`tests/handlers/whatsapp-pedido-tools.test.js`**: se agregan casos para
  el batch de `agregar_item` — varios productos en un solo llamado
  (incluyendo uno que ya estaba en el borrador), dos veces el mismo
  `producto_id` en el mismo batch, fallback al shape viejo (`producto_id`
  suelto), y rechazo si no viene ningún producto. Además, cobertura de
  `modificar_cantidad`: fija cantidad exacta, quita el ítem si la cantidad
  es 0 o menor, no toca otros productos del borrador, rechaza si el
  producto no está en el borrador.
- **`tests/handlers/whatsapp-motor-conversacion.test.js`**: se agrega
  cobertura para `REGEX_HABLAR_HUMANO` — deriva sin pasar por el LLM ante
  un pedido explícito de hablar con una persona, y gana por sobre un
  borrador en `esperando_confirmacion` (se deriva en vez de intentar
  confirmar el pedido).
- **`tests/handlers/whatsapp-pedido-borrador.test.js`**: se agregan dos
  casos para `resolverNombreEnErrorStock` — resuelve el UUID a nombre
  cuando la RPC devuelve el error crudo de stock, y deja el mensaje
  intacto si el `producto_id` del error no está en `items`.
  - **Fix de test preexistente, de paso**: este archivo tenía 11 tests
    fallando desde antes de esta entrega — `resolverDepositoParaPedido`
    (multi-depósito, v550) se sumó al flujo después de escrito este
    archivo, y sin mockear `from('depositos')` cualquier test que llegara
    a ese punto reventaba antes de probar lo que en realidad quería
    probar. Se agrega `depositos: { data: { id: 'deposito-1' }, error:
    null }` al `beforeEach` — no toca código de producción, solo
    destrababa la suite de test para poder agregar los casos nuevos de
    este changelog.
- No se agregó test unitario dedicado para el function calling paralelo de
  Gemini (`llamarGemini`) — el archivo `lib/asistente-providers.js` no
  tiene suite propia todavía (llama a `fetch` real contra las APIs de los
  3 proveedores); queda pendiente si se decide armarla con un mock de
  `fetch`.
- **Suite completa: 1229/1229** (77/77 archivos) — sin fallas, incluida la
  que era preexistente.
