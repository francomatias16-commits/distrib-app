# v526 — Nueva tool `listar_movimientos_stock` (kardex sin conectar al asistente)

## Reportado

Revisando el catálogo de tools del asistente en relación a las tablas
que usa el resto del sistema, se detectó que `movimientos_stock` (el
kardex de ingresos, egresos, ajustes, transferencias, reservas y
liberaciones de stock) se usa en varios handlers de la aplicación, pero
el asistente no tenía ninguna forma de consultarla. Ante una pregunta
como "qué movimientos de stock hubo esta semana" o "pasame el kardex
del depósito", no había tool que devolviera ese dato.

## Diagnóstico

La tabla y la lógica de negocio ya existían y estaban en uso normal del
sistema — no era un bug, era una tool que nunca se construyó para el
asistente. `movimientos_stock` no tiene `empresa_id` propio: el scope
por empresa se resuelve vía `deposito_id -> depositos.empresa_id`, igual
que otras consultas del sistema que tocan esta tabla.

## Cambios

### `supabase/migrations/423_asistente_movimientos_stock.sql`

- Nueva RPC `listar_movimientos_stock(p_empresa_id, p_producto, p_tipo, p_dias)`:
  - `SECURITY DEFINER`, `STABLE`, `search_path` fijado a `public`.
  - Scopeada por empresa vía `depositos.empresa_id` (join contra
    `movimientos_stock.deposito_id`).
  - Filtros opcionales por nombre de producto (`ILIKE`) y por tipo de
    movimiento exacto.
  - Ventana de días configurable (`p_dias`, default 7 al nivel de la
    tool).
  - Cap de 20 filas mostradas (`movimientos_mostrados`), pero
    `total_movimientos` devuelve el conteo real sin cap, mismo criterio
    que el resto de las tools de lectura del asistente.
  - Grants: `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`
    únicamente — mismo patrón que el resto del catálogo.

### `supabase/migrations/423b_fix_revoke_anon_authenticated_listar_movimientos_stock.sql`

- Este proyecto tiene *default privileges* que auto-otorgan `EXECUTE`
  a `anon` y `authenticated` en funciones nuevas del schema `public`
  (el mismo problema que motivó `197_revoke_execute_public_secdef` y
  otras migraciones de hardening del historial). El `REVOKE ALL FROM
  PUBLIC` de la 423 no alcanza a cubrir eso.
- Se revoca `EXECUTE` explícitamente de `anon` y `authenticated`, para
  que la función quede accesible únicamente por `service_role`.
- Verificado post-aplicación contra la base real: solo `service_role`
  tiene `EXECUTE` sobre `listar_movimientos_stock`.

### `lib/asistente-tools.js`

- Nueva tool `listar_movimientos_stock`, ubicada junto al cluster de
  tools de stock (después de `consultar_stock_critico`).
  - `roles: ['dueno', 'admin', 'depositero']` — mismos roles que tienen
    acceso a la pantalla `/admin/stock`.
  - Parámetros opcionales: `producto` (texto libre), `tipo` (ingreso /
    egreso / ajuste / transferencia / reserva / liberacion), `dias`
    (default 7, tope 90 desde la tool).
  - `execute()` llama directo a la RPC `listar_movimientos_stock` vía
    `db.rpc(...)`.

## Verificación

Migración 423 y 423b aplicadas contra el proyecto de producción
(`jgiquzjwoedmzwqgzubr`). Se confirmó:

- La función existe con la firma esperada y solo `service_role` tiene
  `EXECUTE` (`anon`/`authenticated` sin acceso).
- Prueba funcional real contra una empresa con datos: devolvió 20 filas
  sobre un `total_movimientos` real de 284 en una ventana de 30 días,
  con tipos variados (ingreso, egreso, reserva, liberación) y datos
  consistentes con lo que se ve en el panel `/admin/stock`.

## Cómo queda

El asistente ahora puede responder consultas sobre el historial de
movimientos de stock (kardex) con detalle producto por producto,
filtrando por tipo y/o producto, y aclarando cuando hay más movimientos
de los que se muestran (`total_movimientos` vs `movimientos_mostrados`).

## Archivos modificados

- `supabase/migrations/423_asistente_movimientos_stock.sql` (nuevo)
- `supabase/migrations/423b_fix_revoke_anon_authenticated_listar_movimientos_stock.sql` (nuevo)
- `lib/asistente-tools.js`
