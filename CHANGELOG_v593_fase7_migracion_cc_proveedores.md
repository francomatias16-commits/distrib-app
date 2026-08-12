# v593 — Fase 7, orden de migración pedido por el usuario: `cc_proveedores` — CERRADO

Segundo módulo del lote (después de `portal_proveedor` v592): `cc_proveedores.js`
(16 `.from()`/`.rpc()` directos), Etapa 8.5 — Cuentas corrientes con
proveedores.

## Qué se hizo

**`lib/repos/cc-proveedores.js` (nuevo)** — 15 funciones:

- `obtenerPerfilCCProveedores`, `listarBalanceProveedores`,
  `contarFacturasConDiferencias`, `obtenerFacturaProveedorDetalle`,
  `listarFacturasProveedorFiltradas`, `listarPagosFactura`,
  `existeProveedorEnEmpresa`, `insertarFacturaProveedorCC`,
  `insertarItemsFacturaProveedorCC`, `eliminarItemsFacturaProveedorCC`,
  `conciliarOcFacturaRpc`, `actualizarConciliacionFactura`,
  `registrarPagoProveedorRpc`, `obtenerFacturaEstadoTotalPagado`,
  `actualizarFacturaProveedorCC`.

**`lib/repos/index.js`** — se agregó `CCProveedoresRepo` al barrel.

**`lib/handlers/cc_proveedores.js`** — los 16 `.from()`/`.rpc()` directos
originales pasan por el repo de arriba, sin cambio de comportamiento
observable: se replicó tal cual la política de error de cada query
(silenciosa vs. propagada) — la mayoría de las escrituras (crear/editar
factura, ítems, RPCs de conciliación y pago) propagan el error porque el
original hacía chequeo explícito con `errorSeguro`, mientras que
`obtenerPerfilCCProveedores`, `existeProveedorEnEmpresa`,
`actualizarConciliacionFactura` y `obtenerFacturaEstadoTotalPagado` se
mantienen silenciosas igual que el original.

Hallazgo corregido de paso: 3 puntos del handler original actualizaban la
conciliación de una factura (`.update({ conciliacion, discrepancias })`)
pero solo 1 de esos 3 filtraba explícitamente por `empresa_id` además de
`id` — el alta (POST `?accion=factura`) y el PATCH (re-conciliación tras
editar ítems) confiaban únicamente en `.eq('id', factura.id)`. No
explotaba porque `factura.id`/`id` ya venían resueltos de una fila
previamente validada contra `empresa_id`, pero rompe la misma regla de
Fase 7 de no confiar en un solo id como barrera. Se unificaron los 3 en
`actualizarConciliacionFactura`, que siempre filtra por `id` Y
`empresa_id`.

## Verificación

- `grep -c "\.from(\|\.rpc("` en `lib/handlers/cc_proveedores.js`: 0. Cero
  accesos directos a tablas/RPCs de negocio.
- Sintaxis válida (`node --check`) en handler y repo.
- Tests nuevos: `tests/repos/cc-proveedores.test.js` (no existía cobertura
  de repo para este módulo). Foco en los filtros de aislamiento por
  `empresa_id` de cada función y en la política de error silenciosa vs.
  throw de cada una.

**Nota sobre ejecución de tests**: en la sesión original este módulo se
cerró sin poder correr `vitest` (sandbox sin `node_modules` ni red). En
esta reconstrucción sí se pudo instalar dependencias y correr la suite
completa: **764/770 OK**. Las 6 fallas restantes son las mismas
preexistentes y no relacionadas documentadas en v592
(`tests/handlers/admin-permisos.test.js`, falta de credenciales reales de
Supabase en este sandbox) — sin regresión.

## Próximo paso

Sigue `automatizacion` (16 usos), según el orden pedido.
