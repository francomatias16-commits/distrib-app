# v905 — Devoluciones: buscador de productos en lista compacta (no cards)

## Pedido
"No me lo presentes en esos tipos de recuadros con la imagen. Únicamente
una lista con los productos... para poder seleccionar los productos y
hacer la devolución sin tanta compilación [complicación]."

## Cambio
El `ProductoPicker` compartido (usado también en Pedidos y Presupuestos)
ahora soporta un segundo modo de presentación además del grid de cards con
imagen:

- **`modo: 'grid'`** (default, sin cambios) — cards con foto, usado en
  Pedidos y Presupuestos, donde tiene sentido explorar el catálogo
  visualmente.
- **`modo: 'lista'`** (nuevo) — filas compactas de una sola línea: nombre,
  código y unidad a la izquierda, precio, cantidad y botón "+" a la
  derecha. Sin imagen, sin recuadro tipo tarjeta. Se activó específicamente
  en **Devoluciones**, donde el admin ya sabe qué está buscando (viene
  filtrado por el historial de un cliente o de un pedido puntual — ver
  v904) y necesita tildar varios ítems rápido, no explorar visualmente.

Mismo criterio de usabilidad que se agregó en v904 para las cards: en modo
lista, **hacer clic en cualquier parte de la fila** agrega el producto
(no hace falta apuntarle al botón chico), con la cantidad cargada en el
input. El input de cantidad sigue siendo editable sin disparar el alta.

### Archivos modificados
- `frontend/admin/js/producto-picker.js`
  - Constructor acepta `opts.modo` (`'grid'` | `'lista'`).
  - `_pintarGrid()` delega a un nuevo método `_pintarListaCompacta()`
    cuando `modo === 'lista'`.
  - El contenedor de resultados usa la clase `pp-list` en vez de `pp-grid`
    en ese modo (mismo `id`, así que el resto del código —empty state,
    loading, etc.— no necesitó tocarse).
- `frontend/admin/css/producto-picker.css`
  - Estilos nuevos: `.pp-list`, `.pp-row`, `.pp-row-info`,
    `.pp-row-nombre`, `.pp-row-meta`, `.pp-row-precio`, `.pp-row-add`,
    `.pp-btn-add-mini`. No se tocó ningún estilo de `.pp-card` existente
    (Pedidos/Presupuestos quedan exactamente igual).
- `frontend/admin/js/devoluciones.js`
  - `new window.ProductoPicker(container, { modo: 'lista', onAgregar })`.
- `frontend/admin/css/devoluciones-gentelella.css`
  - El límite de alto que ya achicaba `.pp-grid` dentro del modal (para
    evitar doble scrollbar) ahora también aplica a `.pp-list`.
- `frontend/admin/devoluciones.html` / `frontend/admin/pedidos.html`
  - Bump de versión (`?v=905`) en `producto-picker.css`/`.js` para evitar
    que quede cacheada la versión anterior (mismo motivo que en v904).

## Validación
`node --check` en `devoluciones.js` y `producto-picker.js` → OK.
Pedidos y Presupuestos no cambiaron: siguen usando el modo `'grid'` por
default (no pasan `opts.modo`), sin ningún cambio de comportamiento.
