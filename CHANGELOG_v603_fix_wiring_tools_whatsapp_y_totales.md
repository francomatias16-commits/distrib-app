# v603 — Fix crítico: el bot de pedidos por WhatsApp nunca tenía tools ni catálogo real + devolución de precios/total

## Motivo (auditoría 2026-08-03)

Se probó el flujo real en producción (conversación de WhatsApp + `whatsapp_conversaciones`/
`whatsapp_mensajes` en Supabase) y se encontraron dos problemas independientes:

1. **Bug de wiring, bloqueante**: `procesarConAsistente()` en `lib/handlers/notif.js` llamaba a
   `responderConFallback({ systemPrompt, tools: { esquema, ejecutar } })`, pero
   `responderConFallback` (en `lib/asistente-providers.js`) espera
   `{ systemPromptConTools, systemPromptSinTools, tools: { esquemaGemini, esquemaOpenAI, ejecutar } }`
   — mismo contrato que ya usa correctamente `handlers/asistente.js` para el asistente del admin.
   Por el desajuste de nombres, **ningún proveedor (Gemini/Groq/OpenRouter) recibía nunca las
   instrucciones reales ni las tools** (`buscar_productos`, `agregar_item`, `quitar_item`,
   `proponer_confirmacion`, `derivar_humano`). El modelo respondía "a ciegas": sin catálogo, sin
   precios, inventando un flujo genérico (pedía dirección de entrega y método de pago, ninguno de
   los cuales existe en el pedido real) y nunca tocaba el `pedido_borrador`.
   - Verificado en Supabase: la única conversación real de prueba terminó en
     `estado = 'derivada_humano'` con `pedido_borrador = {"items": []}`, y `pedidos` no tiene
     **ningún** registro con `canal = 'whatsapp'` en toda la base.

2. **Precio mostrado ≠ precio cobrado**: `buscar_productos` devolvía siempre `precio_base` (lista
   general), mientras que `crearPedidoDesdeItemsWhatsapp` resuelve el precio real del cliente vía
   `resolver_precios_cliente` (RPC) al confirmar. Un cliente con precio diferenciado podía ver un
   número en el chat distinto al que terminaba facturado.

3. El total mostrado antes de confirmar dependía de que el LLM lo sumara a mano ("total
   aproximado"), y el mensaje final de confirmación no incluía ningún monto.

## Cambios

- **`lib/whatsapp-pedido-tools.js`**
  - `buscar_productos` ahora resuelve el precio real por cliente con `resolverPreciosClienteRpc`
    (mismo RPC que usa la confirmación), con fallback a `precio_base` si la RPC falla o no hay
    `clienteId`.
  - `proponer_confirmacion` ahora calcula `subtotal`/`iva_total`/`total` server-side con
    `calcularTotalesPedido` (la misma función pura que usa `crearPedidoDesdeItemsWhatsapp` al
    confirmar en firme) y los devuelve junto al borrador — el modelo ya no inventa ni suma el
    total a mano.
  - Se agregan `esquemaPedidoWhatsAppGemini()` y `esquemaPedidoWhatsAppOpenAI()` (reemplazan al
    único `esquemaPedidoWhatsApp()`), con el mismo formato por proveedor que ya usa
    `asistente-tools.js` (`esquemaParaGemini`/`esquemaParaOpenAI`).
  - `ejecutarToolPedidoWhatsApp` ahora también recibe `clienteId` y lo pasa a los `execute()`.

- **`lib/handlers/notif.js`**
  - `procesarConAsistente()`: se separa `systemPrompt` en `systemPromptConTools` /
    `systemPromptSinTools`, se arma `tools.esquemaGemini`/`tools.esquemaOpenAI` (en vez de
    `tools.esquema`), y se llama a `responderConFallback` con los nombres correctos.
  - El `systemPromptConTools` ahora aclara explícitamente: nunca sumar precios a mano, repetir tal
    cual el subtotal/IVA/total que devuelve `proponer_confirmacion`, y nunca pedir datos que el
    flujo no usa (dirección, método de pago).
  - `crearPedidoDesdeItemsWhatsapp` ahora devuelve también `total` en el resultado.
  - `confirmarPedidoWhatsapp`: el mensaje final de confirmación ahora incluye el total
    (`¡Pedido confirmado! Número X. Total: $Y. Te avisamos cuando esté en camino.`).

## Tests

- `tests/handlers/whatsapp-pedido-tools.test.js`: se actualiza el test de `proponer_confirmacion`
  para cubrir el cálculo de `subtotal`/`iva_total`/`total`.
- `tests/handlers/whatsapp-pedido-borrador.test.js`: se actualiza el test de camino feliz para
  esperar el nuevo campo `total` en el resultado.
- Suite completa (`npx vitest run`) corrida localmente: sin regresiones nuevas — las 39 fallas
  preexistentes en `*-permisos.test.js` son por falta de `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
  en este entorno de pruebas, no relacionadas a este cambio (no tocan `notif.js` ni
  `whatsapp-pedido-tools.js`).

## Pendiente / a validar con un pedido de prueba real

Con el fix aplicado, conviene repetir la prueba real por WhatsApp (ej. "quiero dos azúcar y una
harina") y confirmar en Supabase que: (a) el bot use `buscar_productos`/`agregar_item` de verdad,
(b) `proponer_confirmacion` devuelva un total, (c) al confirmar con "SÍ" se cree una fila en
`pedidos` con `canal = 'whatsapp'`.
