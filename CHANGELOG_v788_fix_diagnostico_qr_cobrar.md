# CHANGELOG v788 — Diagnóstico del error genérico en cobro QR (POS)

## Problema
En "Cobrar → QR" el POS mostraba siempre el mismo mensaje genérico:
"No se pudo cargar el monto en el QR. Reintentá." (502 de `posQrCobrarHandler`).

El catch que envuelve la llamada a `POST /v1/orders` de Mercado Pago
logueaba el `responseBody` del error solo con `console.error`, sin ningún
id para cruzarlo con los logs de Vercel, y el frontend no mostraba nada
que permitiera distinguir la causa real (POS mal configurado, token
vencido, campo inválido, etc.).

## Cambio
- `lib/handlers/pagos.js` (`posQrCobrarHandler`): el catch ahora usa
  `errorSeguro()` — el mismo helper que ya usa el resto del archivo — que
  genera un `correlation_id`, lo loguea junto al `responseBody` completo
  de MP, y lo devuelve al cliente.
- `frontend/admin/js/pos-terminal.js` (`cobrarQrMercadoPago`): el mensaje
  de error que ve el cajero ahora incluye `(ref: <correlation_id>)`.

## Próximo paso
Con el `correlation_id` que aparezca en el próximo error, buscar en los
logs de Vercel (`grep correlation_id=<id>`) el código real que devolvió
Mercado Pago (`pos_not_found`, `property_value`, `marketplace_not_valid`,
etc.) para aplicar el fix definitivo — este cambio es solo de
observabilidad, no toca la lógica de creación de la orden QR.

## Sospecha principal (a confirmar con el log)
`pos_not_found`: el historial reciente (v777, v779, v781) tocó varias
veces `external_pos_id` / `store_id` / provincia normalizada del store
QR — es el candidato más probable si el POS quedó desincronizado en el
lado de Mercado Pago.
