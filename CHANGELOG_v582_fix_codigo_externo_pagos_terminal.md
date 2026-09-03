# v582 — Fix: el payment_id real del gateway (Prisma/MP) se perdía, nunca se guardaba

## Auditoría funcional pre-lanzamiento — Etapa 1 (POS), siguiendo con "API Prisma nueva"

## Hallazgo
Auditando la integración nueva de Prisma (Paystore terminals), encontré que
**ningún** driver de terminal que cobra por gateway (Prisma, MP Point, MP QR)
persiste el ID de pago real que devuelve el proveedor:

- `pos-terminal.js` sí lo captura en cada driver — vive en
  `resultado.codigo` (ej. `codigo: String(dVer.payment_id)` para MP,
  `codigo: paymentId` para Prisma).
- Pero `cliente-cobro.js` arma el body de `POST /api/pos/venta` sin
  incluir ese campo — solo manda `referencia` (una idempotency key
  generada en el navegador, tipo `pos-1735...-ab12cd`).
- `registrar_venta_pos()` (la RPC que hace el INSERT real) solo tiene
  columna para `referencia`. El payment_id real quedaba atrapado un
  instante en el objeto JS del navegador y se perdía apenas terminaba la
  venta — no en ningún log, no en ninguna tabla.

No es solo un problema de trazabilidad para soporte/reconciliación: es
lo que **bloquea directamente** poder construir alguna vez la reversa real
de tarjeta/QR contra Mercado Pago o Prisma que quedó documentada como
pendiente en el fix de devoluciones (v581/migración 581) — no se puede
cancelar/reversar un pago del que nunca guardamos el id.

## Fix — migración 582
- `venta_pos_pagos` → nueva columna `codigo_externo TEXT NULL` (distinta
  de `referencia`, que sigue siendo la idempotency key local).
- `registrar_venta_pos()` ahora también inserta `v_pago->>'codigo'` en
  `codigo_externo`.
- `frontend/admin/js/pos/cliente-cobro.js` → el body de la venta ahora
  manda `codigo: p.codigo || null` por cada pago (el dato ya existía en
  memoria, solo faltaba enviarlo).

## Verificación
Migración aplicada en Supabase. Antes de tocar el frontend, probé la RPC
actualizada con una venta de prueba real (producto/depósito/turno
existentes) dentro de una transacción con `ROLLBACK` — el
`codigo_externo` quedó guardado correctamente (`PRISMA-PAY-TEST-123` →
persistido en `venta_pos_pagos.codigo_externo`); nada quedó en la base.

## Alcance / lo que queda afuera a propósito
No agregué todavía el `codigo_externo` a ninguna pantalla de admin
(historial de ventas, panel de anulación) — el fix de esta vuelta era
parar la pérdida del dato. Si querés que se muestre en algún lado puntual
(ej. detalle de venta, para soporte/reconciliación manual contra el
back-office de Prisma), lo agrego en la próxima vuelta.

## Auditoría de ticket térmico (pos-printer.js)
Repasé también la impresión de ticket y reporte Z (subtotal/IVA/total/
vuelto, drivers WebUSB/red/Bluetooth/navegador): sin hallazgos de
plata/lógica. Único detalle cosmético, no funcional: el mapa de labels de
medio de pago incluye entradas muertas para `mp_point`/`getnet`/`prisma`/
`naranja` — esos son nombres de *driver* de terminal, no de *medio* de
pago (`venta_pos_pagos.medio` solo admite efectivo/transferencia/tarjeta/
qr/cuenta_corriente por constraint), así que esas claves del mapa nunca
matchean. No lo toqué por no ser un bug real, solo código muerto
inofensivo — lo dejo mencionado por si en algún momento se quiere
limpiar.
