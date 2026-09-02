# v782 — Migración del cobro QR del POS a la Orders API de Mercado Pago

## Por qué se hizo
Investigando por qué el QR del POS no lo leía Modo (ver hilo adjunto),
apareció el motivo real: `pos-qr-cobrar` usaba la API **"Órdenes
presenciales v2"** (Instore Orders V2, `PUT /instore/qr/seller/collectors/
{user_id}/stores/{store_id}/pos/{pos_id}/orders`). MP la documenta como
legacy — tiene una guía de migración dedicada y hasta un prompt propio
para que un agente la detecte y migre — y esa API nunca quedó cubierta por
el programa de interoperabilidad de QR con otras billeteras.

Que Modo específicamente lea el QR sigue sin depender de esta integración
(Modo tiene que estar dado de alta en el programa de interoperabilidad de
MP, eso corre por cuenta de ellos). Pero migrar a la API vigente es lo
correcto de todos modos: es la única que sigue recibiendo funcionalidad
nueva, y de paso saca esta integración de una API que MP puede discontinuar.

Migración hecha contra la guía oficial:
`mercadopago.com/developers/en/docs/qr-code/migrate-instore-orders-v2-to-orders`

## Qué cambia

### Crear el cobro (`_svc=pos-qr-cobrar`)
| | Antes (Instore Orders V2) | Ahora (Orders API) |
|---|---|---|
| Endpoint | `PUT /instore/qr/seller/collectors/{user_id}/stores/{store}/pos/{pos}/orders` | `POST /v1/orders` |
| Identidad/POS | En el path (`user_id`, `store_id`, `pos_id`) | Del Access Token + `config.qr.external_pos_id` en el body |
| Respuesta éxito | `204` sin body | `201` con el objeto completo — **el `id` de la orden ("ORD...") hay que guardarlo**, es la clave para todo lo que sigue |
| Monto | `total_amount` (number) | `transactions.payments[].amount` (string, "123.45") |
| Header nuevo | — | `X-Idempotency-Key` (obligatorio, UUID por request) |
| `notification_url` en el body | Sí | No existe — las notificaciones se configuran como webhook en Your integrations |

`config.qr.mode: 'static'` reproduce el comportamiento de siempre (reusa el
QR fijo ya impreso de la caja) — no hace falta generar un QR nuevo por
venta ni cambiar la UX del cajero.

### Verificar el cobro (`_svc=pos-qr-verificar`)
Antes buscaba el pago por `external_reference` contra `/v1/payments/
search`. La guía de MP es explícita: **"the Payments API must not be used
in integrations with the Orders API"**. Ahora consulta `GET /v1/orders/
{order_id}` y lee `status` (`created` / `processed` / `canceled` /
`refunded` / `expired` — `processed` es el único que equivale a pago
aprobado).

Como la Orders API no tiene buscador por `external_reference`, el POS
ahora tiene que reenviar el `order_id` que devolvió `pos-qr-cobrar` al
llamar a `pos-qr-verificar` (antes alcanzaba con la `referencia` propia).
Se actualizó `pos-terminal.js` para guardarlo y mandarlo en cada poll.

### Webhook (`manejarWebhook`)
Se agregó el branch `type === 'order'` (topic `order`, "Order (Mercado
Pago)" en Your integrations) — reemplaza a `payments`/`merchant_orders`
para este flujo. **Falta el paso manual**: suscribir el topic `order` en
Your integrations → Webhooks para esta app (y dar de baja `payments`/
`merchant_orders` si solo se usaban para QR) antes de ir a producción.

El branch nuevo solo loguea la notificación (`orderId`, `action`) y
responde `200` — **no** intenta conciliar la venta contra `pedidos`/
`transacciones_pago`. Ese es el mismo gap ya documentado para el modelo
viejo en `CHANGELOG_v760_qr_mercadopago_pos.md` (un cobro QR del POS no
tiene fila propia ahí): sigue resolviéndose por el polling de
`pos-qr-verificar` del lado del cajero, no por este webhook. No se tocó
porque migrar el transporte (API vieja → nueva) y cerrar ese gap de
conciliación son dos cambios independientes — mezclarlos hace más difícil
detectar si algo se rompió por cuál de los dos motivos.

### Lo que NO cambió
- **Setup** (`_svc=pos-qr-setup`, creación de Store y POS): es una API
  distinta, no forma parte de la Orders API ni de esta migración.
- El flujo de negocio de cara al cliente: sigue escaneando el mismo QR
  fijo impreso con la app de MP.
- El access_token/cuenta conectada — se sigue reusando la misma que
  Checkout Pro/Point.

## Pendiente antes de producción
1. **Suscribir el topic `order`** en Your integrations → Webhooks (dar de
   baja `payments`/`merchant_orders` si solo se usaban para este flujo).
2. **Probar contra una cuenta de test real** — no hay salida de red hacia
   `api.mercadopago.com` desde este entorno, así que esto está verificado
   línea por línea contra la guía oficial de migración, no contra la API
   en vivo. Cubrir: cobro exitoso, expiración de orden, y que Modo (con la
   cuenta de test que corresponda) al menos ya no rechace el QR por
   "tipo de QR no válido" — aunque leerlo de punta a punta sigue
   dependiendo de que Modo esté en el programa de interoperabilidad.
3. Cancelación y reembolso (`POST /v1/orders/{id}/cancel` y `.../refund`,
   nuevos en la Orders API) no se implementaron en este paquete — hoy el
   POS no tiene un flujo de "cancelar cobro QR en curso" ni de reembolso
   desde caja, así que no había un endpoint viejo equivalente que migrar.
   Si se necesitan, son dos handlers nuevos, no una migración de los
   existentes.
