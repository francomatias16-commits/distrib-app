# v583 — Fix: retry automático sin idempotencia en el POST que dispara el cobro Prisma

## Auditoría funcional pre-lanzamiento — Etapa 1 (POS), continuación de "API Prisma nueva"

## Hallazgo
Comparando los tres endpoints que crean un cobro presencial (`mp-point-cobrar`,
`pos-qr-cobrar`, `prisma-cobrar`):

- `mp-point-cobrar` y `pos-qr-cobrar` mandan `X-Idempotency-Key` en el POST a
  Mercado Pago — confirmado en su documentación como el mecanismo para que un
  reintento no cree un segundo intento/orden de cobro.
- `prisma-cobrar` (`POST /payments`, el que efectivamente empuja el cobro a
  la terminal física) usaba el mismo patrón de reintento automático
  (`withRetry` dentro de `prismaBreaker.exec`, hasta 3 intentos ante error de
  red/5xx/429) **sin ningún header de idempotencia**. `ecr_transaction_id` va
  en el body como dato de conciliación, pero no hay confirmación en el
  portal de desarrolladores de Prisma de que lo use para deduplicar
  reintentos del lado del servidor.

Riesgo concreto: si Prisma ya procesó el POST pero la respuesta se pierde por
un timeout/corte de red/5xx transitorio (justo los casos que `withRetry`
reintenta por defecto), el backend reintentaba automáticamente — pudiendo
volver a empujar el cobro a la terminal una segunda vez. En el mejor caso, un
segundo prompt en la terminal; en el peor, cobrarle la tarjeta dos veces al
cliente por una sola venta.

Intenté confirmar contra el portal de desarrolladores de Prisma
(`developers.prismamediosdepago.com`, catálogo "Paystore terminals - Terminal
Payments v1") si `ecr_transaction_id` deduplica server-side, pero la página
no devolvió contenido navegable. No encontré confirmación en ningún sentido,
así que no asumí que fuera seguro reintentar.

## Fix
`prismaCobrarHandler` (`lib/handlers/pagos.js`) — se saca `withRetry` del
POST `/payments` puntual. Se mantiene el circuit breaker (`prismaBreaker`,
que solo corta llamadas cuando el proveedor está caído, no las repite). Si
el POST falla, se lo reporta al cajero para reintentar manualmente desde
cero (nueva referencia, nuevo request) — mismo criterio que ya existe en el
POS para otros casos borde: preferible una venta que hay que reintentar a
mano antes que un cobro duplicado en la tarjeta del cliente.

`prisma-verificar` (GET, solo lectura) y `prisma-cancelar` (best-effort, ya
diseñado para no fallar duro) **no se tocaron** — son operaciones seguras de
repetir y siguen reintentando igual que antes.

## Pendiente (para una vuelta futura, no bloqueante)
Confirmar con soporte de Prisma (no con la doc pública, que no lo aclara) si
`ecr_transaction_id` deduplica un `POST /payments` repetido con el mismo
valor. Si lo confirman, se puede volver a envolver ese POST en `withRetry`
sin este riesgo.

## Alcance
Cambio acotado a `lib/handlers/pagos.js` (una función). No requiere
migración de base de datos — no toca el schema ni ninguna RPC.
