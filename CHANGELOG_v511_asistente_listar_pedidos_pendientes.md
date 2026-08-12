# v511 — Asistente: dejó de inventar pedidos pendientes

## Problema reportado

En la captura del chat widget, ante "pasame todos los pedidos pendientes" el
asistente respondió con una lista de 3 pedidos — "Cliente XXX, 5 items",
"Cliente YYY, 3 items", "Cliente ZZZ, 2 items" — y después pidió el ID corto
de cada uno "para darte más información". Esos datos no salen de ningún
lado real: la única tool que existía para "pedidos pendientes"
(`contar_pedidos_pendientes`) devuelve solamente un total agrupado por
estado, sin nombre de cliente ni items. El modelo, al no tener con qué
responder la pregunta real, inventó una lista de ejemplo con nombres
genéricos y la presentó como si fuera un dato de la cuenta.

De fondo, dos problemas separados:
1. Faltaba una tool que devolviera el detalle de pedidos pendientes uno por
   uno (no solo el conteo).
2. El prompt del sistema no prohibía explícitamente fabricar datos cuando no
   hay una tool que cubra la pregunta, y empujaba a pedir el ID corto de
   forma reactiva incluso cuando el usuario todavía no había pedido nada que
   lo necesitara.

## Cambios

### `lib/asistente-tools.js`

- Tool nueva `listar_pedidos_pendientes`: mismo criterio de "pendiente" que
  la RPC `contar_pedidos_pendientes` (196: no entregado ni cancelado), mismo
  patrón de query directa scopeada por `empresa_id` que ya usa
  `consultar_pedidos_sugeridos_piloto` (sin necesidad de una RPC nueva).
  Devuelve cliente, estado, total, cantidad de items y una
  `referencia_corta` (últimos 6 caracteres del id, mismo formato que se ve
  en el panel) para que, si después preguntan por uno puntual, el modelo
  pueda usar `diagnosticar_pedido` con esa referencia sin volver a
  pedírsela al usuario.
- `contar_pedidos_pendientes` ahora aclara en su descripción que es solo
  para el total/conteo, y deriva al modelo hacia `listar_pedidos_pendientes`
  cuando lo que piden es el detalle.

### `lib/handlers/asistente.js`

- `armarSystemPrompt()`: se reescribió el bloque de instrucciones sobre
  tools para que el modelo (a) priorice siempre llamar la tool que
  corresponda antes de responder un dato puntual, (b) nunca complete con un
  ejemplo o dato inventado cuando ninguna tool cubre la pregunta — que lo
  diga con honestidad en cambio, y (c) no pida el ID corto (u otro dato) de
  forma reactiva "por las dudas": solo cuando la acción puntual que el
  usuario ya pidió realmente lo necesita, y reusando la referencia de una
  lista ya mostrada en el mismo chat en vez de volver a pedirla.

## Archivos modificados

- `lib/asistente-tools.js`
- `lib/handlers/asistente.js`
