# v481 — Menú "Más funciones" agrupa Importar/Exportar/Buscar imágenes (Productos)

## Problema (reportado por Ruben con captura)
En la sección Productos, "Buscar imágenes automáticamente" era un ícono de
15x15px sin texto, apretado en la fila de filtros — solo identificable por
el ícono y un tooltip. Además "Importar" y "Exportar CSV" vivían sueltos en
el topbar, sin relación visual con esa otra función aunque las tres son del
mismo tipo: gestión masiva del catálogo (a diferencia de "Agregar producto"
o "Columnas", de uso más frecuente/puntual).

## Fix
`frontend/admin/productos.html`
- Los tres botones (Importar, Exportar CSV, Buscar imágenes
  automáticamente) se agrupan en un único menú desplegable **"Más
  funciones"** en el topbar, con:
  - Ícono representativo por opción.
  - Texto de la acción (`<strong>`) + una descripción corta (`<small>`)
    aclarando qué hace cada una.
- Se sacó el ícono duplicado de "Buscar imágenes automáticamente" de la fila
  de filtros (quedaba redundante con el nuevo menú).
- Se mantienen sin tocar: "Agregar producto" (+, botón azul de uso
  frecuente), "Limpiar filtros" (contextual a los filtros activos) y
  "Columnas" (ya era texto visible, no hacía falta agruparlo).
- Bump de cache-busting: `productos.css?v=231→232`, `productos.js?v=280→281`.

`frontend/admin/js/productos.js`
- `toggleMenuMasFunciones(ev)` / `cerrarMenuMasFunciones()`: abre/cierra el
  menú, actualiza `aria-expanded` para el ícono de chevron animado.
- Cierre al hacer click afuera (`document.addEventListener('click', ...)`
  chequeando `.topbar-more-wrap`) y con `Escape` — mismo patrón que otros
  dropdowns de la app.
- Los `onclick` de Exportar y Buscar imágenes llaman primero
  `cerrarMenuMasFunciones()` y después la función real
  (`exportarProductos()` / `btnAsyncClick(this, buscarImagenesAutomaticas)`)
  — comportamiento de esas dos funciones intacto, solo cambia que ahora
  además cierran el menú.
- Importar sigue siendo el mismo `<a href="/admin/migracion">` de siempre
  (navegación directa, no dispara JS).

`frontend/admin/css/productos.css`
- Estilos nuevos: `.topbar-more-wrap`, `.btn-mas-funciones`,
  `.menu-mas-funciones`, `.menu-mas-funciones-item` (con `strong`/`small`
  para título y descripción). Responsive: en `max-width:640px` el menú se
  alinea a la izquierda para no salirse de la pantalla.
- No se tocó `productos-gentelella.css`: sus overrides `!important` apuntan
  a clases específicas (`.btn-exportar`, `.btn-primario`, etc.) que ya no
  se usan en este topbar — no hay colisión ni hacía falta agregar overrides
  ahí, los estilos nuevos se ven igual con o sin el reskin activo.

## Verificación
- `node --check` en `productos.js` y en el JS inline de `productos.html` →
  OK.
- Balance de `<div>` (72/72) y de llaves CSS (175/175) en los archivos
  tocados, tras mover/eliminar bloques.
- Confirmado que ninguna otra página del admin usa `.btn-mas-funciones` /
  `.menu-mas-funciones` — nombres de clase nuevos, sin conflicto con los
  estilos compartidos (`reskin-patch.css`) que sí siguen aplicando a
  `.btn-exportar`/`.btn-importar` en el resto de las secciones (Clientes,
  Rutas, Stock, etc., que no se tocaron).
