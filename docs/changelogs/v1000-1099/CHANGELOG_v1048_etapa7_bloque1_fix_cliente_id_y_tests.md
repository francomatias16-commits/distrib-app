# v1048 — Etapa 7 (Bloque 1, Devoluciones): fix crítico post-v1047 + tests reescritos

## Contexto

Continuación directa de v1047 (migración 570, fix de condición de carrera
en `crearDevolucionCore`). Al retomar la sesión para arreglar la suite de
tests que había quedado rota por ese cambio, aparecieron dos problemas
reales en el código de v1047 que los tests originales no detectaban
porque nunca se corrieron contra la implementación nueva.

## Hallazgo 1 (🔴 crítico) — `ReferenceError` en toda devolución exitosa

`lib/handlers/pedidos/devoluciones.js` quedó con:

```js
calcularScoreClienteRpc({ p_cliente_id: cliente_id, ... })
```

`cliente_id` nunca se declaró en el scope de `crearDevolucionCore` (la
desestructuración de `body` en la cabecera de la función no lo incluye).
Esto tira `ReferenceError` de forma síncrona, sin try/catch que lo
contenga, en **toda devolución creada con éxito** — después de que la RPC
ya hizo commit. Efecto: el alta queda grabada en la base, pero la request
entera revienta antes de notificar al admin y devolver el payload de
éxito al cliente/chofer que la creó.

**Fix**: `body.cliente_id` en las dos referencias (la llamada al RPC de
score y el log de error).

## Hallazgo 2 (🔴 crítico) — devoluciones del chofer rotas al 100%

La migración 570 movió la validación completa a
`rpc_crear_devolucion_validada`, pero al hacerlo se perdió la resolución
de `cliente_id` a partir de `pedido_id` que hacía la versión anterior de
`crearDevolucionCore` (vía `obtenerClienteIdDePedido`, que quedó
exportada en `lib/repos/pedidos.js` pero sin ningún caller — señal de que
algo dejó de usarla).

El body real que manda `frontend/chofer/chofer-offline.js` al crear una
devolución es `{ pedido_id, motivo, notas, foto_url, items,
offline_local_id }` — **nunca `cliente_id`**. Con la 570 tal cual quedó
aplicada, `crearDevolucionCore` mandaba `p_cliente_id: null` a la RPC, y
la RPC devolvía `'cliente_id requerido (directo o vía pedido_id)'` — un
mensaje que ya prometía la resolución "vía pedido_id" pero que nunca se
implementó. Resultado: **toda devolución creada desde la app del chofer
—el canal más usado— fallaba, sin excepción**, desde que se aplicó la
570 hasta este fix.

El alta manual del admin y la tool de voz de WhatsApp
(`lib/asistente-tools/pedidos.js`) no se vieron afectadas — ambas ya
mandan `cliente_id` explícito.

**Fix**: migración `571_fix_rpc_devolucion_resolver_cliente_id_de_pedido`
— `CREATE OR REPLACE` de la misma función, agregando la resolución de
`p_cliente_id` desde `pedidos.cliente_id` cuando viene null y hay
`p_pedido_id`, adentro de la transacción (cubierta por el mismo advisory
lock). No requiere cambios en JS.

## Tests reescritos

`tests/repos/crear-devolucion-core.test.js` y
`tests/repos/crear-devolucion-score-recalculo.test.js` mockeaban
`obtenerComprasPorProductoCliente`, `obtenerDevueltoPorProductoCliente`,
`crearDevolucion`, `insertarItemsDevolucion` — funciones que
`crearDevolucionCore` ya no llama desde la 570. Reescritos para mockear
`crearDevolucionValidadaRpc` en su lugar. El nuevo `crear-devolucion-core
.test.js` incluye un caso específico para el hallazgo 2 (payload del
canal chofer con `cliente_id: null` + `pedido_id`).

**⚠️ Gap de cobertura que queda documentado en el propio archivo de
test**: la aritmética de los 3 controles v805 (cantidad disponible,
producto-pertenece-al-pedido, resolución de precio) y la resolución de
`cliente_id` del hallazgo 2 ahora viven enteramente en SQL, dentro de la
RPC — un test unitario de JS con mocks no puede ejercitarlas. No hay
today ningún test (pgTAP o de integración) que las cubra directamente.
Si se rompen de nuevo, ningún test lo va a gritar.

## Verificación

Suite completa: **1347 tests / 88 archivos, 0 fallos** (`npx vitest run`).

## Pendiente (sin tocar en esta sesión)

- Aplicar la migración 571 al Supabase real (`jgiquzjwoedmzwqgzubr`) —
  la 570 ya está aplicada ahí; la 571 todavía no.
- Resto del Bloque 1: casos borde de "devolución sobre pedido con NC
  previa" desde el ángulo de facturación/ARCA.
- Pase manual en navegador real de todo el Bloque 1 (sigue pendiente
  desde v1047).
- Test de integración real (pgTAP o contra un Supabase de prueba) para
  `rpc_crear_devolucion_validada` — cierra el gap de cobertura señalado
  arriba.
