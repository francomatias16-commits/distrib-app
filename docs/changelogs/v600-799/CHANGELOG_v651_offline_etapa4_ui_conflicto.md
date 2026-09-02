# CHANGELOG v651 — Plan offline, Etapa 4: UI de conflicto en los 5 módulos

**Fecha:** 2026-08-07.

## El problema

Desde la Etapa 3 (idempotencia por `offline_local_id`), cualquier rechazo
del servidor durante la sincronización de una acción encolada — stock
insuficiente, turno cerrado, pedido ya no despachado, factura ya saldada,
etc. — caía como error genérico dentro de `_marcarError` y quedaba
**reintentando solo, en loop, para siempre**, sin que el usuario se
enterara nunca del motivo real. En el caso más grave (`pos-offline.js` v2),
esto era directamente peligroso: un 409 se interpretaba como "duplicado, ya
sincronizado" para *cualquier* rechazo de negocio, así que el vendedor veía
la venta como sincronizada cuando en realidad el servidor la había
rechazado (sin descontar stock, sin cobrar nada).

## Qué cambió

Se generalizó a los 5 módulos offline el patrón de **conflicto** ya
disponible en `offline-core.js` (Dexie): distinguir un rechazo de negocio
evaluado por el servidor contra el estado real (no reintentable a ciegas)
de un error transitorio de red/5xx (sí reintentable solo).

| Módulo | Origen del rechazo | Detección |
|---|---|---|
| `pos-offline.js` | `/api/pos` (4xx) | `stock_insuficiente`, `turno_cerrado`, `pagos_no_coinciden`, `limite_credito`, `cliente_requerido` — `data.tipo` de `lib/handlers/pos.js` |
| `stock-offline.js` | RPC `ajustar_stock` / `registrar_conteo_stock` / `transferir_stock` | `data.ok === false`; caso especial `conflicto_stock_cambio` con reintento auto-ajustado al stock actual |
| `cliente-offline.js` | RPC de alta/edición de cliente | `data.ok === false` |
| `chofer-offline.js` | `/api/chofer/remitos/:id/entregar` \| `/no-entregar` \| `/api/chofer/devolucion` | 400 "pedido no despachado" / "no encontrado" / cobro asociado rechazado (mismo `registrar_cobro_completo` que cobros-offline) |
| `cobros-offline.js` | RPC `registrar_cobro_completo` | `data.ok === false` — factura ya saldada/anulada, cliente inexistente, monto inválido |

En los cinco, un rechazo de negocio ahora:
1. Lanza un `Error` marcado (`err.conflicto = true`, `err.tipoConflicto`,
   `err.datosConflicto`) que `offline-core.js` reconoce y saca del ciclo de
   reintento automático.
2. Se muestra en el modal de conflicto genérico (badge de conexión) con un
   título y detalle específicos por tipo (`formatoConflicto`).
3. Dispara `onConflicto` para refrescar la vista abierta (tabla de ventas,
   stock, cta-cte, remito) para que no quede desactualizada mientras el
   usuario decide.
4. El usuario elige "Reintentar" (revisando el estado actual primero) o
   "Descartar" (solo saca la acción de la cola local — no toca nada en el
   servidor).

Un 5xx / error de red real sigue el camino de reintento automático sin
marcar conflicto, en los cinco módulos.

## Módulos tocados

- `frontend/admin/js/pos-offline.js` → v3
- `frontend/admin/js/stock-offline.js` → v3 (ya venía de una sesión previa)
- `frontend/cliente/cliente-offline.js` → v3 (ya venía de una sesión previa)
- `frontend/chofer/chofer-offline.js` → v3
- `frontend/admin/js/cobros-offline.js` → v3 (era el único que faltaba —
  seguía en v2/Etapa 3, sin el tratamiento de conflicto)

Los cinco exponen ahora la misma API extendida:
`getConflictos`, `getContadorConflictos`, `resolverConflicto` — además de
lo que ya tenían. Ningún llamador existente (`pos.js`, `stock.js`,
`cta-cte.js`, `remito.js`, `cliente.js`) necesita cambios: el modal lo
maneja `offline-core.js` a través del badge.

## Verificación

- `node --check` OK en los 6 archivos (5 módulos + `offline-core.js`).
- Sin cambios de schema/migraciones — se apoya en la idempotencia ya
  establecida en las migraciones 443/444/445/446 y 181.

## Pendiente / no cubierto en esta etapa

- Tests automatizados de UI de conflicto (no hay suite de tests para los
  módulos offline en `tests/` — quedan cubiertos solo por revisión manual y
  `node --check`).
- `producir_con_insumos` en stock sigue "solo red" (fuera de alcance,
  documentado ya en `stock-offline.js`).
