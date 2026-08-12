# v502 — Asistente: `crear_presupuesto` + interpretar texto largo/imágenes (pedidos y presupuestos)

## Qué cambia

Dos cosas, pensadas para el mismo caso de uso: el usuario pega o dicta un
pedido/lista larga, o adjunta una foto/captura de WhatsApp con un pedido o
una lista de stock, y quiere que el asistente lo cargue de una sola vez en
vez de ir línea por línea.

1. **`crear_presupuesto`**: hasta ahora el asistente solo podía proponer
   `crear_pedido`. Se agrega una tool análoga para presupuestos/cotizaciones,
   reusando la misma resolución de cliente/productos por texto libre
   (`resolverPedidoDesdeArgs`, ya era genérica).
2. **Texto largo e imágenes**: el input de una línea (máx. 500 caracteres,
   sin adjuntos) no alcanzaba para pegar una lista de stock o una captura de
   WhatsApp. Se sube el límite de texto y se agrega soporte de imagen
   (visión, solo Gemini) para que el modelo interprete el documento de punta
   a punta y llame `crear_pedido`/`crear_presupuesto` una sola vez con todos
   los items juntos.

## Archivos modificados

- **`lib/handlers/pedidos.js`** — nueva función pura
  `crearPresupuestoParaCliente({ empresaId, vendedorId, clienteId, items,
  notas, diasVigencia, preview })`, equivalente a `crearPedidoParaCliente`
  pero sin chequeo de stock ni de límite de crédito (un presupuesto no
  reserva nada). Resuelve precios reales contra la RPC
  `resolver_precios_cliente` — nunca confía en un precio que "lea" el
  modelo. El POST de `handlePresupuestos` se refactorizó para ser un
  wrapper fino sobre esta función en vez de duplicar la lógica (mismo
  criterio que se usó con pedidos en v500). Se exporta `ROLES_ADMIN_PRES`
  para que el asistente valide con los mismos roles que ya usa el handler
  HTTP (`dueno`, `admin`, `vendedor`, `contador`).
- **`lib/asistente-tools.js`**:
  - Nueva tool `crear_presupuesto`, con `requiereConfirmacion: true` igual
    que `crear_pedido` — nunca se ejecuta directo, solo arma una propuesta
    (`resumen()`) que el usuario confirma con el botón.
  - **Fix de un bug preexistente (de antes de esta sesión, no introducido
    acá) que rompía tanto `crear_pedido` como la `crear_presupuesto` nueva**:
    `buscarProductoPorTexto()` terminaba con `return data[0]` — `data` no
    existe en ese scope (quedó de un copy-paste de otra función), así que
    tiraba `ReferenceError` en cualquier producto resuelto por texto. Ahora
    devuelve `elegido`, igual que `buscarClientePorTexto()`. Sin este fix,
    ninguna de las dos tools funcionaba en absoluto.
- **`lib/asistente-providers.js`** — `llamarGemini()` acepta un `imagen:
  {mimeType, data}` opcional y arma un part `inlineData` para el turno
  actual del usuario (nunca se manda de vuelta en el historial de
  seguimiento). `maxOutputTokens` sube de 800 a 1200 para dar lugar a
  respuestas sobre documentos con varias líneas. `responderConFallback()`
  recibe el mismo parámetro `imagen`; cuando viene, la cadena de fallback
  se restringe a los proveedores con visión (`PROVEEDORES_CON_VISION`, solo
  Gemini) — Groq/OpenRouter no reciben la imagen y podrían sonar como si la
  hubieran visto sin haberlo hecho. Si Gemini falla con una imagen, se tira
  un error explícito en vez de degradar.
- **`lib/handlers/asistente.js`**:
  - `MAX_LARGO_PREGUNTA` sube de 500 a 8000 caracteres.
  - Nuevos `imagen_base64`/`imagen_mime_type` opcionales en el body: se
    valida tipo (JPG/PNG/WEBP) y tamaño (`MAX_IMAGEN_BASE64_CHARS` ≈
    5.6M caracteres de base64, ~4MB reales). Se puede mandar solo imagen,
    sin texto (se sustituye por una instrucción genérica antes de llegar al
    RAG/Gemini).
  - El `system prompt` ahora le explica al modelo que interprete texto
    largo pegado o imágenes de punta a punta, identifique cliente y cada
    producto+cantidad, y llame `crear_pedido`/`crear_presupuesto` **una sola
    vez** con todos los items juntos — no ir preguntando línea por línea si
    el documento ya es razonablemente claro. Si no hay cliente identificable
    o ninguna línea se entiende, no inventa: le pide al usuario que aclare.
- **`frontend/shared/chat-widget.js`**:
  - `MAX_LARGO_PREGUNTA` sube a 8000 (igual que el backend).
  - El `<input>` de una línea se reemplaza por un `<textarea>`
    auto-expandible (hasta 120px, con scroll interno después) — Enter
    envía, Shift+Enter inserta salto de línea.
  - Botón de adjuntar + input de archivo oculto + captura de `paste` (para
    pegar capturas de WhatsApp directo del portapapeles).
  - Chip de "adjunto pendiente" con miniatura, nombre y botón de quitar.
  - La burbuja propia del chat muestra la miniatura de la imagen enviada
    (`imagenPreviewUrl` en `agregarMensaje()`), arriba del texto.
  - **Fix de un bug de esta misma sesión** (quedó a mitad de camino en el
    chat anterior): `enviarPregunta()` declaraba `const body` dos veces en
    la misma función (el payload de la request y la respuesta parseada),
    lo que rompía la sintaxis de todo el archivo. Se renombró el payload a
    `reqBody`.
- **`frontend/shared/chat-widget.css`** — estilos nuevos:
  `.chat-asistente-burbuja-imagen` (miniatura en la burbuja propia),
  `.chat-asistente-adjuntar` (botón, mismo tono que el de dictado por voz),
  `.chat-asistente-adjunto` / `-miniatura` / `-nombre` / `-quitar` (chip de
  adjunto pendiente), y el `.chat-asistente-input` pasa de `input` a
  `textarea` (resize:none, max-height 120px, scroll interno).

## Por qué no hace falta migración/RLS nueva

`crearPresupuestoParaCliente()` usa el mismo cliente `supabase` (service
role, bypassa RLS) que ya usa el resto de `lib/handlers/pedidos.js`, y solo
toca tablas ya existentes (`clientes`, `productos`, `presupuestos`,
`presupuesto_items`) con la misma RPC `resolver_precios_cliente` que ya
usa `crearPedidoParaCliente`. No se crea ninguna tabla ni política nueva.

## Verificado antes de armar el zip

- `node --check` en los 5 archivos JS tocados
  (`lib/handlers/pedidos.js`, `lib/handlers/asistente.js`,
  `lib/asistente-providers.js`, `lib/asistente-tools.js`,
  `frontend/shared/chat-widget.js`).
- Reconstrucción de los cambios de `lib/asistente-tools.js` contra la
  transcripción del chat anterior (el archivo no había quedado adjuntado
  como "versión final" en esta sesión, a diferencia de los otros 4 — se
  verificó que `resolverPedidoDesdeArgs`, `ROLES_ADMIN_PRES`/`ROLES_ADMIN`
  y `crearPresupuestoParaCliente`/`crearPedidoParaCliente` calzan con lo
  que quedó en `lib/handlers/pedidos.js`).
- **No se pudo correr** `scripts/check-schema.js` ni los tests de
  integración contra la base real (sin `node_modules` instalado ni acceso
  de red a Supabase desde este entorno).

## Pendiente / a revisar en la próxima sesión

- Probar en el navegador el flujo completo de adjuntar/pegar una imagen y
  confirmar que Gemini interpreta bien una captura de WhatsApp real (acá
  solo se validó sintaxis, no comportamiento contra la API real).
- Confirmar que el ítem del roadmap original (`interpretar_documento` como
  tool separada + tabla editable de líneas resueltas/ambiguas en el
  chat-widget, en vez de que el modelo llame `crear_pedido`/
  `crear_presupuesto` directo) sigue siendo deseable, o si esta versión más
  simple (el modelo arma los items y depende de `requiereConfirmacion` para
  el resumen antes de confirmar) alcanza por ahora.
