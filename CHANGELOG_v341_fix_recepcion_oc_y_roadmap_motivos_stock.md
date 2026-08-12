# v341 — Fix crítico: recepción de OC no impactaba en stock real + roadmap de motivos de ajuste

## Contexto

Auditoría del modal de ajuste de stock y sus "motivos" (Compra a proveedor,
Devolución de cliente, Producción propia, Venta manual, Merma/Rotura/Muestra,
Corrección de inventario, Entre depósitos). Verificado contra el código real
del zip — migraciones `058`/`118`/`201`/`340` (`ajustar_stock`), `054`
(`recepcionar_orden_compra`) y `181` (`registrar_venta_pos`) — y contra el
schema real de producción (`docs/schema-snapshots/backup.sql`), no solo
contra los archivos de migración locales.

---

## 🔴 Bug crítico corregido — `recepcionar_orden_compra` no escribía en `stock`

**Archivo:** `supabase/migrations/341_fix_recepcionar_orden_compra_stock_real.sql`
**Llamada real:** `lib/handlers/proveedores.js` (`accion=recepcionar`), no era código muerto.

### Qué estaba mal

1. **Stock invisible.** La función solo sumaba en `productos.stock_actual`
   (columna suelta). Todo el módulo de Stock —grilla de depósitos,
   "Reposición sugerida" (`analizar_stock_autonomo()`, que hace `LEFT JOIN
   stock`), el modal de ajuste, `ajustar_stock`— lee y escribe
   exclusivamente la tabla `stock` por depósito. Resultado: la mercadería
   recibida de un proveedor no aparecía en ningún depósito real, no se
   podía vender, transferir ni ajustar desde el panel, y no generaba lote
   de costo (FEFO).
2. **La función fallaba en producción.** Insertaba en `movimientos_stock`
   usando columnas (`empresa_id`, `referencia_tipo`) que **no existen** en
   la tabla real (confirmado contra `backup.sql`: la tabla tiene
   `producto_id, deposito_id, tipo, cantidad, referencia, referencia_id,
   usuario_id, notas, created_at, costo_unitario`). El `INSERT` tiraba error
   de columna inexistente, el bloque `EXCEPTION WHEN OTHERS` lo capturaba y
   devolvía `ok:false` genérico — silencioso, sin dejar rastro del motivo
   real.
3. **Recepción parcial rota.** Pisaba `ordenes_compra_items.cantidad` (la
   cantidad *pedida*) con la cantidad recibida, en vez de acumular en
   `cantidad_recibida`. Rompía cualquier cálculo de "recibido parcial vs.
   total".

### Fix aplicado

- Agrega `p_deposito_id` opcional (default `NULL`) a la firma. Si no viene,
  resuelve el depósito principal de la empresa (`es_principal DESC, id ASC`
  como fallback).
- Reutiliza el mismo patrón atómico que `ajustar_stock` (migración 201):
  `INSERT ... ON CONFLICT DO NOTHING` + `SELECT ... FOR UPDATE` para
  lockear la fila de `stock` antes de escribir.
- Crea lote FEFO por cada ingreso (`lotes`, estado `activo`, con
  `costo_unitario` real del item de la OC).
- Inserta en `movimientos_stock` con las columnas reales de la tabla.
- Mantiene el update a `productos.stock_actual` en paralelo, por
  compatibilidad con pantallas que todavía lo leen.
- Acumula `cantidad_recibida` en vez de pisar `cantidad`, y calcula el
  estado de la OC como `recibida` (todos los items completos) o
  `recibida_parcial` (falta alguno) en vez de siempre `recibida`.
- **Lección de la 340 aplicada:** se dropea explícitamente la firma vieja
  de 4 argumentos (`DROP FUNCTION IF EXISTS ... (uuid, uuid, jsonb,
  uuid)`) antes de crear la de 5 — agregar un parámetro con `DEFAULT` sin
  dropear la firma anterior es exactamente lo que causó la ambigüedad
  PGRST203 que rompió `ajustar_stock` en la 340.

**Archivo tocado:** `lib/handlers/proveedores.js` — ahora reenvía
`deposito_id` del body al RPC si el frontend lo manda (opcional, no rompe
nada si no está: cae al depósito principal).

### ✅ Aplicado y probado en producción (2026-07-16)

Migración corrida contra el proyecto real (`jgiquzjwoedmzwqgzubr`). Al
probarla apareció un drift más: **`productos` en producción no tiene
columna `stock_actual`** (el snapshot local `docs/schema-snapshots/backup.sql`
estaba desactualizado en este punto) — se sacó esa referencia de la
función; el stock real vive exclusivamente en `stock` por depósito, que es
justamente lo que este fix ya arregla. Se mantiene la sincronización de
`productos.costo` con el último costo de compra, que sí existe.

Prueba end-to-end sobre una OC de test (`OC-TEST-82228e4f`, empresa real):
recepcioné 5 unidades de un ítem → `stock` pasó de 203 a 208 en Depósito
Central, se creó el lote FEFO correspondiente, el movimiento quedó
registrado con las columnas reales, `cantidad_recibida` se acumuló bien
(5/25) y la OC pasó a `recibida_parcial`. Confirmado todo por SQL directo
y revertido después para no dejar un ingreso ficticio en el inventario real.

### Pendiente de UI (no incluido en este pase)

El frontend de recepción (`frontend/admin/js/compras.js`) todavía no tiene
selector de depósito — todas las recepciones caen al depósito principal
hasta que se agregue. No es bloqueante (la función ya no rompe y el stock
ya queda visible), pero para empresas con más de un depósito conviene
agregarlo antes de depender de recepciones a depósitos secundarios.

---

## Roadmap — implementación recomendada por motivo

Para cada motivo del modal de ajuste se evaluaron variantes de "dejarlo
como está" vs. "cerrar el círculo contable/operativo". Abajo, la opción
más completa y eficiente por motivo (la que más valor agrega por esfuerzo
de implementación), a modo de plan de trabajo para los próximos pases —
**nada de esta sección está implementado todavía**, es la propuesta.

### Compra a proveedor → redirigir a `recepcionar_orden_compra`
Ya no hace falta workaround: con el bug de arriba resuelto, el motivo
"Compra a proveedor" del modal de ajuste debería dejar de llamar a
`ajustar_stock` directamente y en su lugar mostrar un selector de
orden de compra/proveedor que dispare `recepcionar_orden_compra`. Es la
opción más completa porque una compra real *es* una recepción de OC, con
lote/costo/proveedor vinculado — no un ajuste manual disfrazado.

### Devolución de cliente → módulo de Notas de Crédito existente
En vez de agregar `cliente_id`/`pedido_id` al modal de ajuste y duplicar
lógica de cuenta corriente ahí, dirigir estos casos al módulo de Notas de
Crédito (`docs/ayuda/notas-credito-y-debito.md`), que ya resuelve el
crédito en `cta_cte` del cliente de forma simétrica a
`registrar_venta_pos`. Es la más eficiente porque reutiliza lógica
contable ya auditada en vez de bifurcarla.

### Producción propia → BOM/receta con descuento automático de insumos
La más completa: tabla `producto_insumos` (producto terminado → insumos y
cantidades) y que al producir cantidad X se descuenten automáticamente los
insumos con llamadas adicionales a `ajustar_stock` (egreso) por cada
insumo, dentro de la misma transacción. Sin esto, "Producción propia" solo
suma stock del producto terminado sin reflejar el consumo real de
materia prima — subestima el costo y sobreestima el stock de insumos.

### Venta manual → redirigir a POS (`registrar_venta_pos`)
Si la intención es vender con cliente y cobro, este motivo debería
redirigir al flujo de POS en vez de existir como ajuste sin efecto
comercial. Dejarlo como "ajuste sin cliente/factura" solo tiene sentido
para correcciones internas — conviene renombrarlo explícitamente a algo
como "Salida por venta no facturada" para el caso legítimo, y mandar todo
lo demás a POS.

### Merma / Rotura / Muestra o regalo → mantener + vincular a lote específico
El comportamiento actual (egreso auditable sin efecto contable directo) es
correcto para la mayoría de los casos y no requiere cambios. La mejora de
mayor relación costo/beneficio es permitir elegir el lote a mano en vez de
dejar que `fn_lotes_consumir_fefo` elija automáticamente — útil cuando la
merma es de un lote puntual (vencido, dañado en tránsito), que es
justamente el caso más común de este motivo.

### Corrección de inventario / Conteo físico → tabla de conteos históricos
La más completa: tabla `conteos_stock` con snapshot histórico (fecha,
usuario, diferencias por producto) en vez de perder el detalle en un único
movimiento de ajuste. Permite auditar recuentos periódicos y detectar
patrones de diferencia recurrentes por producto/depósito a lo largo del
tiempo, algo que hoy es imposible de reconstruir.

### Entre depósitos → función transaccional única (`transferir_stock`)
Reemplazar el esquema actual (dos llamadas RPC con reversión manual del
lado cliente si la segunda falla) por una única función SQL
(`transferir_stock`) que haga débito y crédito dentro de la misma
transacción de Postgres. Es la más eficiente: elimina por completo la
ventana de inconsistencia entre ambas llamadas y la necesidad de lógica de
reversión en el cliente — la atomicidad la garantiza la base, no el
frontend.

---

## Próximo paso sugerido

Priorizar en este orden:
1. Selector de depósito en el frontend de recepción de OC (cierra el gap
   de UI del fix de arriba).
2. `transferir_stock` transaccional (menor esfuerzo, elimina un riesgo de
   inconsistencia real hoy).
3. Redirección de "Compra a proveedor" y "Venta manual" a sus flujos
   correctos (evita que seres humanos sigan usando el modal de ajuste para
   operaciones que ya tienen un flujo dedicado).
4. BOM de producción propia y tabla de conteos históricos (mayor esfuerzo,
   más completos).
