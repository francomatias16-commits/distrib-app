# v777 — Fix: creación de la caja (POS) del QR rechazada por MP (bad_request)

## Contexto
Segunda pata del flujo QR probado contra la cuenta dev real de MP. Con el
fix de v773 (coordenadas geocodificadas) la creación de la Store ya
funciona — pero el siguiente paso, crear la caja (POS) dentro de esa
Store, seguía devolviendo `bad_request` de Mercado Pago.

Confirmado contra la documentación oficial de "Crear caja"
(`POST /pos`), se encontraron dos bugs reales en `posQrSetupHandler`
(`lib/handlers/pagos.js`, `_svc=pos-qr-setup`):

### Bug 1 — `external_id` de la caja con guiones
El body mandaba `external_id: _externalPosId(empresa_id)`, y
`_externalPosId` armaba el string como `` `distrib-${empresa_id}-pos` ``.
Como `empresa_id` es un UUID (que ya trae guiones de por sí), el resultado
tenía varios guiones. La doc de MP es explícita: el `EXTERNAL_ID` de la
caja "debe ser alfanumérico, solo letras y números. Sin espacios, guiones
o caracteres especiales" — a diferencia del `external_id` de la Store, que
sí los acepta (por eso ese paso nunca había fallado).

**Fix:** `_externalPosId` ahora le saca todo lo que no sea alfanumérico al
`empresa_id` antes de armar el string (`distribpos<uuid-sin-guiones>`).
No se tocó `_externalStoreId` — ese sigue igual porque ya matchea el
`external_id` real de las Stores creadas en producción antes de este fix
(cambiarlo rompería el `external_store_id` de esas cuentas).

### Bug 2 — `store_id` viajaba como string, no numérico
`storeId` se guarda como `String(store.id)` (así queda en
`integraciones_pago.store_id`), pero se mandaba tal cual en el body del
`POST /pos`. La doc también es explícita acá: `STORE_ID` debe ser
numérico. Al viajar como string dentro del JSON (`"store_id": "12345"` en
vez de `"store_id": 12345`), MP también lo puede rechazar.

**Fix:** cast a `Number(storeId)` solo al armar el payload — se sigue
guardando como string en la base como antes (sin cambios de schema).

## Pendiente
- Falta confirmar contra la cuenta dev real que ambos fixes juntos
  dejan pasar la creación de la caja (sin salida de red hacia
  `api.mercadopago.com` desde este entorno).
- Sigue pendiente el resto del flujo: cobrar con el QR fijo
  (`_svc=pos-qr-cobrar`, línea ~933) y Checkout Pro end-to-end.
