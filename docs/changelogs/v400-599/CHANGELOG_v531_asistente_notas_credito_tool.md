# v531 — Nueva tool `listar_notas_credito` (sin conectar al asistente)

## Reportado

Último candidato de la lista original (v526-v530): se detectó que el
asistente ya tiene una tool que **emite** notas de crédito
(generación automática ligada a la cancelación de pedidos con
factura emitida, ver `cancelar_pedido_asistente`), pero no tenía
ninguna forma de **consultar** el historial de notas de crédito ya
emitidas. Ante una pregunta como "qué notas de crédito emitimos esta
semana" o "hay alguna nota de crédito con error de AFIP", no había
tool que devolviera ese dato.

## Diagnóstico

Igual que `cobros` (v530), `notas_credito` tiene `empresa_id` propio,
así que el scope es directo. Se verificó el schema real contra la base
antes de escribir la migración: `estado` está restringido por
constraint a `pendiente` / `emitida` / `aplicada` / `anulada` /
`error_afip`, y `tipo` a `A` / `B` / `C` / `M` (letra de comprobante
AFIP). Mismo patrón que v527/v530: `clientes` no tiene columna
`nombre`, se resuelve con `COALESCE(nombre_fantasia, razon_social)`.
Se agregó además un join opcional a `facturas` para mostrar el número
de la factura original que la nota de crédito anula.

Nota operativa: al momento de esta migración la tabla `notas_credito`
también está vacía en producción (0 filas en cualquier empresa) —
mismo patrón que `movimientos_caja` (v528) y `conteos_stock` (v529).
La prueba funcional se hizo con 2 filas insertadas temporalmente en el
tenant demo (Distribuidora del Litoral S.A.) — una `emitida` y una
`error_afip`, para validar también que el campo `notas_error` se
expone correctamente — y borradas inmediatamente después de validar.

## Cambios

### `supabase/migrations/428_asistente_notas_credito.sql`

- Nueva RPC `listar_notas_credito(p_empresa_id, p_cliente, p_estado, p_dias)`:
  - `SECURITY DEFINER`, `STABLE`, `search_path` fijado a `public`.
  - Scopeada directo por `notas_credito.empresa_id` (sin join
    intermedio, mismo criterio que v527-v530).
  - Filtros opcionales por nombre de cliente (`ILIKE` sobre
    `COALESCE(nombre_fantasia, razon_social)`) y por estado exacto.
  - Join `LEFT` a `facturas` para mostrar `factura_original` (número
    de la factura que la nota de crédito anula, si corresponde).
  - Ventana de días configurable (`p_dias`, default 30 al nivel de la
    tool, tope 180).
  - Devuelve `monto_total` sobre **todo** el período filtrado, no solo
    las filas mostradas — mismo criterio que `listar_cobros` (v530).
  - Cap de 20 filas mostradas (`notas_mostradas`), pero `total_notas`
    devuelve el conteo real sin cap.
  - Grants: `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`,
    con el `REVOKE` explícito de `anon`/`authenticated` incluido **en
    la misma migración** (mismo criterio que v527-v530, sin fix
    aparte).

### `lib/asistente-tools.js`

- Nueva tool `listar_notas_credito`, ubicada junto al cluster de tools
  de clientes/facturación (después de `listar_cobros`, no dentro del
  bloque de `cancelar_pedido_asistente` que solo emite notas de
  crédito como efecto secundario).
  - `roles: ['dueno', 'admin', 'contador']` — mismos roles que
    `listar_cobros`.
  - Parámetros opcionales: `cliente` (texto libre), `estado`
    (pendiente / emitida / aplicada / anulada / error_afip), `dias`
    (default 30, tope 180 desde la tool).
  - `execute()` llama directo a la RPC `listar_notas_credito` vía
    `db.rpc(...)`.

## Verificación

Migración 428 aplicada contra el proyecto de producción
(`jgiquzjwoedmzwqgzubr`). Se confirmó:

- La función existe con la firma esperada y solo `service_role` tiene
  `EXECUTE` (`anon`/`authenticated` sin acceso, confirmado en la misma
  migración sin necesidad de fix posterior).
- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`.
- Prueba funcional: se insertaron 2 notas de crédito de prueba (una
  `emitida` por $1.210, una `error_afip` por $605 con
  `notas_error: 'CAE rechazado por AFIP: timeout'`) en el tenant demo.
  La RPC devolvió ambas con cliente resuelto ("Distribuidora Sur
  Litoral SA"), `monto_total: 1815` correcto, y el mensaje de error
  AFIP visible en la fila correspondiente.
- Prueba de filtro por estado: `estado='error_afip'` devolvió 1 de 2
  notas, con `monto_total` recalculado a 605 sobre el subconjunto
  filtrado.
- Filas de prueba borradas inmediatamente después de validar (no queda
  data sintética en producción).

## Cómo queda

El asistente ahora puede responder consultas sobre el historial de
notas de crédito emitidas a clientes, filtrando por cliente y/o
estado, con el monto total del período y el número de factura original
cuando corresponde, aclarando cuando hay más notas de las que se
muestran (`total_notas` vs `notas_mostradas`). Al no haber datos reales
aún en producción, el asistente devolverá listas vacías hasta que se
emita la primera nota de crédito real.

Con esta tool se cierra la lista original de candidatos detectados en
esta auditoría (movimientos_stock, ordenes_compra, movimientos_caja,
conteos_stock, cobros, notas_credito) — las 6 tablas de negocio que se
usaban activamente en la aplicación pero no tenían tool de consulta
para el asistente ahora la tienen.

## Archivos modificados

- `supabase/migrations/428_asistente_notas_credito.sql` (nuevo)
- `lib/asistente-tools.js`
