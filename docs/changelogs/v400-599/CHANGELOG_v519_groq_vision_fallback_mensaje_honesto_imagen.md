# v519 — Groq como segunda opción de visión + mensaje honesto para fallos de imagen

## Pedido

Reportado con captura real: al adjuntar una imagen (nota de pedido) el
asistente respondió con el mensaje genérico ("No se pudo generar una
respuesta en este momento. Probá de nuevo en unos segundos.") en vez del
mensaje específico para imagen que ya existía en el código. Además, CLAY
preguntó directamente si se puede sumar otra API de visión para no
depender solo de la cuota de Gemini.

## Diagnóstico

1. **Bug de mensaje**: `responderConFallback()` tira un mensaje DISTINTO
   cuando falla con una imagen adjunta (`No se pudo leer la imagen...`),
   pero el `catch` de `lib/handlers/asistente.js` solo tenía un regex para
   `Los 3 proveedores fallaron` (el caso sin imagen, del v516). El caso de
   imagen no matcheaba ese regex y caía siempre en el mensaje más genérico
   — exactamente lo que se vio en la captura.
2. **Solo Gemini tenía visión**: `PROVEEDORES_CON_VISION` (asistente-
   providers.js) tenía únicamente `'gemini'`. Si Gemini se quedaba sin
   cuota, no había ningún fallback real para imágenes — a diferencia del
   texto, que ya tiene 3 proveedores en cadena.
3. Se confirmó (Groq docs + fuentes externas) que Groq tiene un modelo con
   visión real: `meta-llama/llama-4-scout-17b-16e-instruct` — multimodal
   nativo, tool calling + visión soportados juntos, hasta 20MB por imagen.
   Groq lo marca como "Preview" (no su línea estable), por eso entra como
   SEGUNDO intento, nunca reemplazando a Gemini.

## Cambios

### `lib/handlers/asistente.js`

- Se agrega `esFalloDeImagen` (regex sobre `No se pudo leer la imagen`) al
  lado de `esFalloDeLos3Proveedores`, con su propio mensaje honesto:
  "No se pudo leer la imagen en este momento (ninguno de los proveedores
  con soporte de imágenes pudo procesarla). Probá de nuevo en un rato, con
  una foto más chica/nítida, o cargá el pedido a mano mientras tanto."
  (No asume que la causa es cuota, a propósito: ahora hay 2 proveedores de
  visión, puede fallar por otras razones — tamaño de imagen, timeout, etc.)

### `lib/asistente-providers.js`

- `CONFIG.groq`: nuevo campo `modeloVision` (default
  `meta-llama/llama-4-scout-17b-16e-instruct`, override por
  `GROQ_VISION_MODEL`). El modelo de texto normal
  (`llama-3.3-70b-versatile`) NO tiene visión — nunca se le manda una
  imagen a ese modelo.
- `llamarChatCompletionsConTools()`: acepta `imagen` opcional. Si viene,
  arma el turno del usuario en formato multimodal (`[{type:'text',...},
  {type:'image_url', image_url:{url:'data:mime;base64,...'}}]`, formato
  Chat Completions estándar) en vez de un string plano. Igual que Gemini,
  la imagen SOLO va en el turno actual, nunca se reinyecta en el
  historial viejo.
- `llamarGroq()`: acepta `imagen`, y si está presente usa
  `CONFIG.groq.modeloVision` en vez de `CONFIG.groq.modelo`.
- `PROVEEDORES_CON_VISION`: ahora `Set(['gemini', 'groq'])`. OpenRouter
  queda afuera a propósito — el router `openrouter/free` no garantiza qué
  modelo puntual responde en cada request, así que no hay forma de
  asegurar que tenga visión ese día.

## Cómo queda la cadena de fallback con imagen adjunta

1. Gemini (`gemini-2.5-flash`) — como antes, primer intento.
2. **Nuevo**: Groq (`llama-4-scout-17b-16e-instruct`) — si Gemini no
   respondió (sin cuota, timeout, etc.).
3. Si ambos fallan, mensaje honesto específico de imagen (ver arriba), no
   el genérico.

## Riesgo conocido, sin resolver acá

Groq marca `llama-4-scout` como "Preview" — no es su línea de producción
estable. Puede tener más variabilidad de calidad/disponibilidad que
`llama-3.3-70b-versatile` (texto). Se decidió aceptar ese riesgo porque
entra solo como SEGUNDO intento (nunca reemplaza a Gemini como primera
opción), pero vale la pena revisar cómo se comporta en la práctica antes
de confiar en él para casos críticos.

## Archivos modificados

- `lib/handlers/asistente.js`
- `lib/asistente-providers.js`
