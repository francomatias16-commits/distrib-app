# v572 — Fase 7: `lib/repos/productos.js` lote 2 — `productos` queda cerrado salvo pedidos/pos

Continuación de `CHANGELOG_v571_fase7_productos_lote1.md`. Cierra la tabla
`productos` en `FASE7_PLAN_ARRANQUE.md` — solo queda pendiente en
`pedidos.js`/`pos.js`, reservado a propósito para el paso 6 grande del plan.

## Qué se hizo

- **`lib/repos/productos.js`** — 7 funciones nuevas:
  - `listarCodigosProductosPorEmpresa(empresa_id)` — unifica 5 apariciones
    idénticas en `migracion.js` (mismo select, mismo filtro) en una sola
    función
  - `listarProductosSinFoto(empresa_id, { limit, excluirIds })` — incluye
    el `.not()` condicional de exclusión de IDs ya intentados en la corrida
  - `actualizarFotoProducto(producto_id, { foto_url, foto_fuente })`
  - `contarProductosSinFoto(empresa_id)`
  - `buscarIdsProductos(empresa_id, term)` — ignora error igual que el
    query original (fallback a `[]`)
  - `perteneceProductoAEmpresa(producto_id, empresa_id)` — guard anti
    cross-tenant al cargar un lote de stock
  - `obtenerProductosParaSugerencias(empresa_id, ids)` — a diferencia del
    resto, propaga el `error` crudo sin envolver (el handler original
    loggeaba el objeto completo y respondía un 500 con mensaje propio; se
    replica ese comportamiento exacto)

- **3 handlers migrados a 0 `.from('productos')` directos:**
  - `migracion.js` — las 5 queries idénticas (mapeo de pedidos, clientes,
    proveedores y productos por código, en distintos pasos del wizard)
  - `auto-imagenes.js` — listado sin foto, update de foto resuelta, y
    conteo de restantes (los 3 usos del motor de auto-completado)
  - `stock.js` — búsqueda de IDs por texto (filtro de la vista de stock),
    guard de "producto pertenece a la empresa" al cargar un lote, y
    consulta para el motor de sugerencias de reposición

## Qué NO se tocó

`pedidos.js`/`pos.js` (7+7 usos) — quedan para el paso 6 grande del plan,
junto con la creación de `lib/repos/cta-cte.js` (paso 4, todavía sin
arrancar).

## Tests

- `tests/repos/productos.test.js` — ampliado de 14 a 31 casos. Cada test
  nuevo documenta en su descripción la política de error de la función que
  cubre (throw vs. silencioso vs. error crudo sin envolver), no solo el
  comportamiento — para que quede claro que las diferencias son a
  propósito, no inconsistencia.
- Suite completa: **143/143 OK** (13 archivos de test).
- `node --check` limpio en los 5 archivos tocados (repo + 3 handlers + test).
- Confirmado `grep -c ".from('productos')"` = 0 en `migracion.js`,
  `auto-imagenes.js` y `stock.js`.
