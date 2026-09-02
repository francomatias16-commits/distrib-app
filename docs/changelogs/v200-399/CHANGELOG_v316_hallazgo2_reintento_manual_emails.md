# CHANGELOG v316 — Hallazgo 2 (auditoría de notificaciones): reenvío manual de emails

Continuación de `CHANGELOG_v305_etapa1_hallazgo2_notif_log.md` (que ya
había arreglado el logueo de WhatsApp/email de `confirmacion_pedido`).
Esta etapa investigó agregar un botón de "Reintentar" para emails
fallidos y encontró que, de los 4 tipos de email del sistema, **solo 1 de
4 dejaba rastro cuando fallaba** — así que antes de poder reintentar nada
había que arreglar el logueo en los otros 3.

## Diagnóstico (consultado directo contra la base real, no solo el código)

| Email | ¿Logueaba en notif_log? | Problema |
|---|---|---|
| Confirmación de pedido | Sí, siempre | Ya andaba bien (v305) |
| Aviso de despacho | Nunca | `notificarDespachoPorEmail()` llamaba a `enviarEmailDespacho()` y descartaba el resultado por completo |
| Recepción a proveedor | Nunca | El insert mandaba una columna `resend_id` que **no existe** en `notif_log` (la real es `message_id`); el insert fallaba en silencio porque no se revisaba `error` |
| Estado de cuenta | Solo si tuvo éxito | `handleEstadoCuenta()` hacía `return res.status(502)` **antes** de loguear, y logueaba en `email_log` — tabla legada sin columnas `entregada`/`motivo` |

Adicionalmente: `notif_log.entregada` y `notif_log.motivo` existen en la
base real de producción pero **nunca se agregaron con una migración
versionada** — se aplicaron a mano en algún momento. Cualquiera que
reconstruya la base desde `supabase/migrations/*.sql` de cero terminaba
con una tabla sin esas dos columnas.

## Migración (`supabase/migrations/316_etapa_notif_fix_columnas_notif_log_y_reintento_email.sql`)

- `ALTER TABLE notif_log ADD COLUMN IF NOT EXISTS entregada boolean NOT NULL DEFAULT true`
- `ALTER TABLE notif_log ADD COLUMN IF NOT EXISTS motivo text`
- Índice parcial `idx_notif_log_email_fallidos` para el filtro típico del
  panel de reintentos (emails fallidos de la propia empresa).
- Todo `IF NOT EXISTS` — no rompe nada si ya existen (como en producción).

## Código

### `lib/handlers/pedidos.js`
- `_logNotifConfirmacion()` → renombrado a `_logNotif()` y generalizado
  con parámetro `tipo` explícito (antes tenía `'confirmacion_pedido'`
  hardcodeado). Los 7 call-sites existentes se actualizaron para pasar
  `tipo: 'confirmacion_pedido'` — mismo comportamiento, código reusable.
- `notificarDespachoPorEmail()`: ahora loguea siempre (`sin_email`, éxito,
  falla de envío, o excepción), con `tipo: 'pedido_despachado'`. Antes no
  dejaba ningún rastro.

### `lib/handlers/proveedores.js`
- El insert a `notif_log` para `recepcion_proveedor` ya no manda
  `resend_id` (columna inexistente) — usa `message_id`, la columna real.
- Se loguea **antes** de decidir la respuesta HTTP, así las fallas también
  quedan registradas (antes el `return res.status(502)` cortaba el flujo
  antes de llegar al insert).
- Se agrega chequeo del `error` del insert (antes se ignoraba).

### `lib/handlers/notif.js`
- `handleEstadoCuenta()`: migrado de `email_log` a `notif_log`
  (`tipo: 'estado_cuenta'`, `canal: 'email'`), logueando también las
  fallas. `email_log` deja de recibir filas nuevas pero el panel sigue
  leyendo las históricas.
- **Nuevo endpoint** `POST /api/notif/reintentar-email` (`_svc=reintentar-email`,
  Bearer token, rol dueño/admin, mismo rate-limit que estado-cuenta por
  tratarse de un envío real con costo):
  - Recibe `{ notif_log_id }`, valida que sea `canal='email'` y
    `entregada=false` y que el `tipo` esté en la lista de reintentables.
  - Reconstruye el email desde datos frescos de la base (no reenvía un
    HTML guardado — `notif_log.payload` guarda solo identificadores
    livianos a propósito) y llama al mismo `enviarEmailXxx()` que el flujo
    original.
  - Inserta el resultado como **fila nueva** en `notif_log`
    (`payload.reintento_de` apunta a la fila original) para conservar el
    historial completo de intentos en vez de mutar el registro original.
  - Tipos soportados hoy: `confirmacion_pedido`, `pedido_despachado`,
    `estado_cuenta`, `recepcion_proveedor`.

### `vercel.json`
- Nueva ruta `/api/notif/reintentar-email → _mod=notif&_svc=reintentar-email`.

### Frontend (`frontend/admin/js/notif-log.js`, `frontend/admin/notif-log.html`)
- Botón **"Reintentar"** en cada fila de email fallido (excluye filas
  legadas de `email_log`, que no tienen fallas registradas, y tipos que
  el backend todavía no reconstruye).
- `reintentarEmail()` llama al endpoint nuevo con el token de sesión y
  recarga el historial al terminar (patrón calcado de
  `reintentar()` en `facturacion.js`).

### Documentación
- `docs/ayuda/notificaciones-push-y-email.md`: la FAQ ahora describe el
  botón real (antes decía "según el caso, se puede reintentar
  manualmente" sin que existiera ningún mecanismo para 3 de los 4 tipos).

## Pendiente / fuera de alcance de esta etapa

- Push y WhatsApp no tienen botón de reintento todavía (el hallazgo
  original era específicamente sobre email).
- No hay reintento automático (solo manual, disparado por un admin desde
  el panel).
