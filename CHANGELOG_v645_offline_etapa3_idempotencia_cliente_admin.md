# v645 — Plan offline, Etapa 3, ítem 1: crear pedido offline (cliente/admin)

## Contexto

Continuación directa de la sesión anterior (backend + `cliente-offline.js`
ya escritos, ver changelog previo). Esta entrega cierra lo que faltaba:
conectar esas piezas a las pantallas reales y confirmar que el mecanismo
de idempotencia de `crear_pedido_cliente()` (fast-path + `unique_violation`
+ índice único `pedidos_idempotency_key_uniq`) ya está en producción — se
verificó en vivo contra Supabase, no hacía falta ninguna migración nueva.

## Frontend (portal cliente)

- **`frontend/cliente/carrito.html`**:
  - Carga `/cliente/cliente-offline.js` (mismo orden que `chofer-offline.js`
    en `remito.html`: justo después de `supabase-js`).
  - `ClienteOffline.init({ getToken })` en `DOMContentLoaded`.
  - `esErrorDeRed(e)`: mismo criterio que el portal chofer — distingue
    error de negocio (mostrar) de fetch que nunca completó (encolar).
  - El payload de confirmar pedido se arma una sola vez, antes del
    `try`, y se reusa tanto para el POST online como para
    `ClienteOffline.encolarPedido()` en el `catch` — así los dos caminos
    comparten siempre la misma `idempotency_key`.
  - Al encolar offline: se libera la key de `sessionStorage` (el registro
    en la cola ya se llevó su propia copia), se vacía el carrito local y
    se muestra el modal de éxito con mensaje de "sin conexión, se va a
    enviar solo".

## Frontend (admin)

- **`frontend/admin/pedidos.html`**: el modal "Nuevo pedido" ahora genera
  un `idempotency_key` (`crypto.randomUUID()`) al abrirse y lo manda en
  cada intento de `pedido_guardar()`. Se libera recién en éxito, así un
  reintento tras un error de conexión reusa la misma key en vez de
  generar una nueva — el backend (`crearPedidoAdminHandler`, sesión
  anterior) ya sabía leerla, pero nada se la mandaba todavía.

## Verificado en Supabase (sin migración nueva)

- `crear_pedido_cliente()` en producción ya tiene `p_idempotency_key`,
  fast-path de dedup y fallback por `unique_violation`.
- Índice `pedidos_idempotency_key_uniq` (`empresa_id, cliente_id,
  idempotency_key`, parcial `WHERE idempotency_key IS NOT NULL`) ya
  existe.
- Confirmado que este mecanismo viene de antes de esta etapa (auditoría
  "Hallazgo 3, Etapa 1, Pedidos"); lo que faltaba era exclusivamente el
  lado JS (admin y outbox del cliente), ya cerrado acá.

## Pendiente / a verificar

- Falta decidir si el modal de éxito offline del cliente necesita algún
  indicador visual además del mensaje (p. ej. un ícono distinto al de
  pedido confirmado online).
- No se tocó el flujo de "repetir último pedido" del admin — usa el
  mismo `pedido_guardar()`, así que ya hereda la idempotencia sin cambios
  extra.
