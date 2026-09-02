# v802 — Fix: el picker de Devoluciones no mostraba ningún producto para clientes cuyo historial es solo de productos dados de baja

## Problema
Al crear una devolución, para ciertos clientes el `ProductoPicker` no
mostraba **ningún** producto —ni con el buscador vacío ni probando
cualquier término—, aunque el cliente sí tenía compras registradas.

## Causa raíz
`ndDesbloquearPickerParaCliente()` traía solo los `producto_id`
comprados por el cliente y el picker cruzaba (`intersect`) esos ids
contra `this._productos`, la lista que carga `_cargarProductos()` —la
cual sólo trae productos **activos**.

Si el historial de compras de un cliente son productos que hoy están
dados de baja (`activo: false`, por ejemplo se descontinuaron después
de la compra), la intersección da vacía siempre, sin importar el
filtro de categoría o de búsqueda. Es un caso real y válido: un
producto discontinuado igual se puede devolver si se compró.

## Fix
- `frontend/admin/js/devoluciones.js` → `ndDesbloquearPickerParaCliente()`:
  ahora se trae la fila completa del producto (`producto_id,
  productos(id, codigo, nombre, unidad, precio_base, foto_url,
  categoria_id, activo), pedidos!inner(...)`) en vez de solo el id, sin
  filtrar por `activo`. Si el producto fue eliminado del todo (no solo
  dado de baja) y el join devuelve `null`, se descarta —no hay nada
  que mostrar.
- `frontend/admin/js/producto-picker.js`:
  - `setSoloPermitidos()` ahora recibe las filas completas de producto
    (antes solo ids) y las guarda en `_soloPermitidosProductos`.
  - `_filtrar()`: cuando hay restricción activa (modo Devoluciones),
    esa lista de filas es la base del grid directamente —ya no se
    intersecta con `_productos` (que descarta los inactivos).
  - Mensaje de estado vacío actualizado a usar el nuevo campo.
  - Se agrega un badge "Discontinuado" en la tarjeta cuando
    `activo === false`, para que quede claro en el modo restringido
    por qué aparece un producto que ya no está disponible para pedidos
    nuevos.
- `frontend/admin/css/producto-picker.css`: estilo del badge
  `.pp-card-discontinuado`.

## Alcance
Solo afecta el modo restringido del picker (Devoluciones). El picker
de Presupuestos/Pedidos no llama `setSoloPermitidos()`, así que no
cambia su comportamiento.

## Verificación contra datos reales
Se confirmó contra la base que esto **no es un caso raro**: para varios
clientes de prueba, el 85–100% de los productos que compraron alguna
vez están hoy dados de baja (67 de 999 productos en total están
inactivos, pero son justamente los que concentran la mayor parte del
historial de pedidos viejo). Sin este fix, el picker de Devoluciones
quedaba vacío para la gran mayoría de los clientes, no solo para un
caso extremo aislado.

## Dos cosas más que quedaban pendientes tras el primer pase del fix

1. **`_agregarVarios()` (vista "Lista") seguía resolviendo contra
   `this._productos`** (el catálogo de activos) en vez de contra la
   lista efectivamente mostrada en pantalla. Con eso, aunque las
   tarjetas/filas de un producto discontinuado sí se veían, el botón
   "Agregar seleccionados" las descartaba en silencio (`porId.get()`
   devolvía `undefined`). Ahora resuelve contra `this._filtrar()` —la
   misma base que ya usa `_pintarLista()`—, así que cubre tanto el
   catálogo activo normal como los productos permitidos por historial.

2. **Cache-busting de assets sin bumpear.** `devoluciones.html` y
   `pedidos.html` seguían referenciando `producto-picker.js?v196`,
   `producto-picker.css?v=196` y `devoluciones.js?v284` — con el
   Service Worker del admin en modo Network-First para JS/CSS
   (`sw-admin.js`), el `fetch()` de ese Network-First igual puede
   resolverse contra la caché HTTP del navegador/CDN si la URL no
   cambió, dejando al usuario con el JS viejo pese al deploy nuevo.
   Bumpeados a `?v197` / `?v=197` / `?v285` en ambos HTML.
