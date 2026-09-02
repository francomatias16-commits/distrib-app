# Changelog v283 — Etapa 3 del plan WhatsApp bidireccional: hardening del webhook

Ver `PLAN_whatsapp_bidireccional_seguimiento.md` para el plan completo.
Este changelog cubre solo la Etapa 3 (código).

## Hallazgos que se cierran (Etapa 0 del plan)

- El webhook `whatsapp-webhook` no validaba la firma `X-Hub-Signature-256`
  de Meta → cualquiera que adivinara la URL podía simular ser un cliente
  por teléfono.
- El webhook no tenía rate limiting propio.

## Cambios

### `lib/handlers/notif.js`

- Nueva función `firmaValidaDeMeta(req)`: valida el header
  `X-Hub-Signature-256` con HMAC-SHA256 usando `WA_APP_SECRET`,
  comparando en tiempo constante (`crypto.timingSafeEqual`). Fail-closed:
  si `WA_APP_SECRET` no está configurado, rechaza en vez de dejar pasar.
- `whatsappWebhookHandler`: antes de procesar cualquier POST, ahora
  aplica (en orden) `limiterWebhookWhatsApp` (60 req/min por IP) y
  `firmaValidaDeMeta`. Responde 401 si la firma falta o no matchea.
  El `GET` de verificación (`hub.mode`/`hub.verify_token`) no cambia —
  no lleva firma, es un mecanismo aparte de Meta.
- Nuevo import: `crypto` (`node:crypto`, built-in, sin dependencia nueva).
- Comentario de variables de entorno requeridas actualizado con
  `WA_APP_SECRET`.

### `api/index.js`

- Se agregó `export const config = { api: { bodyParser: false } }` y un
  parseo manual del body (`leerRawBody` + `JSON.parse`) antes de
  despachar a cualquier módulo.
  **Motivo:** el HMAC de la firma de Meta se calcula sobre los bytes
  exactos del body tal como llegaron. El bodyParser automático de Vercel
  ya los convierte a objeto JS antes de que el handler los vea, así que
  sin este cambio la firma nunca iba a matchear.
  **Alcance del cambio:** `req.body` le sigue llegando a los ~25 módulos
  restantes exactamente igual que antes (mismo objeto parseado); lo único
  nuevo es `req.rawBody` (Buffer), que hoy solo usa `notif.js`. GET/HEAD
  no pasan por este parseo (no tienen body).

## Variables de entorno nuevas

- `WA_APP_SECRET` — App Secret de la app de Meta (Settings → Basic).
  Ya cargado en Vercel (Production + Preview) al momento de este cambio.

## Pendiente / riesgo conocido

- **No probado contra Meta real** — no hay forma de desplegar ni de
  recibir un webhook real desde el entorno donde se hizo este cambio.
  Verificado solo con `node --check` (sintaxis) y revisión manual de la
  lógica.
- El `GET` de verificación de la Etapa 4 no ejercita la validación de
  firma (es un mecanismo distinto) — el primer test real de la firma es
  el primer mensaje entrante de la Etapa 6.
- Si algo falla al activar el webhook: revisar logs de Vercel buscando
  `[whatsapp-webhook]`. Los rechazos por firma inválida y por
  `WA_APP_SECRET` faltante quedan logueados ahí con `console.error`.
- Confirmar si `WA_ACCESS_TOKEN` es temporal (24h) o de System User
  permanente — no relacionado a este cambio, pero pendiente del plan.
