# CHANGELOG v789 — Fix real: QR de Mercado Pago rechaza montos < $15

## Causa raíz (confirmada vía logs de Vercel, correlation_id `a854d7b8-537e-4eb1-97bf-04dac00262a5`)

```
property_value: "Invalid value for property"
details: "Amount must be greater than or equal to 15.00"
```

Mercado Pago exige un monto mínimo de **$15** para crear una orden QR
(`POST /v1/orders`). No es un problema de configuración de la
integración ni del `external_pos_id` — es una regla fija de la Orders
API. La venta que falló era de $12, por eso rebotaba siempre, sin
relación con el fix de búsqueda (v787) ni con `unit_measure`.

## Cambio
`lib/handlers/pagos.js` (`posQrCobrarHandler`): se valida `monto >= 15`
**antes** de llamar a Mercado Pago. Si no cumple, devuelve 400 con un
mensaje claro en vez de dejar que la llamada a MP falle con 502
genérico:

> "Mercado Pago no permite cobrar con QR montos menores a $15. Usá otro
> medio de pago para esta venta."

## Contexto
Este es el fix definitivo de la cadena de trabajo v787→v788→v789:
- v787: arregló el buscador de productos del POS.
- v788: agregó `correlation_id` al error genérico de QR para poder
  diagnosticar (era puramente de observabilidad).
- v789 (este): con el `correlation_id` real se identificó la causa
  exacta y se corrigió.

## Pendiente / sugerido (no incluido en este cambio)
Podría agregarse en el frontend (`pos-terminal.js`) una advertencia o
deshabilitar el botón "QR" cuando el total a cobrar sea menor a $15,
para que el cajero ni intente esa opción. No se implementó acá para
mantener el cambio acotado — avisar si se quiere sumar.
