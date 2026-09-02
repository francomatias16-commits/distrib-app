# v522 — Groq filtraba su razonamiento interno (`<think>`) al chat

## Reportado

Captura + texto real (usuario probando el fallback de imagen tras el
v521): el asistente devolvió, tal cual, la cadena de pensamiento interna
del modelo en inglés (varios párrafos analizando la imagen y decidiendo
qué tool llamar) seguida de una frase final pobre en español ("He
interpretado la imagen como un pedido nuevo"), sin mostrar los datos del
pedido que sí había extraído correctamente.

## Diagnóstico

`qwen/qwen3.6-27b` (visión, desde v520) y `openai/gpt-oss-120b` (texto,
desde v520) son modelos "razonadores" del lado de Groq: por diseño,
devuelven su proceso de pensamiento envuelto en tags
`<think>...</think>` dentro del mismo `message.content`, salvo que se les
pida explícitamente lo contrario. El código nunca mandó el parámetro que
controla esto, así que Groq usó su comportamiento por defecto (razonamiento
mezclado en el texto) — confirmado en la documentación oficial de Groq
(`console.groq.com/docs/reasoning`, `reasoning_format`).

Efecto secundario del v521 (sacar tools de los requests con imagen): el
modelo "pensaba en voz alta" que quería llamar a `crear_pedido`, pero
como no había ninguna tool declarada en ese request no podía — de ahí que
la respuesta final terminara siendo tan pobre en vez de mostrar el pedido
transcripto.

## Cambios

### `lib/asistente-providers.js`

- `llamarChatCompletionsConTools()`: nuevo parámetro `extraBody`, mezclado
  en el `body` de ambos requests (con tools y el de respuesta final) para
  poder pasar opciones específicas de un proveedor sin tocar la firma
  general de la función.
- `llamarGroq()`: manda `extraBody: { reasoning_format: 'hidden' }` en
  todas sus llamadas (texto y visión) — le pide a Groq que devuelva SOLO
  la respuesta final, sin el razonamiento interno. No se aplica a
  OpenRouter: el router `openrouter/free` elige un modelo distinto en
  cada request y no todos van a reconocer este parámetro específico de
  Groq.
- Nueva función `limpiarRazonamiento()`: red de seguridad además de
  `reasoning_format: 'hidden'`. Hay reportes de la propia comunidad de
  Groq de modelos que igual dejan pasar texto de razonamiento suelto en
  algunos casos (bug conocido con gpt-oss-120b). Esta función saca
  cualquier bloque `<think>...</think>` —completo o sin cerrar, por si la
  respuesta se corta a mitad del pensamiento— antes de que el texto llegue
  al usuario. Se aplica en los dos puntos donde `llamarChatCompletionsConTools`
  devuelve texto final. Es un no-op inofensivo para Gemini/OpenRouter.

## Efecto colateral aceptado

Si una respuesta queda compuesta ÚNICAMENTE de un bloque `<think>` sin
texto final después (el modelo se quedó sin tokens de salida a mitad de
su razonamiento), `limpiarRazonamiento()` la deja vacía y el código la
trata como "Respuesta vacía o inesperada" — cae al siguiente proveedor de
la cadena en vez de mostrar un dump crudo de pensamiento. Se considera
preferible a exponer texto de razonamiento sin filtrar.

## Riesgo conocido, sin resolver acá

Con imagen adjunta, Groq sigue sin tools (v521) — aunque ahora ya no
"anuncia" en texto que quería usar una tool, el problema de fondo (no
puede consultar datos en vivo en el mismo request que lee la imagen)
sigue igual. Si en el futuro se necesita ese caso de uso, hay que
revisar el presupuesto de TPM de `qwen/qwen3.6-27b` con más cuidado en
vez de sacar las tools por completo.

## Archivos modificados

- `lib/asistente-providers.js`
