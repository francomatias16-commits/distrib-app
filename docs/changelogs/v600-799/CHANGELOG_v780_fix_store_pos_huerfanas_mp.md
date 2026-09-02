# v780 — Fix: recuperación de Store/Caja "huérfana" en el setup de QR de MP

## Motivo
Diagnóstico continuado de la sesión de v779: con state_name ya
normalizado, un segundo tipo de fallo silencioso quedaba posible en
`posQrSetupHandler` (`lib/handlers/pagos.js`).

`_externalStoreId(empresa_id)` y `_externalPosId(empresa_id)` son
deterministas — se derivan siempre del mismo `empresa_id`, nunca se
guardan tal cual en la BD (ver comentario ya existente arriba de
esas funciones). Eso es correcto para no desincronizar lo guardado
de lo real, pero tiene una consecuencia no contemplada: si el POST a
MP para crear la Store (o la Caja) tiene éxito, pero la request se
cae *después* — timeout, deploy a mitad de camino, corte de red —
antes de llegar a `guardarStoreYPosQr`, la fila en `integraciones_pago`
queda sin `store_id`/`pos_id`. Del lado de MP, en cambio, el recurso
con ese `external_id` ya existe.

Un reintento del usuario (que es la reacción natural ante un error)
volvía a ejecutar el POST con el mismo `external_id` — y MP lo
rechazaba (`Ya existe un punto de venta/sucursal con el mismo
EXTERNAL_ID`), pero como ese caso no tenía manejo particular, caía en
el mismo mensaje genérico de "MP rechazó los datos" ya mejorado en
v779, dejando al usuario sin forma de avanzar salvo tocar la BD a
mano (`integraciones_pago.store_id`/`pos_id`) desde Supabase.

## Investigación
Confirmado contra la doc oficial de MP que existen endpoints de
búsqueda por `external_id` para ambos recursos:
- `GET /users/{user_id}/stores/search?external_id=...` (Buscar en
  sucursales) — devuelve `[{ paging, results: [...] }]` (nótese el
  array envolvente de un elemento, así lo documenta MP).
- `GET /pos?external_id=...` (Buscar en cajas) — devuelve
  `{ paging, results: [...] }`, sin el envoltorio extra.

## Cambios (`lib/handlers/pagos.js`)
- Nuevas funciones `_buscarStorePorExternalId` y
  `_buscarPosPorExternalId`, ambas sobre `withRetry(fetchMP(...))`
  como el resto del módulo.
- `posQrSetupHandler`: antes de cada POST de creación (Store y luego
  Caja), primero se busca por `external_id`. Si MP ya tiene el
  recurso, se reusa (`storeId`/`posId` + `qr_image` salen de la
  búsqueda) y se guarda en la BD sin intentar crearlo de nuevo — el
  bloque de creación original queda intacto como rama `else`, sin
  cambios de comportamiento para el caso normal (primera vez, sin
  desync).
- Si la búsqueda misma falla (red, MP caído), se loguea y se sigue al
  flujo normal de creación — no bloquea el caso feliz por un fallo en
  la recuperación.

## Sin confirmar todavía
No se pudo probar contra la cuenta dev real (sin salida de red hacia
`api.mercadopago.com` desde este sandbox) — falta validar en
producción/dev que el `external_id` duplicado efectivamente
desaparece como causa de fallo, y confirmar el shape exacto de la
respuesta de `stores/search` (el array envolvente documentado es
inusual; el código lo soporta pero también contempla el objeto
pelado por si ese detalle cambiara).
