# v571 — Fase 7, paso 3: `lib/repos/productos.js` (lote 1, 6 handlers)

Continuación de Fase 7 (`FASE7_PLAN_ARRANQUE.md`) tras cerrar `clientes` y
`empresas`. Al relevar el estado real del repo, el conteo original del plan
para este paso ("13 usos en `maestros.js`") no coincidía con el código:
`maestros.js` no toca `productos` directamente. El volumen real está
repartido en 11 handlers distintos. Se prioriza este primer lote por ser el
de menor volumen y riesgo (lecturas simples, ninguno en el camino crítico
de pedidos/pos/stock).

## Qué se hizo

- **`lib/repos/productos.js` (nuevo)** — 6 funciones, una por patrón de uso
  real encontrado:
  - `existeProductoParaEmpresa(empresa_id)` → boolean
  - `listarProductosConStockMinimo(empresa_id)` → array
  - `buscarProductos(empresa_id, { like, limit })` → array
  - `obtenerProductosPorIds(ids)` → array
  - `obtenerCostosPorIds(ids)` → array
  - `obtenerProductosParaCotizarPedido(empresa_id, ids)` → array (o
    `undefined` si la query falla — comportamiento replicado tal cual del
    handler original en `notif.js`, que ignoraba `error` y dejaba que el
    chequeo de longitud contra los IDs pedidos hiciera de guard)

- **6 handlers migrados a 0 `.from('productos')` directos:**
  - `admin.js` — checklist de onboarding (`tiene_productos`)
  - `automatizacion.js` — motor de stock autónomo (productos con
    `stock_minimo` configurado)
  - `busqueda.js` — búsqueda global del header admin. Cambio de contrato
    interno: `productos` pasa de `{ data, error }` a array plano (mismo
    patrón que ya expone `buscarProductos`); la respuesta HTTP no cambia
  - `notif.js` — solo `crearPedidoDesdeItemsWhatsapp` (el resto de los 74
    `.from()` de este handler sigue pendiente, no es parte de este lote)
  - `proveedores.js` — detalle de productos recepcionados (historial de OC)
  - `stock-auto.js` — costos para armar líneas de OC sugerida

## Qué NO se tocó (a propósito)

`migracion.js` (5 usos), `auto-imagenes.js` (3), `stock.js` (3) quedan para
un próximo lote. `pedidos.js`/`pos.js` (7+7) se dejan para el paso 6 grande
del plan, junto con la creación de `lib/repos/cta-cte.js` (paso 4).

## Tests

- `tests/repos/productos.test.js` (nuevo, 14 casos) — foco en aislamiento
  por `empresa_id` (checklist punto 5 de Fase 7).
- `tests/handlers/whatsapp-pedido-borrador.test.js` — actualizado: además
  del mock existente de `crearClienteSupabaseLazy`, se agregó un mock de
  `lib/repos/_db.js` (mismo router por nombre de tabla) para interceptar
  `obtenerProductosParaCotizarPedido`.
- Suite completa: **126/126 OK** (13 archivos de test).
- `node --check` limpio en los 7 archivos tocados (repo nuevo + 6 handlers).
- Confirmado `grep -c ".from('productos')"` = 0 en los 6 handlers migrados.
