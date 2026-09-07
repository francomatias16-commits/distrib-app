# v1065 — Fix: ambigüedad real en `anular_factura`/`emitir_factura` tiraba un string ciego en vez de un `ambiguo()` con candidatos

Cierre del pendiente de comportamiento (no de formato) señalado durante la
Fase 3 de migración de tools del asistente (lote 7, 13/16 archivos por
dominio) en `facturacion-formato-error.test.js`.

## Problema

En `execute()` de `anular_factura` y `emitir_factura`, cuando
`resolverFacturaParaAnular` / `resolverPedidoParaFacturar` volvían a
encontrar ambigüedad al confirmar (pudo cambiar entre el `resumen()` y el
click de "Confirmar" — ej. el cliente pasa a tener 2+ facturas/pedidos
recientes en vez de 1), se tiraba un string genérico:

> "La referencia sigue siendo ambigua; pedile al usuario que elija una de
> las opciones mostradas."

sin la lista real de candidatos — a diferencia de `pedidos.js`, que en sus
tools de solo lectura (`diagnosticar_pedido`/`presupuesto`) hace `return
resuelto.ambiguo` y sí preserva los candidatos.

No alcanzaba con copiar ese mismo patrón acá: `anular_factura` y
`emitir_factura` son `requiereConfirmacion: true`, así que `execute()` se
llama desde `resolverAccionPendiente()` (`lib/asistente-tools/index.js`),
que interpreta cualquier valor devuelto sin `throw` como éxito y arma
"Listo, hecho: `<resumen>`" sin mirar el contenido — devolver
`{ambiguo:true, candidatos}` ahí haría creer al usuario que la factura se
anuló / el pedido se facturó, cuando no pasó nada.

## Fix

- `lib/asistente-tools/facturacion.js`: en ambas tools, cuando
  `resuelto.ambiguo` es true se arma la lista de candidatos (`id` +
  `label` con referencia corta, fecha y total) y se tira un error
  `ambiguo()` real (tipo 2 del contrato de `_respuestas.js`, mismo que ya
  usa el resto de las tools migradas) en vez del string genérico.
- `lib/asistente-tools/_helpers.js`: se agregó `ambiguo` al bloque de
  re-exports (importaba de `_respuestas.js` pero nunca se re-exportaba,
  porque hasta ahora ningún archivo de dominio lo necesitaba vía este
  archivo) — sin esto, `facturacion.js` recibía `undefined` al importar
  `ambiguo` desde `_helpers.js`.

## Nota (fuera de alcance de esta migración)

La rama de confirmación (`resolverAccionPendiente` + el catch de
`lib/handlers/asistente.js`) todavía no propaga `.opciones` como sí hace
el loop normal del modelo (ver `extraerOpcionesAmbiguas`) — así que en
esta rama puntual el usuario ve la lista como texto plano dentro del
mensaje de error, no como botones tappable. Requeriría tocar la capa de
handlers/frontend.

## Tests

`tests/asistente/facturacion-ambiguedad-execute.test.js` (nuevo, 2 tests):
cubre el caso de 2+ facturas para `anular_factura` y 2+ pedidos para
`emitir_factura`, verificando que el error tirado trae `.opciones` con los
candidatos reales y que el mensaje incluye la lista numerada.

Suite completa: 118 archivos, 1632 tests, todos OK.

## Estado de la Fase 3

Con este fix quedan cerrados los 13/16 archivos de tools migrados y el
único pendiente de comportamiento documentado en changelogs anteriores.
Fase 3 completa en su alcance original.
