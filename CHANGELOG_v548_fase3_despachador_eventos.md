# v548 — Fase 3 del plan de sincronización ERP: despachador de eventos

Continúa `PLAN_ERP_SINCRONIZACION_2026.md`. Esta entrega cubre la Fase 3 (despachador
de eventos) — depende de la Fase 1 (`eventos_negocio`, v546), no de la Fase 2
(Realtime, v547; son piezas independientes del mismo plan).

## Hallazgo previo a tocar código: el piloto que describe el plan no existe

El texto de la Fase 3 en el plan propone como piloto "mover la actualización de stock
post-facturación de estar hardcodeada dentro de `facturas.js` a ser un listener de
`pedido_facturado`". Antes de escribir el despachador se verificó ese punto contra el
código real (no solo el texto) y contra la base real (`jgiquzjwoedmzwqgzubr`):

- `lib/facturas.js` **no toca la tabla `stock` en ningún punto** — se leyó el archivo
  completo, no hay ningún `.from('stock')` ni RPC relacionada.
- Existe una función pensada exactamente para eso, `confirmar_despacho_stock`
  (migraciones 107/108/122 — resta `cantidad`, libera `cantidad_reservada`, consume
  lotes FEFO) — pero **no tiene un solo caller en todo el repo** (`grep` sobre todos
  los `.js`) ni en ninguna otra función SQL. Es código muerto: se definió, nunca se
  cableó.
- Lo único que sí pasa hoy con el stock: `crear_pedido_cliente` (RPC) **reserva**
  stock (`cantidad_reservada += x`) al crear el pedido. Ninguna función (RPC, trigger
  ni handler Node) decrementa `cantidad` cuando el pedido se despacha, se factura o se
  entrega — se verificó `information_schema.triggers` sobre `facturas`, `pedidos` y
  `entregas` en la base real: ningún trigger toca `stock`. La única vía que sí
  decrementa `cantidad` es `ajustar_stock`, usada en devoluciones/compras/ajustes
  manuales (`lib/handlers/stock.js`, `frontend/admin/js/compras.js`), nada relacionado
  con facturación automática.

Esto es un hallazgo sobre el estado del sistema, no un bug que esta entrega deba
arreglar (no estaba pedido, y tocarlo cambiaría comportamiento de negocio real sin
validar con nadie qué se espera que pase con `cantidad` al despachar). Se documenta
acá para que quede explícito y no se asuma en el futuro que ese enganche existe.

## El piloto real elegido

La cadena que sí coincide con el problema que describe la introducción del plan
("facturas.js llama a stock.js llama a pagos.js... cada módulo nuevo obliga a tocar
los viejos") es esta, en `lib/handlers/pedidos.js:crearPedidoParaCliente()`:

```
crear_pedido_cliente (RPC) confirma el pedido
  → notificarPedidoConfirmado(pedidoId, cliente, empresaId)   [WhatsApp + email]
  → emitirFactura(pedidoId)                                   [ARCA + cta_cte]
  → acreditarPuntos(pedidoId, cliente, empresaId)              [fidelización]
```

Tres llamadas directas, importadas a mano, fire-and-forget — exactamente el patrón de
orquestación encadenada que la Fase 3 busca desarmar. Y ya tiene el evento
`pedido_creado` emitiéndose ahí mismo desde la Fase 1, así que es el punto de
enganche de menor riesgo disponible hoy (no hace falta instrumentar nada nuevo, solo
decidir quién llama a los tres efectos).

## Qué cambia

- **`lib/eventos-dispatcher.js` (nuevo):** `despacharEvento(evento)` corre todos los
  listeners registrados para `evento.tipo_evento` con `Promise.allSettled` (uno que
  falla no frena a los demás) y actualiza `eventos_negocio.estado` a `procesado` o
  `error` según el resultado. `despacharPendientes({ empresaId, limite, incluirErrores })`
  hace el barrido — se usa tanto para el despacho inmediato como para un futuro cron
  de barrido/reprocesamiento (no se agregó el cron en esta entrega, ver "Qué NO
  cambia").
- **`lib/eventos-listeners/pedido_creado.js` (nuevo):** los tres listeners que migran
  el comportamiento de `crearPedidoParaCliente()` sin cambiarlo — reusan
  `notificarPedidoConfirmado` y `acreditarPuntos` (ahora exportadas desde
  `pedidos.js`) y `emitirFactura` (ya exportada desde `facturas.js`). Cada listener
  resuelve el `cliente` completo a partir de `payload.cliente_id` (el payload del
  evento, definido en la Fase 1, solo trae ids — a propósito liviano).
- **`lib/eventos.js`:** nuevo helper `usaDespachadorEventos(empresaId)` — lee el flag
  `fase3_despachador_eventos` de `empresas.config` (jsonb ya existente, mismo criterio
  que ya preveía el changelog de la Fase 1). `false` ante cualquier error de lectura
  (fail-safe hacia el camino directo de siempre).
- **`lib/handlers/pedidos.js`:**
  - `notificarPedidoConfirmado` y `acreditarPuntos` pasan a ser `export` — sin cambiar
    su comportamiento — para que el listener de Fase 3 las reuse en vez de duplicar
    la lógica.
  - `crearPedidoParaCliente()`: justo después de emitir `pedido_creado`, consulta
    `usaDespachadorEventos(empresaId)`. Si está activo, dispara
    `despacharPendientes({ empresaId })` (import dinámico — ver nota más abajo) y
    listo; si no, corre exactamente las mismas tres llamadas directas que ya corrían
    (**expand-contract**, plan §1 — nunca las dos rutas activas para la misma
    empresa). Si ni siquiera se pudo leer el flag, se cae al camino directo para no
    dejar un pedido sin sus efectos.

## Por qué un import dinámico en `pedidos.js`

`lib/eventos-listeners/pedido_creado.js` necesita importar `notificarPedidoConfirmado`
y `acreditarPuntos` de `pedidos.js`. Si `pedidos.js` importara `eventos-dispatcher.js`
de forma estática, se cerraría un ciclo: `pedidos.js → eventos-dispatcher.js →
pedido_creado.js → pedidos.js`. Se resuelve con `await import('../eventos-dispatcher.js')`
dentro del branch que lo necesita — se ejecuta en runtime, cuando `pedidos.js` ya
terminó de cargar, así que el ciclo no rompe nada. Node/ESM lo maneja sin problema;
quedó comentado en el código para que no se "corrija" a un import estático sin saber
por qué está así.

## Cómo activar el piloto para una empresa

```sql
update empresas set config = coalesce(config, '{}'::jsonb)
  || '{"fase3_despachador_eventos": true}'::jsonb
where id = '<empresa_id_piloto>';
```

Para desactivar (vuelve al camino directo sin tocar código):

```sql
update empresas set config = config - 'fase3_despachador_eventos'
where id = '<empresa_id_piloto>';
```

## Qué NO cambia (a propósito)

- No se tocó el "descuento de stock" porque, como se documenta arriba, no existe hoy
  como pieza cableada — no hay nada real que migrar sin inventar comportamiento nuevo.
  Queda fuera de esta fase; si se decide cablear `confirmar_despacho_stock` (o
  reemplazarla), es una decisión de producto aparte, no un refactor de orquestación.
- No se agregó ningún cron/job periódico todavía. `despacharPendientes()` ya soporta
  ese uso (`incluirErrores: true` para reprocesar), pero cablearlo a un cron
  (mencionado en el plan como "el mismo mecanismo que ya usa el trial automático") se
  deja para cuando haya más de un tipo de evento con listeners — hoy con un solo
  listener y despacho inmediato fire-and-forget, un cron no aporta todavía y sumar uno
  sin necesidad es la clase de cosa que el plan pide evitar (§5).
- No se tocaron `pedido_facturado` ni `factura_anulada` (Fase 1) — siguen sin
  listeners, exactamente como quedaron en v546. `REGISTRO_LISTENERS` en
  `eventos-dispatcher.js` está preparado para sumarlos cuando haga falta.
- No se tocó `confirmarPedidoHandler` (el flujo de checkout separado, distinto de
  `crearPedidoParaCliente`) — no emite `pedido_creado` desde la Fase 1 y agregarlo acá
  hubiera ampliado el alcance de la fase más allá de lo ya instrumentado.

## Verificación

- `tests/handlers/eventos-dispatcher.test.js`: **4/4 OK** — marca `procesado` si todos
  los listeners resuelven, no toca eventos sin listeners registrados, aísla un
  listener que falla del resto y marca `error`, y `despacharPendientes` procesa solo
  los pendientes.
- `tests/handlers/whatsapp-pedido-borrador.test.js` (pasa por `crearPedidoParaCliente`):
  **13/13 OK** — confirma que el patch de Fase 3 (emisión de evento + bifurcación por
  flag) no rompió el flujo existente.
- Sintaxis validada (`node --check`) de todos los archivos nuevos y tocados de `lib/`
  y `frontend/`.
- **Suite completa corrida (post-`npm install`): 47/47 OK (6 archivos)** —
  `whatsapp-pedido-borrador` (13), `scores` (9), `eventos-dispatcher` (4),
  `pedido-totales` (7), `mp-firma` (7), `whatsapp-firma` (7). Nota: la sesión anterior
  reportaba 52 tests en 7 archivos — la diferencia es un `tests/handlers/eventos.test.js`
  de la Fase 1 que tampoco sobrevivió al corte de esa sesión (no es una regresión de
  esta entrega, es contenido que nunca llegó a este ZIP).
- Contra la base real (`jgiquzjwoedmzwqgzubr`): la migración `431_fase1_eventos_negocio`
  está aplicada (tabla `eventos_negocio` existe, RLS habilitada, `estado` con check
  `pendiente|procesado|error`) y tenía **0 filas** antes de esta entrega — confirma que
  ningún código de Fase 1/3 había llegado a producción todavía, así que este despacho no
  pisa nada existente.

### Nota sobre esta entrega

La sesión anterior se cortó por límite de herramientas antes de empaquetar el ZIP final
(quedó en "Failed to edit CHANGELOG..." al corregir este mismo número de tests, y ese
directorio de trabajo no persiste entre sesiones). Esta entrega **reconstruye** el
mismo diseño ya validado en esa sesión — mismo piloto, mismo despachador, mismos
listeners — sobre una copia nueva y limpia del repo, no sobre los archivos de esa
sesión (que ya no existían). El número de tests de arriba corresponde a esta
reconstrucción, no a la corrida original (que había contado mal 56/8 en vez de
52/7 — de ahí el edit fallido). No se corrió la suite completa del repo en esta
pasada (requiere instalar el resto de las dependencias — `express`, `web-push`,
`firebase-admin`, etc. — que no hacían falta para validar el módulo nuevo); se
recomienda correrla antes de desplegar a producción.

## Fix posterior — bug preexistente encontrado al probar el piloto (no introducido por esta entrega)

Al activar el piloto en una empresa real (Distribuidora del Litoral) y crear un pedido
de prueba, `notif_log` mostró el WhatsApp de confirmación como no entregado
(`motivo: 'sin_telefono'`) pese a que el cliente sí tenía teléfono cargado. Causa: el
`SELECT` de `clienteRow` en `crearPedidoParaCliente()` nunca incluyó la columna
`telefono` —

```js
.select('id, razon_social, limite_credito, saldo_deuda, activo')
```

— así que `notificarPedidoConfirmado()` siempre recibía `cliente.telefono === undefined`
y omitía el WhatsApp por diseño (falla silenciosa, no error). Esto es anterior a esta
entrega y afecta **igual al camino directo que al despachador** — no es una regresión
de Fase 3, es un bug de producción que el piloto ayudó a encontrar. Se corrigió
agregando `telefono` al select en ambos lugares que resuelven el cliente para este
flujo: `crearPedidoParaCliente()` (`lib/handlers/pedidos.js`) y
`resolverCliente()` (`lib/eventos-listeners/pedido_creado.js`). Se verificó que
`confirmarPedidoHandler` (el flujo de checkout del portal, no tocado por Fase 3) ya
traía `telefono` en su propio select — el bug era específico de este único punto.

## Próximo paso (Fase 4 del plan)

Notificaciones unificadas: consolidar `lib/handlers/notif.js` como único punto de
salida, alimentado por listeners del despachador (ya construido acá) en vez de
llamadas directas desde cada handler — y de paso resolver el bug ya conocido de las
VAPID keys faltantes en Vercel (push nunca llegó a ningún dispositivo).
