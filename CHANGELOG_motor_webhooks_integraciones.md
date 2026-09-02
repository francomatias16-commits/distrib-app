# Motor de Integraciones/Webhooks — generalización (log + dedupe + reintentos)

## Contexto

Auditoría de código (no de memoria) sobre el roadmap "qué le falta a un
proyecto de esta envergadura": de los 4 puntos planteados (integraciones/
webhooks, estados complejos/fallbacks, storage, notificaciones en tiempo
real), 3 ya estaban cubiertos en el código real:

- **Storage**: buckets versionados con `file_size_limit`/`allowed_mime_types`,
  RLS por bucket, buckets sensibles privados con signed URLs de vencimiento
  corto (`lib/utils/storage-urls.js`), optimización de imágenes con `sharp`.
- **Notificaciones en tiempo real**: patrón trigger → `pg_net` → endpoint →
  Firebase ya implementado (`016_push_triggers.sql`), más un centro de
  avisos in-app (`avisos.html`).
- **Estados complejos/fallbacks**: offline-first con outbox en IndexedDB,
  colas FIFO e idempotency keys (ya reportado en trabajo previo).

El único hueco real era la **generalización del motor de webhooks**:
Mercado Pago y WhatsApp ya tenían webhooks entrantes sólidos por separado
(verificación de firma HMAC fail-closed, idempotencia puntual por
`payment_id`/`wa_message_id`), pero no había una capa única de
observabilidad, dedupe genérico entre integraciones ni cola de reintento
cuando el procesamiento post-firma fallaba.

## Qué se agregó

1. **`supabase/migrations/577_webhooks_recibidos.sql`**
   Tabla `webhooks_recibidos` (integracion, evento_externo_id, tipo,
   empresa_id, payload, headers, firma_valida, estado, intentos,
   ultimo_error). `UNIQUE(integracion, evento_externo_id)` para dedupe a
   nivel de base — si el proveedor reintenta el mismo evento, el segundo
   insert choca y el handler corta sin reprocesar. RLS: solo dueño/admin
   ven los eventos de su empresa; las escrituras las hace únicamente el
   backend con service key. Función `fn_webhook_marcar_error` para
   incrementar intentos de forma atómica.

2. **`lib/repos/webhooks.js`** (nuevo, expuesto como `WebhooksRepo` en el
   barrel `lib/repos/index.js`)
   `registrarWebhookEntrante`, `marcarWebhookError`,
   `listarWebhooksParaReintentar`.

3. **Wiring en los webhooks entrantes reales:**
   - `lib/handlers/pagos.js` (`manejarWebhook`, Mercado Pago): registra el
     evento apenas pasa `verificarFirmaMP`, corta temprano si es duplicado,
     marca error en el catch existente sin tocar la lógica de negocio de
     adentro.
   - `lib/handlers/notif.js` (`whatsappWebhookHandler`): mismo patrón. Como
     un solo POST de Meta puede traer varios entries/changes (no hay un
     único id a nivel de POST), el evento se identifica por hash SHA-1 del
     body crudo.

4. **Cron de reintento** — `handleWebhooksReprocesarCron`, ruta
   `/api/notif/webhooks-reprocesar`, agregada a `vercel.json` (`_svc=
   webhooks-reprocesar-cron`, schedule `45 3 * * *`, mismo horario
   escalonado que los otros 3 crons de reproceso existentes).
   Reprocesa automáticamente los webhooks de **WhatsApp** en estado
   `error` (vuelve a correr `procesarCambioWebhookWhatsapp` sobre el
   payload guardado — hereda la idempotencia por `wa_message_id`).

## Pendiente (a propósito, no es un olvido)

- **Reproceso automático de Mercado Pago**: `manejarWebhook` valida la
  firma HMAC como primer paso de la función y no tiene su lógica de
  negocio separada en una función reusable sin esa validación. Extraerla
  es un cambio más grande sobre un archivo de pagos crítico — queda como
  siguiente paso del Motor de Integraciones, no colado en este commit.
  Mientras tanto, los eventos de MP en error quedan registrados y
  visibles en `webhooks_recibidos` para diagnóstico/reproceso manual.
- **ARCA/AFIP** queda afuera del motor de webhooks a propósito: no recibe
  webhooks entrantes, la integración es 100% saliente.

## Variables de entorno

Ninguna nueva — reutiliza `CRON_SECRET` (ya usado por los otros 3 crons de
reproceso) para autenticar el endpoint de reintento.
