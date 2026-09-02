# Selección masiva para "Generar etiquetas" (v979)

## Problema
En Productos, la única forma de armar la selección para generar etiquetas
era tildar fila por fila. El checkbox de cabecera "seleccionar todos" solo
tilda los productos VISIBLES en la página actual (50 por página) — para
etiquetar, por ejemplo, 300 productos, había que ir página por página
tildando "seleccionar todos" 6 veces.

## Fix
Cuando la página actual ya está 100% tildada y todavía quedan más
resultados sin seleccionar (más páginas del mismo filtro/búsqueda), la
barra flotante ahora muestra un link **"Seleccionar los N resultados"**
que trae de una sola vez los ids de TODO el resultado filtrado — no solo
la página visible — reutilizando `fn_productos_lista` con los mismos
parámetros de filtro/búsqueda que ya usa la carga normal de la grilla,
pero con `p_limit` alto y `p_offset=0`.

Con eso seleccionado, "Generar etiquetas" abre la vista previa con todos
los productos de una sola vez, sin tener que ir producto por producto ni
página por página.

## Límite
Se respeta el mismo tope que ya tenía el backend
(`MAX_IDS_ETIQUETAS = 500` en `lib/handlers/etiquetas.js`, que limita
cuántos ids acepta `POST /api/etiquetas/productos` por request). Si el
filtro activo trae más de 500 productos, el link no selecciona nada y
avisa con un toast que conviene achicar el filtro (por categoría,
etiqueta o mes) y repetir en tandas — no se cortan los primeros 500 en
silencio, porque eso dejaría afuera productos sin que el usuario se dé
cuenta.

## Archivos tocados
- `frontend/admin/js/productos.js` (v288): nueva función
  `seleccionarTodosLosResultados()`, `actualizarBarraEtiquetas()` ahora
  muestra el link condicionalmente.
- `frontend/admin/css/productos.css` (v238): estilo del link
  `.prod-link-seleccionar-todos`.

## No tocado
- El backend (`lib/handlers/etiquetas.js`, `lib/repos/etiquetas.js`,
  `etiquetas-print.js`, `etiquetas-preview.js`) no necesitó cambios — el
  flujo de vista previa/impresión ya soportaba cualquier cantidad de ids
  dentro del tope existente, solo faltaba una forma de juntarlos sin
  tildar uno por uno.
