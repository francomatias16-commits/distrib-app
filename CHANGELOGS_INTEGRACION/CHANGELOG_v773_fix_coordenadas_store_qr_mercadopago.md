# v773 — Fix: creación de Store del QR (POS) rechazada por coordenadas (0,0)

## Bug encontrado probando contra una cuenta dev real (primera vez que se
## prueba el flujo de QR con una cuenta de MP de verdad)

`posQrSetupHandler` (`lib/handlers/pagos.js`, `_svc=pos-qr-setup`) mandaba
`latitude`/`longitude` en `0` cuando no venían en el body — y el formulario
de `mercadopago-config.html` no pide esos campos, así que siempre se
mandaba `(0, 0)`. Confirmado contra la documentación oficial de MP: la API
de Stores devuelve `bad_request: "Store coordinates (latitude 0 and
longitude 0) are invalid"` — `(0,0)` cae en medio del océano Atlántico y MP
lo rechaza siempre.

Efecto real: la sección "Cobro con QR en caja" no se podía activar nunca,
para ninguna empresa, con cualquier dirección que se cargara — el error
genérico ("Mercado Pago rechazó los datos de la sucursal") no daba pista
de que el problema era las coordenadas, no la dirección en sí.

### Fix
`posQrSetupHandler` ahora geocodifica `calle + numero / ciudad / provincia`
con `geocodificarDireccion()` (`lib/geocoding.js`, el mismo motor que ya
usa "Geocodificar pendientes" en Clientes, sobre Nominatim/OpenStreetMap)
antes de armar el payload de la Store, y usa esas coordenadas reales en vez
del default `(0,0)`. Si la geocodificación falla o no encuentra resultados,
devuelve un error explícito ("No se pudo ubicar esa dirección") en vez de
mandarle `(0,0)` a MP igual.

No se tocó el formulario del frontend — el usuario sigue cargando solo
nombre/calle/ciudad/provincia, sin campos nuevos.

## Pendiente
- Falta probar el `posQrSetupHandler` corregido contra la cuenta dev real
  (no se pudo ejecutar desde este entorno — sin salida de red hacia
  `api.mercadopago.com`).
- Sigue pendiente probar Checkout Pro end-to-end (creación de preferencia +
  webhook con el fix de `mp_user_id` de v772) contra la misma cuenta dev.
