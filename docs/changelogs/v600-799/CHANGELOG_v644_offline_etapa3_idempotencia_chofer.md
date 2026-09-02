# v644 — Plan offline, Etapa 3: idempotencia de confirmaciones del chofer + outbox

## Contexto

Continuación de la Etapa 2 (v643). El chofer ya podía cargar el remito
offline; esta etapa cubre el otro lado: que confirmar entrega, no-entrega
o devolución sin conexión no dependa de que el POST/PATCH llegue a buen
puerto en el primer intento, y que un reintento del outbox no duplique
nada (entrega, cobro asociado, devolución + nota de débito automática).

## Backend

- **Migración 441** (`441_offline_dedup_entregas_devoluciones.sql`, nueva):
  agrega `offline_local_id` + índice único condicional a `entregas` y a
  `devoluciones`. Mismo patrón que la migración 119 (ventas POS).
- **Migración 442** (`442_offline_dedup_registrar_cobro_completo.sql`):
  agrega `offline_local_id` a `cobros` y hace idempotente
  `registrar_cobro_completo` — cierra el hueco de doble cobro si el
  handler falla después de registrar el cobro pero antes de guardar
  `entregas.offline_local_id`.
- **`lib/repos/pedidos.js`**: nuevas `buscarEntregaPorOfflineLocalId` y
  `buscarDevolucionPorOfflineLocalId` (fast path de idempotencia).
- **`lib/handlers/pedidos.js`**:
  - `entregar` / `no-entregar`: chequean `offline_local_id` ANTES del
    chequeo de estado `despachado` (en un reintento el pedido ya está
    `entregado`, y ese chequeo rechazaría el reintento como error real).
  - `entregar` pasa `offline_local_id` (sufijado `-cobro`) a
    `registrarCobroCompletoRpc`, para que el cobro sea idempotente aunque
    el resto del handler no haya llegado a persistir el de la entrega.
  - `crearDevolucionCore`: mismo fast path.

## Frontend (chofer)

- **`frontend/chofer/chofer-offline.js`** (nuevo): outbox IndexedDB
  (`chofer_offline_db`), siguiendo el patrón de `pos-offline.js`. Cola
  FIFO de acciones `entregar` / `no_entregar` / `devolucion`, cada una con
  su `offline_local_id` (`crypto.randomUUID()`) generado al encolar —
  antes de tocar la red. Fotos y firma se guardan como data URL y se suben
  recién en el momento de sincronizar, reproduciendo la misma secuencia
  que seguiría el flujo online. Reintenta hasta 5 veces, badge de estado
  en el topbar, listeners de `online`/`offline`.
- **`frontend/chofer/remito.html`**:
  - Carga `chofer-offline.js` e inicializa `ChoferOffline.init({ getToken })`.
  - `esErrorDeRed(e)`: distingue error de red (encolar) de error de
    negocio (mostrar al chofer).
  - Los tres flujos (confirmar entrega, no se pudo entregar, devolución)
    encolan offline en vez de solo fallar cuando el error es de red.

## Pendiente / a verificar

- Falta decidir si se quiere un botón manual de "reintentar ahora" además
  del auto-sync en `online` / al encolar.
- No se tocó `marcarDespachado` — sigue sin soporte offline (fuera del
  alcance de esta etapa).
