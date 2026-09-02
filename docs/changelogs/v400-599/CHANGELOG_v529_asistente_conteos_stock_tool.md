# v529 — Nueva tool `listar_conteos_stock` (sin conectar al asistente)

## Reportado

Continuando la revisión del catálogo de tools del asistente contra las
tablas centrales del sistema (mismo criterio que v526/v527/v528), se
detectó que `conteos_stock` (conteos físicos de inventario, cantidad de
sistema vs cantidad contada) se usa en la operación de depósito pero el
asistente no tenía ninguna forma de consultarla. Ante una pregunta como
"hubo faltantes en el último inventario" o "qué diferencias dio el
conteo de tal producto", no había tool que devolviera ese dato.

## Diagnóstico

Igual que `ordenes_compra` (v527) y `movimientos_caja` (v528),
`conteos_stock` tiene `empresa_id` propio, así que el scope es directo
sin join intermedio. Se verificó el schema real contra la base antes de
escribir la migración: no hay `CHECK` constraint sobre `motivo` (texto
libre), y los joins a `productos`/`depositos`/`usuarios` usan `nombre`
directo en los tres casos (sin necesidad de `COALESCE` como en
`proveedores`).

Nota operativa: al momento de esta migración la tabla `conteos_stock`
también está vacía en producción (0 filas en cualquier empresa) —
mismo patrón que `movimientos_caja` en v528, ningún tenant registró
todavía un conteo físico de inventario. La prueba funcional se hizo con
2 filas insertadas temporalmente en el tenant demo (Distribuidora del
Litoral S.A.) y borradas inmediatamente después de validar.

## Cambios

### `supabase/migrations/426_asistente_conteos_stock.sql`

- Nueva RPC `listar_conteos_stock(p_empresa_id, p_producto, p_solo_con_dif, p_dias)`:
  - `SECURITY DEFINER`, `STABLE`, `search_path` fijado a `public`.
  - Scopeada directo por `conteos_stock.empresa_id` (sin join
    intermedio, mismo criterio que v527/v528).
  - Filtros opcionales por nombre de producto (`ILIKE`) y por
    `solo_con_dif` (booleano, muestra solo conteos donde
    `cantidad_contada <> cantidad_sistema`).
  - Ventana de días configurable (`p_dias`, default 30 al nivel de la
    tool, tope 180).
  - Devuelve `total_con_diferencia` y `suma_diferencias` sobre **todo**
    el período filtrado, no solo sobre las filas mostradas — mismo
    criterio que los totales por tipo de `listar_movimientos_caja`
    (v528).
  - Cap de 20 filas mostradas (`conteos_mostrados`), pero
    `total_conteos` devuelve el conteo real sin cap.
  - Grants: `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`,
    con el `REVOKE` explícito de `anon`/`authenticated` incluido **en
    la misma migración** (mismo criterio que v527/v528, sin fix
    aparte).

### `lib/asistente-tools.js`

- Nueva tool `listar_conteos_stock`, ubicada junto al cluster de tools
  de stock/depósito (después de `listar_movimientos_stock`).
  - `roles: ['dueno', 'admin', 'depositero']` — mismos roles que
    `listar_movimientos_stock`, ya que ambas tools son parte de la
    operación normal de depósito.
  - Parámetros opcionales: `producto` (texto libre),
    `soloConDiferencia` (booleano, default false), `dias` (default 30,
    tope 180 desde la tool).
  - `execute()` llama directo a la RPC `listar_conteos_stock` vía
    `db.rpc(...)`.

## Verificación

Migración 426 aplicada contra el proyecto de producción
(`jgiquzjwoedmzwqgzubr`). Se confirmó:

- La función existe con la firma esperada y solo `service_role` tiene
  `EXECUTE` (`anon`/`authenticated` sin acceso, confirmado en la misma
  migración sin necesidad de fix posterior).
- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`.
- Prueba funcional: se insertaron 2 conteos de prueba (uno con
  diferencia de -5 unidades por faltante, uno sin diferencia) en el
  tenant demo, ligados a productos y usuario reales (Marina Torres). La
  RPC devolvió ambas filas con producto, código, depósito y usuario
  resueltos correctamente, `suma_diferencias: -5` y
  `total_con_diferencia: 1`.
- Prueba de filtro `solo_con_dif=true`: devolvió 1 de 2 filas (la que
  tenía diferencia), con los totales recalculados correctamente sobre
  el subconjunto filtrado.
- Filas de prueba borradas inmediatamente después de validar (no queda
  data sintética en producción).

## Cómo queda

El asistente ahora puede responder consultas sobre el historial de
conteos físicos de inventario, filtrando por producto y/o mostrando
solo los que tuvieron diferencia, con la suma total de diferencias del
período y aclarando cuando hay más conteos de los que se muestran
(`total_conteos` vs `conteos_mostrados`). Al no haber datos reales aún
en producción, el asistente devolverá listas vacías hasta que algún
tenant registre su primer conteo físico.

## Archivos modificados

- `supabase/migrations/426_asistente_conteos_stock.sql` (nuevo)
- `lib/asistente-tools.js`
