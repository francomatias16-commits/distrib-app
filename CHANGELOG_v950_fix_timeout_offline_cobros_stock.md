# v950 — Fix timeout no encolaba (cobros/stock) + dedup real por offline_local_id

Continuación de la auditoría pre-lanzamiento, etapa 2 (Pedidos + Facturación
AFIP/ARCA + Cobros/cta-cte), revisando el módulo Cobros/cta-cte
(`lib/handlers/pagos.js` / `frontend/admin/js/cta-cte.js`) y arrastrando el
mismo hallazgo a Stock (`frontend/admin/js/stock.js`), que comparte
exactamente el mismo patrón online→offline.

## Hallazgo 1 — el timeout de `conTimeoutRed` no se encolaba

Patrón usado en `guardarCobro()` (cta-cte.js) y en las tres ramas de
`guardarMovimiento()` (stock.js: transferencia, conteo, ajuste):

```js
const { data, error } = await window.conTimeoutRed(sb.rpc(...), 10000);
if (error) {
  if (esErrorDeRed(error) && window.XOffline) { /* encolar */ }
  throw error;
}
```

`esErrorDeRed()` distingue "error de negocio del servidor" (mostrarlo tal
cual) de "la llamada nunca llegó a completarse" (encolar y reintentar solo).
El comentario original decía, correctamente, que un corte de red real
(TypeError de fetch) postgrest-js lo atrapa y lo devuelve **resuelto** como
`error` — no tira. Pero `conTimeoutRed` tiene una segunda forma de fallar
que ese razonamiento no cubría: **su propio timeout** (10s) sí **rechaza**
la promesa con `Error('timeout')` — es Promise.race contra un
`setTimeout(...reject...)` propio, no depende de postgrest-js.

Como el rechazo pasaba de largo el `const { data, error } = await ...` (el
`await` tira ahí mismo), el `if (error)` nunca se ejecutaba para un timeout:
la excepción caía directo en el catch general de la función, que solo
muestra un toast genérico. Es decir, exactamente el escenario que
`conTimeoutRed` fue creado para cubrir (4G con señal débil, request que
tarda más de 10s en responder aunque el navegador siga "conectado") era el
único que **no** quedaba protegido por la cola offline — el cobro o el
movimiento de stock se perdía sin dejar ningún rastro local.

Además, `esErrorDeRed()` tampoco reconocía el mensaje `'timeout'` en su
regex (`/failed to fetch|network/i`), así que aunque se hubiera capturado la
excepción, igual no calificaba como error de red.

**Fix:** se agregó `timeout` al regex de `esErrorDeRed()` en ambos archivos,
y se envolvió cada llamada `conTimeoutRed(sb.rpc(...))` en su propio
try/catch para capturar también el rechazo por timeout y tratarlo igual que
un corte de red (encolar).

## Hallazgo 2 — al arreglar el 1, aparece un riesgo de duplicar plata/stock

Un timeout no significa "no se aplicó" — significa "no sabemos si se
aplicó" (la request pudo llegar al servidor y ejecutarse; solo se perdió la
respuesta). Antes de este fix, si el timeout terminaba encolado,
`CobrosOffline`/`StockOffline` (vía `OfflineCore.crearOutbox().encolarAccion()`)
generaba un `offline_local_id` **nuevo** con `crypto.randomUUID()` en el
momento de encolar — sin ninguna relación con el intento online que acababa
de fallar.

`registrar_cobro_completo` / `ajustar_stock` / `transferir_stock` /
`registrar_conteo_stock` deduplican por `offline_local_id` (índices únicos
de las migraciones 443/446/454), pero solo si el mismo id se repite. Con un
id distinto en el reintento, un timeout que en realidad ya se había
aplicado en el servidor terminaba **duplicado de verdad**: doble cobro en
`cta_cte`, doble movimiento en `movimientos_stock`.

**Fix:** el `offline_local_id` ahora se genera **antes** del primer intento
online (no solo al encolar) y viaja ya en el payload de ese intento directo
(`p_offline_local_id`). Si hay que encolar (por corte de red o por timeout),
se reusa exactamente ese mismo id — `OfflineCore.encolarAccion(tipo, payload, offlineLocalId)`
ahora acepta un tercer parámetro opcional para esto (retrocompatible: los
demás módulos que la llaman con 2 argumentos siguen generando el id como
antes). Con el mismo id en los dos intentos, el propio RPC dedupea y
devuelve el resultado ya existente en vez de crear uno nuevo.

## Archivos tocados

- `frontend/shared/offline-core.js` — `encolarAccion()` acepta `offlineLocalId` opcional.
- `frontend/admin/js/cta-cte.js` — `guardarCobro()`: id generado antes del intento online, try/catch del timeout, `esErrorDeRed` con `timeout`.
- `frontend/admin/js/stock.js` — mismo fix en las 3 ramas (transferencia, conteo, ajuste).

## Pendiente / no cubierto en este pase

- No se tocó `producir_con_insumos` (rama "ingreso con receta" de
  `guardarMovimiento()`): esa rama no tiene cola offline (`if (error) throw error;`
  directo, sin `esErrorDeRed`), así que no comparte el bug de este
  changelog. Si se le quiere agregar soporte offline en el futuro, debería
  nacer ya con el patrón "id antes del intento" de este fix, no con el
  patrón viejo.
- No se hizo la prueba end-to-end real con dos dispositivos y corte de red
  físico (mismo pendiente que quedó documentado en v584 para la terminal
  Prisma) — la corrección está verificada por lectura de código y coincide
  con el mecanismo de dedup ya probado de las migraciones 443/446/454, pero
  no se ejecutó en vivo.
