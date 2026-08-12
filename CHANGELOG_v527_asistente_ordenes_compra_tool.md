# v527 — Nueva tool `listar_ordenes_compra` (sin conectar al asistente)

## Reportado

Continuando la revisión del catálogo de tools del asistente contra las
tablas centrales del sistema (mismo criterio que v526), se detectó que
`ordenes_compra` / `ordenes_compra_items` (órdenes de compra a
proveedores) se usa activamente en varios handlers de la aplicación
(`automatizacion.js`, `stock-auto.js`, `proveedores.js`,
`portal_proveedor.js`, `notif.js`), pero el asistente no tenía ninguna
forma de consultarla. Ante una pregunta como "qué órdenes de compra
tenemos pendientes" o "qué le compramos a tal proveedor este mes", no
había tool que devolviera ese dato.

## Diagnóstico

Igual que en v526, la tabla y la lógica de negocio ya existían y
estaban en uso normal del sistema — no era un bug, era una tool que
nunca se construyó para el asistente. A diferencia de
`movimientos_stock`, `ordenes_compra` **sí** tiene `empresa_id` propio,
así que el scope es directo. Al armar la RPC se detectó además que
`proveedores` no tiene columna `nombre` (tiene `razon_social` y
`nombre_fantasia`); se resolvió con `COALESCE(nombre_fantasia,
razon_social)`, el mismo patrón que ya usa el resto del repo (ver
`020_dt02_puntos.sql`, `067_priorizacion_cobranza.sql`, etc.) — se
verificó contra la base real antes de aplicar, no se asumió.

## Cambios

### `supabase/migrations/424_asistente_ordenes_compra.sql`

- Nueva RPC `listar_ordenes_compra(p_empresa_id, p_proveedor, p_estado, p_dias)`:
  - `SECURITY DEFINER`, `STABLE`, `search_path` fijado a `public`.
  - Scopeada directo por `ordenes_compra.empresa_id` (sin join
    intermedio, a diferencia de v526).
  - Filtros opcionales por nombre de proveedor (`ILIKE` sobre
    `COALESCE(nombre_fantasia, razon_social)`) y por estado exacto.
  - Ventana de días configurable (`p_dias`, default 30 al nivel de la
    tool, tope 180).
  - Devuelve además `cantidad_items` por orden (subconsulta a
    `ordenes_compra_items`), `subtotal`/`iva_total`/`total`, fechas de
    pedido/esperada/recepción, y si fue `auto_generada`.
  - Cap de 20 filas mostradas (`ordenes_mostradas`), pero
    `total_ordenes` devuelve el conteo real sin cap, mismo criterio que
    el resto de las tools de lectura del asistente.
  - Grants: `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`,
    y esta vez el `REVOKE` explícito de `anon`/`authenticated` se
    incluyó **en la misma migración** (lección aprendida de v526/423b,
    donde hizo falta un fix aparte por los default privileges del
    proyecto).

### `lib/asistente-tools.js`

- Nueva tool `listar_ordenes_compra`, ubicada junto al cluster de tools
  de proveedores (después de `comparar_precios_proveedor_producto`).
  - `roles: ['dueno', 'admin', 'depositero']` — mismos roles que tienen
    acceso a la pantalla `/admin/compras`.
  - Parámetros opcionales: `proveedor` (texto libre), `estado`
    (borrador / pendiente_aprobacion / enviada / confirmada /
    recibida_parcial / recibida / cancelada), `dias` (default 30, tope
    180 desde la tool).
  - `execute()` llama directo a la RPC `listar_ordenes_compra` vía
    `db.rpc(...)`.

## Verificación

Migración 424 aplicada contra el proyecto de producción
(`jgiquzjwoedmzwqgzubr`). Se confirmó:

- La función existe con la firma esperada y solo `service_role` tiene
  `EXECUTE` (`anon`/`authenticated` sin acceso, confirmado en la misma
  migración sin necesidad de fix posterior).
- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`.
- Prueba funcional real contra una empresa con datos: devolvió 6
  órdenes de compra reales con nombres de proveedor, totales e IVA
  consistentes.
- Prueba de filtros: `proveedor='garcia'` devolvió 3 de 6 órdenes;
  `estado='recibida_parcial'` devolvió 1 de 6 — ambos correctos contra
  los datos reales.

## Cómo queda

El asistente ahora puede responder consultas sobre el historial de
órdenes de compra a proveedores, filtrando por proveedor y/o estado, y
aclarando cuando hay más órdenes de las que se muestran (`total_ordenes`
vs `ordenes_mostradas`).

## Archivos modificados

- `supabase/migrations/424_asistente_ordenes_compra.sql` (nuevo)
- `lib/asistente-tools.js`
