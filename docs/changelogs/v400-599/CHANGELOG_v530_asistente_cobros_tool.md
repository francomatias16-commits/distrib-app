# v530 — Nueva tool `listar_cobros` (sin conectar al asistente)

## Reportado

Continuando la revisión del catálogo de tools del asistente contra las
tablas centrales del sistema (mismo criterio que v526-v529), se
detectó que `cobros` (con su detalle de aplicación a facturas en
`cobro_facturas_aplicadas`) se usa activamente en el sistema pero el
asistente no tenía ninguna forma de consultarla. Ante una pregunta como
"qué cobros hicimos esta semana" o "cuánto cobramos de tal cliente", no
había tool que devolviera ese dato.

## Diagnóstico

Igual que `ordenes_compra`/`movimientos_caja`/`conteos_stock`, `cobros`
tiene `empresa_id` propio, así que el scope es directo. Se verificó el
schema real contra la base antes de escribir la migración: no hay
`CHECK` constraint sobre `medio` (texto libre, ej. efectivo,
transferencia, cheque), y — punto importante — `clientes` **no** tiene
columna `nombre` (tiene `razon_social` y `nombre_fantasia`, el mismo
patrón que ya se había detectado en `proveedores` durante v527); se
resolvió con el mismo `COALESCE(nombre_fantasia, razon_social)`.

A diferencia de las tools anteriores de esta línea de trabajo, esta vez
sí había datos reales para probar: 2 cobros reales en el tenant demo
(Distribuidora del Litoral S.A. / cliente "EL COTYLLON"). El detalle de
facturas aplicadas (`cobro_facturas_aplicadas`) sí está vacío en toda
la base, así que esa parte de la lógica (subquery de agregación) se
validó insertando temporalmente un vínculo cobro-factura de prueba
sobre uno de los cobros reales existentes, y borrándolo apenas
confirmado.

## Cambios

### `supabase/migrations/427_asistente_cobros.sql`

- Nueva RPC `listar_cobros(p_empresa_id, p_cliente, p_medio, p_dias)`:
  - `SECURITY DEFINER`, `STABLE`, `search_path` fijado a `public`.
  - Scopeada directo por `cobros.empresa_id` (sin join intermedio,
    mismo criterio que v527-v529).
  - Filtros opcionales por nombre de cliente (`ILIKE` sobre
    `COALESCE(nombre_fantasia, razon_social)`) y por medio de pago
    exacto.
  - Cada cobro incluye un array `facturas_aplicadas` (subquery a
    `cobro_facturas_aplicadas` + join a `facturas` por número) con el
    detalle de a qué facturas se aplicó y por qué monto.
  - Ventana de días configurable (`p_dias`, default 30 al nivel de la
    tool, tope 180).
  - Devuelve `monto_total` sobre **todo** el período filtrado, no solo
    las filas mostradas — mismo criterio que los totales de
    `listar_movimientos_caja`/`listar_conteos_stock`.
  - Cap de 20 filas mostradas (`cobros_mostrados`), pero `total_cobros`
    devuelve el conteo real sin cap.
  - Grants: `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`,
    con el `REVOKE` explícito de `anon`/`authenticated` incluido **en
    la misma migración** (mismo criterio que v527-v529, sin fix
    aparte).

### `lib/asistente-tools.js`

- Nueva tool `listar_cobros`, ubicada junto al cluster de tools de
  clientes/cobranzas (después de `consultar_score_cliente`).
  - `roles: ['dueno', 'admin', 'contador']` — mismos roles que tienen
    acceso habitual a información de cobranzas.
  - Parámetros opcionales: `cliente` (texto libre), `medio` (texto
    libre), `dias` (default 30, tope 180 desde la tool).
  - `execute()` llama directo a la RPC `listar_cobros` vía
    `db.rpc(...)`.

## Verificación

Migración 427 aplicada contra el proyecto de producción
(`jgiquzjwoedmzwqgzubr`). Se confirmó:

- La función existe con la firma esperada y solo `service_role` tiene
  `EXECUTE` (`anon`/`authenticated` sin acceso, confirmado en la misma
  migración sin necesidad de fix posterior).
- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`.
- Prueba funcional real: devolvió los 2 cobros reales del tenant demo
  (cliente "EL COTYLLON", $5.000 y $3.200), con `monto_total: 8200`
  correcto.
- Prueba de la subquery `facturas_aplicadas`: se insertó temporalmente
  un vínculo cobro-factura sobre un cobro real existente ($2.500
  aplicados); la RPC lo reflejó correctamente en el array anidado; se
  borró el vínculo de prueba inmediatamente después.
- Prueba de filtro por cliente: `cliente='cotyllon'` (minúsculas)
  devolvió los 2 de 2 cobros — confirma que el `ILIKE` es
  case-insensitive como se esperaba.

## Cómo queda

El asistente ahora puede responder consultas sobre el historial de
cobros a clientes, filtrando por cliente y/o medio de pago, con el
detalle de a qué facturas se aplicó cada cobro y el monto total del
período filtrado, aclarando cuando hay más cobros de los que se
muestran (`total_cobros` vs `cobros_mostrados`).

## Archivos modificados

- `supabase/migrations/427_asistente_cobros.sql` (nuevo)
- `lib/asistente-tools.js`
