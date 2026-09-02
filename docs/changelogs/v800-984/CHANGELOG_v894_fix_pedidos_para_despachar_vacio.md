# v894 — Fix "Pedidos para despachar" vacío con pedidos reales pendientes

## Problema (reportado por Luc)

En la pestaña "Armar ruta" del panel de Rutas, la lista de "Pedidos para
despachar" mostraba "Sin pedidos para despachar hoy" pese a que la empresa
tiene actividad real y decenas de pedidos en estado `confirmado`/`preparando`
sin entregar.

## Diagnóstico (verificado contra la base viva de producción)

Se encontraron dos problemas combinados en `cargarPedidosDespachables()`
(`frontend/admin/js/rutas.js`):

**1) Entregas huérfanas de rutas ya cerradas bloqueaban el pedido para siempre.**
El filtro que decide si un pedido "ya está en una ruta" solo miraba
`entregas.estado IN ('pendiente','en_camino')`, sin chequear si la **ruta**
dueña de esa entrega seguía activa. Se detectaron **145 registros de
`entregas`** con estado `pendiente`/`en_camino` cuya `ruta` padre ya está
`completada` (97 pendiente + 48 en_camino) — datos de hasta hace un año que
nunca se cerraron a `entregado`/`no_entregado`. Cada uno de esos bloqueaba
su pedido para siempre, sin importar que la entrega real ya hubiera pasado.

**2) El filtro de fecha era una igualdad exacta, no "hasta la fecha".**
`p.fecha_entrega === fecha` excluía cualquier pedido con `fecha_entrega`
distinta a la seleccionada — un pedido confirmado hace dos semanas y nunca
despachado quedaba invisible salvo que alguien fuera a buscar manualmente
esa fecha vieja en el selector de FECHA.

Combinados, estos dos bugs explican por qué la lista aparecía vacía pese a
tener **70 pedidos reales** de la empresa en `confirmado`/`preparando`
distribuidos en un backlog de más de un año.

## Fix

`frontend/admin/js/rutas.js`
- `cargarPedidosDespachables()`: el chequeo de "pedido ya en ruta" ahora
  hace `select('pedido_id, rutas!inner(estado)')` y excluye del bloqueo las
  entregas cuya ruta esté `completada` o `cancelada`.
- El filtro de fecha pasa de `fecha_entrega === fecha` a
  `fecha_entrega <= fecha` (además del caso sin fecha) — la lista ahora
  muestra atrasados + los del día seleccionado, no solo el match exacto.
- `cardPedidoHtml()`: los pedidos con `fecha_entrega` anterior a hoy se
  marcan en rojo con "· Atrasado" al lado de la fecha, para no
  confundirlos con los del día en la vista agrupada.

`frontend/admin/rutas.html`
- Bump de cache-busting `rutas.js?v=20260820-1` → `?v=20260820-2`.

## Pendiente — decisión de Luc (NO se tocó automáticamente)

No se modificó ningún registro histórico en la base. Los 145 registros de
`entregas` huérfanas (ruta completada, entrega sin cerrar) siguen como
están — corregir el código evita que sigan bloqueando pedidos nuevos, pero
no dice qué pasó realmente con esas entregas viejas. Antes de tocar datos
históricos hace falta que Luc decida: ¿esas entregas realmente se
completaron en la calle y solo faltó cerrarlas en el sistema (marcarlas
`entregado`), o corresponden a pedidos que hay que reprogramar/cancelar? Es
una decisión operativa/contable (impacta cobranzas, cheques, reportes de
rentabilidad por ruta) que no corresponde tomar por default vía migración.
