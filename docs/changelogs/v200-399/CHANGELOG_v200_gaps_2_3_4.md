# CHANGELOG v200 — Gaps 2/3/4 de UI (ventas POS, comprobantes históricos, direcciones)

Continúa v199 (que cubrió el gap 1: precios especiales). Con esta entrega
quedan los 4 gaps del changelog original completos.

## Gap 2 — Historial de ventas POS

**Backend** (`lib/handlers/pos.js`, `ventasHandler`):
- Agregados filtros `desde`/`hasta` (rango de fecha sobre `created_at`).
- Reemplazado el `limit(30)` fijo por `limit`/`offset` configurables
  (tope duro de 1000 para no reventar la función serverless).

**Frontend** (`pos.html` + `pos.js`, panel `panel-admin-ventas`):
- Inputs de fecha desde/hasta + select de estado + botón "Filtrar".
- Botón "Exportar Excel" (SheetJS, ya estaba cargado en `pos.html`) que
  exporta el resultado actualmente filtrado, no el historial completo —
  si se necesita exportar todo, hay que ampliar el rango de fechas primero.

## Gap 3 — Comprobantes históricos (solo lectura)

**Backend** (`lib/handlers/facturas.js`):
- Nueva sub-ruta `_svc=comprobantes-historicos`, mismo patrón de auth
  manual que `handleNotasCredito` (no pasa por el middleware principal del
  handler porque se resuelve antes en el dispatcher).
- `GET` con filtros `cliente_id`, `tipo` (factura/nota_credito/nota_debito),
  `desde`, `hasta`, `busqueda`. Sin POST/PATCH/DELETE — es intencionalmente
  de solo lectura, los datos entran únicamente vía wizard de migración.

**Frontend** (`facturacion.html`):
- Tercer tab "Comprobantes hist." junto a Facturas / Notas de crédito.
  Se generalizó `switchTab()` de booleano (2 estados) a 3 estados.
- Tabla con filtro por tipo, rango de fecha y búsqueda libre client-side.

## Gap 4 — Direcciones de entrega (el más grande: no existía nada)

Confirmé que el comentario en `migracion.js` ("ya existía vía
`lib/repos/cliente-direcciones.js`") era falso — ese archivo no estaba en
el repo. Se construyó CRUD completo desde cero:

**Backend nuevo**:
- `lib/repos/cliente-direcciones.js` (archivo nuevo): `listarDireccionesGlobal`,
  `listarDireccionesPorCliente`, `crearDireccion`, `actualizarDireccion`,
  `eliminarDireccion`.
  - Constraint real verificado en Supabase:
    `UNIQUE (empresa_id, cliente_id, domicilio)` — se traduce el error
    `23505` a un mensaje legible en vez de un 500 genérico.
  - **No hay trigger de DB** que garantice una sola dirección
    `es_principal=true` por cliente, así que se maneja a nivel aplicación:
    al crear/editar con `es_principal=true`, se desmarca cualquier otra
    dirección principal del mismo cliente en la misma operación.
- `lib/handlers/clientes.js`: sub-ruta `/api/clientes/direcciones` con
  GET/POST/PATCH/DELETE, mismo patrón que `/precios` y `/acceso`.

**Frontend** (`clientes.html` + `clientes.js`):
- Tercer toggle "Direcciones" (junto a Clientes / Precios especiales).
- Tabla global: cliente, etiqueta, domicilio, localidad, provincia, badge
  de principal, editar/eliminar.
- Modal de alta/edición. En edición, el select de cliente se bloquea (no
  tiene sentido reasignar una dirección existente a otro cliente — se
  borraría y cargaría de nuevo si hiciera falta).
- Tras guardar se fuerza una recarga completa de la tabla en vez de un
  merge local, porque marcar una dirección como principal puede
  desmarcar silenciosamente otra fila que ya estaba en pantalla.

## Verificado
- `node --check` sobre los 7 archivos `.js` tocados (3 handlers, 2 repos,
  2 frontend).
- Balance de tags `<div>`/`</div>` verificado en los 3 HTML tocados.
- Constraints de ambas tablas (`precios_clientes` en v199,
  `cliente_direcciones` acá) verificados contra el proyecto Supabase real
  antes de escribir cualquier insert/upsert.

## Pendiente / a criterio para una próxima pasada
- Ninguno de los 4 gaps quedó con escritura masiva (bulk edit, exportación
  completa sin límite, etc.) — son vistas administrativas básicas como
  pedía el changelog original, no rediseños completos de los módulos.
- El renderizado de las tres tablas nuevas no escapa HTML explícitamente
  (mismo criterio que el resto del código ya existente en `facturacion.html`
  / `notas-credito.js`, que tampoco lo hace) — si en algún momento se decide
  sanitizar, conviene hacerlo de una para todo el admin y no solo acá.
