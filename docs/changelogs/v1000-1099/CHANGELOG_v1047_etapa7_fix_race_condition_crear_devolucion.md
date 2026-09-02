# v1047 — Etapa 7 (Bloque 1, Devoluciones): fix condición de carrera en el alta

## Contexto

Durante el pase de la Etapa 7 del plan de auditoría funcional
(`PLAN_AUDITORIA_FUNCIONAL_ETAPA7_2026.md`), lectura completa de
`crearDevolucionCore` (`lib/handlers/pedidos/devoluciones.js`) contra el
código y contra `AUDITORIA_BUGS_v954.md` (que ya había revisado este mismo
módulo). El hallazgo no estaba documentado en esa auditoría anterior.

## Problema

La validación de "cantidad disponible para devolver" se hacía en 2 pasos
sueltos, sin lock ni transacción:
1. `SELECT` de `obtenerComprasPorProductoCliente` + `obtenerDevueltoPorProductoCliente`
   (dos queries independientes vía PostgREST).
2. Recién después, `INSERT` en `devoluciones`/`devolucion_items`.

Dos altas simultáneas del mismo cliente+producto desde canales distintos
(chofer + admin, o admin + asistente de WhatsApp) podían leer el mismo
"disponible" antes de que la primera terminara de insertar — las dos
podían pasar la validación y, sumadas, superar lo realmente comprado.
Mismo eje de riesgo que el incidente real de v805 (devolución de 4.555 u.
aprobada sobre 42 u. compradas, NC de ~$9,86M), pero de concurrencia en
vez de validación faltante. No había ningún `CHECK` a nivel DB que
actuara como red de contención (confirmado contra `006_logistica.sql`).

## Fix

- **Migración `570_rpc_crear_devolucion_validada_fix_race_condition`**:
  nueva RPC `rpc_crear_devolucion_validada` que mueve toda la validación +
  el insert de cabecera e ítems a una única transacción de Postgres,
  serializada por cliente con `pg_advisory_xact_lock`. Mismo patrón que
  `bloquearPresupuestoAceptado` (presupuestos) — señalado en la auditoría
  anterior como el caso bien resuelto a imitar.
- `lib/repos/pedidos.js`: nueva función `crearDevolucionValidadaRpc()`
  (wrapper de la RPC). Quedan sin uso pero no se borraron (por si algo más
  las referencia en el futuro): `obtenerComprasPorProductoCliente`,
  `obtenerDevueltoPorProductoCliente`, `crearDevolucion`,
  `buscarDevolucionPorOfflineLocalId`, `insertarItemsDevolucion`.
- `lib/handlers/pedidos/devoluciones.js`: `crearDevolucionCore` ahora llama
  a la RPC en vez de hacer la validación + el insert en JS. La nota de
  débito automática (motivo `producto_defectuoso`) ahora lee el precio
  real desde los ítems insertados (`listarItemsDevolucionConProducto`) en
  vez del `body` original, porque el precio se resuelve server-side dentro
  de la RPC.

## Efecto secundario (mejora, no buscada)

Antes, si fallaba el insert de ítems después de insertar la cabecera,
había que "compensar" borrando la cabecera a mano — y esa compensación
podía fallar también, dejando el registro en estado
`devolucion_compensacion_pendiente`. Con todo en una sola transacción, un
fallo en cualquier paso revierte todo solo; esa clase de estado
inconsistente ya no puede ocurrir.

## Pendiente

- **Pase manual en navegador real**: este fix se aplicó por lectura de
  código + verificación contra el schema real de Supabase
  (`jgiquzjwoedmzwqgzubr`), no por reproducción del bug en un browser. El
  advisory lock está probado por lectura de la lógica, no por un test de
  concurrencia real (2 requests simultáneos).
- Suite de tests existente (`tests/repos/crear-devolucion-core.test.js` y
  relacionados) probablemente rompe contra la nueva implementación — los
  mocks apuntan a las funciones viejas de 2 pasos. No se actualizó en esta
  sesión; queda para el cierre de este bloque.
- Resto del Bloque 1 (Etapa 7): casos borde de "devolución sobre pedido
  con NC previa" desde el ángulo de facturación/ARCA, todavía sin cruzar.
