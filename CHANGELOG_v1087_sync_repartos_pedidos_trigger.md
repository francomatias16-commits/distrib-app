# CHANGELOG v1087 — Sincronización real Pedidos ↔ Repartos (trigger en DB, migración 630)

## Reporte

"Al marcar un estado en Pedidos no impacta en Repartos."

## Causa raíz

No es un problema de refresco de pantalla: **las dos pantallas leen tablas
distintas y nada las sincronizaba desde la UI.**

- Repartos (`frontend/admin/js/rutas.js`) se alimenta 100% de
  `entregas.estado` y `rutas.estado` (`cargarRutasDelDia`,
  `actualizarSeguimiento`, `cargarPedidosDespachables`, reportes). Nunca lee
  `pedidos.estado`.
- La única pieza de código que sincronizaba ambas tablas al cambiar el estado
  de un pedido era el fix **v1086**, dentro de `PATCH /api/pedidos`
  (`lib/handlers/pedidos/index.js`). **La pantalla de Pedidos nunca llama a
  ese endpoint**: `cambiarEstado()` (`frontend/admin/js/pedidos.js`) escribe
  con supabase-js directo (`despachado`, `entregado`) o vía RPC
  (`confirmar_pedido`, `marcar_preparado`, `cancelar_pedido`).
- Verificado contra la base real (proyecto `jgiquzjwoedmzwqgzubr`): ninguna de
  esas 3 RPC menciona `entregas`/`rutas`, y no existía ningún trigger sobre
  `pedidos` que lo hiciera.

Es decir: v1086 arregló un camino que la pantalla no usa.

### Consecuencias confirmadas con datos de producción

1. **30 entregas** en estado `pendiente` con el pedido ya en `entregado`.
2. `entregas.estado = 'en_camino'` era un **estado muerto**: ningún camino de
   código lo escribía nunca (ni el despacho del admin ni el del chofer), así
   que despachar no movía la parada en Repartos.
3. Cancelar un pedido dejaba la entrega activa para siempre: la ruta nunca
   podía pasar a `completada` (`sincronizarEstadoRuta` exige que todas las
   entregas estén en estado terminal) y el pedido quedaba bloqueado como
   "ya en ruta" para futuras asignaciones.

## Decisión

La sincronización se **baja a la base de datos** en vez de replicarse en cada
call site. Así queda garantizada venga el cambio de donde venga: UI de
Pedidos, PATCH admin, portal del chofer, asistente por voz, replay offline o
un UPDATE manual. El día de mañana, un camino nuevo de escritura no vuelve a
abrir el mismo agujero.

## Cambios

### `supabase/migrations/630_sync_entregas_rutas_desde_estado_pedido.sql` (nuevo, YA APLICADO en producción)

- **`fn_sync_estado_ruta(uuid)`** — espejo SQL exacto de
  `sincronizarEstadoRuta()` (`lib/handlers/pedidos/_helpers.js`), incluida la
  generación de `reportes_ruta` al pasar a `completada` (fix de Kello, que
  hasta ahora solo existía en JS). Nunca pisa una ruta `cancelada` o
  `completada`.
- **`trg_sync_entregas_desde_pedido`** (`AFTER UPDATE OF estado ON pedidos`):
  - `despachado` → entrega `en_camino` → ruta `en_camino`
  - `entregado`  → entrega `entregado` (+ `fecha_confirmacion`) → ruta
    `completada` + reporte
  - `cancelado`  → entrega `no_entregado` (motivo `otro`) → recálculo de ruta
  - `confirmado` / `preparando` / `borrador` → sin efecto (la fila en
    `entregas` recién se crea al armar la ruta, y un retroceso de estado no
    debe revivir una entrega ya cerrada).
  - Solo toca la entrega **activa** (`pendiente`/`en_camino`): nunca pisa un
    `entregado`/`no_entregado` ya confirmado por el chofer desde su app.
- **Backfill** de las filas ya desincronizadas. Corrido con
  `tg_cierre_financiero` y `tg_score_entrega` **desactivados a propósito**:
  esos pedidos ya fueron entregados y facturados por el circuito viejo, y
  encolarlos ahora en `cola_financiera` habría generado facturación
  retroactiva duplicada. Ambos triggers quedaron reactivados y verificados
  (`tgenabled = 'O'`).

### `frontend/admin/js/pedidos.js`

Bloque de comentario sobre `cambiarEstado()` documentando por qué esta
función no pega al PATCH, por qué v1086 no se ejecutaba desde acá, y que la
sincronización ahora la garantiza el trigger. Sin cambios de comportamiento.

### `lib/handlers/pedidos/_helpers.js`

Nota sobre `sincronizarEstadoRuta()`: se mantiene la versión JS porque los
flujos del chofer escriben en `entregas` sin pasar por `pedidos` (ej.
"no entregar", que deja el pedido en `confirmado`), y ahí el trigger no
aplica. Las dos son idempotentes: si corren ambas, la segunda no encuentra
nada que cambiar.

## Verificación

Test funcional contra producción, dentro de una transacción revertida
(ruta + entrega sintéticas sobre un tenant real, `RAISE EXCEPTION` final para
deshacer todo):

```
despachado -> entrega=en_camino  ruta=en_camino
entregado  -> entrega=entregado  ruta=completada   reportes_ruta=1
cancelado  -> entrega=no_entregado/otro
```

Rollback confirmado: 0 rutas y 0 entregas nuevas en el tenant, `updated_at` de
los pedidos sin tocar.

Post-backfill, ya no queda ningún pedido `entregado` con entrega colgada en
`pendiente`.

## Hallazgo lateral (no resuelto en este ZIP)

`20260915000000_fix_get_carrito_cliente_precio_vigente.sql` figura aplicada en
producción (registrada hoy 02:51, `schema_migrations_registry` id 222) pero
**no está en `supabase/migrations/`** — mismo patrón de disaster-recovery gap
que v892/v899/v980. Además colisiona en número (629) con
`20260915120000_629_fn_actualizar_precios_masivo.sql`, que sí está en el repo;
por eso esta migración tomó el 630. Conviene reconstruirla desde el estado
real de la DB en una próxima sesión.
