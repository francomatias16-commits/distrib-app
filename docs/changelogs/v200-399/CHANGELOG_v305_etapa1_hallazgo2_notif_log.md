# CHANGELOG v305 — Etapa 1 (Pedidos), Hallazgo 2: notificaciones de confirmación fallan en silencio

Continuación de `AUDITORIA_2026/etapas_modulos/01_pedidos.md`. Implementa
los puntos 1 y 2 del fix propuesto para el Hallazgo 2 (el punto 3, retry
automático, queda pendiente — ver "Pendiente" al final).

## Código (`lib/handlers/pedidos.js`)

- **`notificarPedidoConfirmado`** (WhatsApp + email de confirmación):
  - Antes: si el cliente no tenía teléfono, la función retornaba temprano
    y **el email tampoco se enviaba nunca** — un bug adicional al de
    logging, no documentado en el hallazgo original. Ahora WhatsApp y
    email son independientes: la falta de teléfono solo omite el
    WhatsApp.
  - Antes: solo el envío exitoso de WhatsApp escribía en `notif_log`. Las
    3 ramas de fallo (`sin_telefono`, respuesta no-ok de la API,
    excepción de red) solo hacían `console.error` y no dejaban rastro.
    Ahora las tres escriben en `notif_log` con `entregada: false` y
    `motivo` en (`sin_telefono` | `error_envio` | `error_red`).
  - El email de confirmación **no se logueaba nunca**, ni éxito ni
    fallo. Ahora se inserta un registro (`canal: 'email'`) leyendo el
    resultado real de `enviarEmailConfirmacionPedido()` (que a su vez
    expone `ok`/`razon` desde `enviarEmail()`): `sin_email`,
    `no_configurado`, `error_resend`, `error_red`, o (nuevo, agregado acá)
    `cliente_no_encontrado` / `error_inesperado` para los casos donde ni
    siquiera se pudo armar el email.
  - Se agregó `_logNotifConfirmacion()` para no repetir el `insert` en
    cada rama.

- **`notificarPushPedidoConfirmado`** — bug encontrado durante la
  implementación del fix, más grave que el hallazgo original: esta
  función le pegaba a `POST /api/notif/push`, que **no es un endpoint de
  envío** — es el endpoint de alta/baja de dispositivo (espera
  `{ usuario_id, token_push }`). El body real que mandaba
  (`{ tokens, titulo, cuerpo, datos, empresa_id }`) no matchea esa forma,
  así que la llamada devolvía 400 siempre. Como no había `if (!resp.ok)`
  ni `catch`, la falla era 100% silenciosa. **El push de "pedido
  confirmado" al cliente nunca se entregó desde que existe esta
  función.** Reemplazado por una llamada directa a `enviarPush()`
  (`lib/handlers/_push.js`, el mismo helper que ya usa `push-interno`),
  que evita el round-trip HTTP roto y loguea en `notif_log`
  automáticamente (éxito y falla) vía su propio `_logMeta`.

`notificarPushAdmin` no se tocó — ya usa `push-interno` correctamente y
ese camino sí llama a `enviarPush()` internamente (confirmado leyendo
`pushInternoHandler` en `lib/handlers/notif.js`), así que ya logueaba
bien.

## Frontend (`frontend/admin/pedidos.html`, `js/pedidos.js`, `css/pedidos.css`)

- Nueva sección "Notificaciones de confirmación" en el modal de detalle
  de pedido (`abrirModal`), justo debajo de las observaciones del
  cliente. Lee `notif_log` filtrando por `pedido_id` +
  `tipo = 'confirmacion_pedido'` (cubre WhatsApp, email y push en una
  sola consulta, porque las tres ramas ahora comparten ese `tipo`) y
  muestra un badge verde/rojo por canal, más el motivo en texto plano
  cuando falló (diccionario `NOTIF_MOTIVO_LABEL`, ES). Si no hay ningún
  registro (pedidos viejos, previos a este fix), la sección se oculta en
  vez de mostrar vacío.
- La consulta usa `window.supabaseClient` directo (mismo patrón que el
  resto del modal); la RLS existente (`ver notif_log propia empresa`) ya
  restringe correctamente por `empresa_id` vía `usuarios.id = auth.uid()`
  — no requirió cambios de RLS.

## Pendiente (fuera de este cambio)

- Punto 3 del fix propuesto en el hallazgo: reintento automático (1
  retry) antes de marcar como fallido para el subconjunto de errores
  transitorios (`error_red`, `error_resend`). No implementado todavía.
- No se agregó la misma sección de estado de notificaciones al portal
  del cliente (`frontend/cliente/pedidos.html`) — el hallazgo solo pedía
  visibilidad del lado admin.
