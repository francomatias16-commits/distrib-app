# v781 — Fix: external_id de la Caja excedía el límite de largo de MP

## Motivo
Con los fixes de v777 (STORE_ID numérico) y v779 (state_name
normalizado) el flujo llegó por primera vez hasta el POST real de
"Crear caja" en producción, y ahí apareció un tercer bug, tapado
hasta ahora porque nunca se había llegado tan lejos: MP lo rechazó
con `external_id is too long`.

## Causa
La doc de "Crear caja" especifica que el EXTERNAL_ID debe ser menor
de 40 caracteres (a diferencia del external_id de la Store, que
acepta hasta 60). `_externalPosId` arma el external_id como
`distribpos` + el UUID de `empresa_id` sin guiones (32 caracteres) =
**42 caracteres** — por encima del límite.

## Fix (`lib/handlers/pagos.js`)
`_externalPosId` acorta el prefijo de `distribpos` a `dpos`, dejando
el external_id en 36 caracteres (4 + 32), con margen. No se tocó
`_externalStoreId` (mismo criterio que en v777: sigue siendo válido
y ya tiene Stores reales creadas en producción con ese formato).

Cambiar el prefijo de la Caja es seguro porque, por el bug de v777
(STORE_ID viajando como string), ninguna Caja había llegado a
crearse con éxito en producción todavía — no hay ningún external_id
viejo con el prefijo `distribpos` que este cambio pueda dejar
huérfano o desincronizado.

## Sin confirmar todavía
Sigue pendiente la prueba end-to-end contra la cuenta dev real (sin
salida de red hacia `api.mercadopago.com` desde el sandbox) — con
este fix debería crear la caja y devolver el QR fijo.
