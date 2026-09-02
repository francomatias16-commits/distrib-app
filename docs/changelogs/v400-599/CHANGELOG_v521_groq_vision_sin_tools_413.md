# v521 — Sacar el catálogo de tools cuando hay imagen adjunta (413 en Groq visión)

## Reportado

Captura real (Marina Torres, admin): al adjuntar la foto de un pedido, el
asistente volvió a responder con el mensaje honesto de fallo de imagen del
v519 ("No se pudo leer la imagen en este momento..."). A simple vista
parecía el mismo bug del v519/v520, pero **no lo era** — el fix del v520
ya estaba en producción (confirmado por logs: el error ya no menciona
`llama-4-scout`, sino `qwen/qwen3.6-27b`).

## Diagnóstico (logs reales de Vercel, `get_runtime_errors`)

Cadena de fallos de ese request puntual:

1. **Gemini**: HTTP 429, cuota agotada (sin cambios, problema conocido).
2. **Groq (visión, `qwen/qwen3.6-27b`)**: HTTP 413 "Request too large" —
   `Limit 8000, Requested 9704` tokens por minuto (TPM).

La causa del 413: `llamarChatCompletionsConTools()` arma el `body.tools`
con el catálogo completo seleccionado por rol/pregunta (hasta 20 tools,
~4.000-5.000 tokens según el v518) **sin importar si venía una imagen
adjunta**. Sumado a la imagen en base64, el pedido total se pasaba del
límite de 8.000 TPM que Groq le puso a `qwen/qwen3.6-27b` en el free tier.

## Cambio

### `lib/asistente-providers.js`

- `llamarChatCompletionsConTools()`: `toolsOpenAI` ahora es `undefined`
  siempre que venga `imagen`, sin importar lo que traiga `tools`. Leer una
  foto de un pedido/remito es una tarea de una sola vuelta (transcribir lo
  que se ve); no necesita consultar stock/clientes en ese mismo request.
  Si el usuario necesita ese dato después de que el asistente le
  transcribió la imagen, lo pregunta en un mensaje de texto siguiente —
  ahí las tools sí van completas (como siempre).
- Gemini (`llamarGemini`) queda sin cambios: su falla en este caso fue por
  cuota (429), no por tamaño, y su límite de tokens es mucho más generoso
  que el de Groq — no hay motivo para sacarle las tools con imagen.

## Cómo queda la cadena con imagen adjunta después de este fix

1. Gemini — como siempre, con tools completas (si tiene cuota).
2. Groq (`qwen/qwen3.6-27b`) — SIN tools, solo lee/transcribe la imagen.
3. Si ambos fallan, mensaje honesto de imagen (sin cambios, v519).

## Riesgo conocido, sin resolver acá

Si en el futuro una pregunta con imagen SÍ necesita datos en vivo (ej.
"esta foto de pedido, ¿el cliente tiene cuenta corriente al día?"), Groq
ya no va a poder resolverlo en la misma vuelta — el usuario va a tener que
repreguntar en texto. Se aceptó ese trade-off porque el caso de uso
principal de la imagen (transcribir un pedido en papel/WhatsApp) no lo
necesita, y es mejor que el request falle por completo con un 413.

## Archivos modificados

- `lib/asistente-providers.js`
