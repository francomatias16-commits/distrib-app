# v587 — Fase 7, paso 8, lote 4 (sub-lote 2: router principal)

## Router principal de `/api/pedidos` (GET/PATCH/DELETE)

Sub-lote 2 del lote 4. Cubre el `handler` exportado por defecto completo:

- **`GET ?id=`** — detalle de pedido con cliente/vendedor/ítems, más el
  chequeo de acceso del portal cliente (resolver `cliente_id` por sesión
  o por email legacy).
- **`GET`** (lista) — paginada, con los filtros dinámicos originales
  (`estado`, `cliente_id`, `vendedor_id`, `zona_id`, rango de fechas,
  `sin_facturar`, `sin_despachar`) y el mismo criterio de scoping por
  cliente para el portal.
- **`PATCH`** — cambio de estado/notas internas (admin).
- **`DELETE ?accion=eliminar`** — borrado físico, con la validación de
  facturas emitidas con CAE (no se puede borrar) vs. facturas huérfanas
  (se borran junto con el pedido).
- **`DELETE`** (cancelar) — el más largo: libera stock reservado ítem por
  ítem (eligiendo depósito principal o el de mayor stock como fallback),
  revierte puntos de fidelización ya acreditados, y anula/emite NC de las
  facturas vinculadas según tengan CAE o no.

**17 funciones nuevas en `lib/repos/pedidos.js`.** La más relevante es
`listarPedidosFiltrados`, que replica el mismo patrón de query dinámica
que `listarDevolucionesFiltradas` (lote 3): el armado condicional de
filtros vive en el repo, no en el handler. El resto son lecturas/escrituras
puntuales (perfil, detalle, resolución de cliente por email, ítems/stock
para liberar reserva, marcar cancelado, RPC de reversión de puntos,
facturas vinculadas).

**Reuso:** `liberarStockReservadoRpc` ya existía desde el lote 1
(compartida con la conversión presupuesto→pedido) — se reusa acá para el
circuito de cancelación en vez de duplicarla.

**Sin cambios de comportamiento**, incluyendo un detalle a tener en cuenta:
se replicó tal cual el comportamiento existente de la rama `!esAdmin` en
la lista — si no se puede resolver el `cliente_id` del usuario (ni por
sesión ni por email), la consulta **no filtra** y devuelve todos los
pedidos de la empresa. No se corrigió en este lote porque el alcance es
mover acceso a datos, no tocar lógica de negocio; queda anotado por si se
quiere revisar aparte.

**Resultado:** `grep -c "\.from(" lib/handlers/pedidos.js` (tablas reales):
37 → **14**. Quedan `verPedidoSugeridoHandler`,
`confirmarPedidoSugeridoHandler`, `crearPedidoParaCliente`,
`crearPedidoAdminHandler` y `confirmarPedidoHandler` — la alta de pedido
desde cero con reserva de stock y rollback. Es el núcleo más sensible del
archivo y el único que queda de todo el paso 8.

**Tests:** suite completa **671/671 OK**. Sin casos nuevos todavía — se
van a sumar tests dedicados junto con el sub-lote final, que es donde vive
la lógica con más ramas (reserva de stock con rollback si falla la
creación del pedido).
