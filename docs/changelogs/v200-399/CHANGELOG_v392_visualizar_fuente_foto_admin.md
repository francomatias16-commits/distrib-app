# v392 — Visualizar y filtrar por origen de la foto en el admin

## Motivación
No había forma de ver desde la interfaz si las fotos cargadas por
auto-imagenes eran reales o genéricas — el `prod-avatar` de la tabla de
Productos siempre mostraba las iniciales, nunca la foto real (aunque
`foto_url` estuviera cargado). Tampoco había filtro para aislar productos
según el origen de su foto.

## Solución
### Base de datos
- `fn_productos_lista` ahora expone `foto_fuente` y acepta `p_foto_fuente`
  ('real' | 'generica' | 'sin_foto' | NULL sin filtro). "Real" incluye
  barcode (Open Food/Products Facts), Google Images, y subida manual
  (foto_fuente NULL pero foto_url no nulo) — todas son fotos que alguien
  (auto-carga con match real, o el propio admin) puso a propósito, a
  diferencia de "generica" (Pexels, banco de fotos).

### Interfaz (frontend/admin/js/productos.js, productos.html, productos.css)
- La tabla de Productos ahora muestra la **foto real** en miniatura (36x36,
  mismo tamaño que el avatar de iniciales) cuando el producto tiene
  `foto_url`. Si la imagen no carga (URL rota), cae de nuevo a las
  iniciales automáticamente (`onerror`).
- Punto de color en la esquina del thumbnail: **verde** = foto real,
  **ámbar** = foto genérica de banco. Con tooltip nativo (`title`) explicando
  cada uno.
- Nuevo filtro "Todas las fotos / Foto real / Foto genérica / Sin foto" en
  la barra de filtros, junto a estado y categoría — mismo patrón visual que
  los filtros existentes.

## Cómo usarlo
Filtrar por "Foto genérica" para ver de un vistazo cuántos productos
quedaron con imagen de banco (candidatos a revisar manualmente o volver a
correr con mejor información de nombre/marca). Filtrar por "Sin foto" para
ver qué falta procesar.
