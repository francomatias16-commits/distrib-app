# CHANGELOG v227 — Nueva interfaz de tabla de Productos

## Alcance

Rediseño completo de la sección **Productos** (`frontend/admin/productos.html`)
con una interfaz de tabla moderna al estilo SaaS, inspirada en plataformas como
Linear, Attio y dashboards de afiliados de alto nivel.

## Archivos nuevos / modificados

```
frontend/admin/productos.html        ← página principal rediseñada
frontend/admin/css/productos.css     ← estilos de la nueva interfaz (v227)
frontend/admin/js/productos.js       ← lógica JS con carga desde Supabase (v227)
```

## Qué cambió visualmente

### 1. Tarjeta contenedora
- Fondo blanco con `border-radius: 12px` y sombra difuminada suave.
- Fondo de página en crema cálida (`#f7f4ef`).

### 2. Toolbar superior
- Título "Productos" + subtexto gris.
- Link de alertas ("X cerrados / Y requieren atención") alineado a la derecha.
- Filtros en pill (bordes redondeados): "Filtrar por / Este mes" y buscador de etiquetas.
- Iconos de búsqueda, exportación CSV y botón "+" para agregar producto.

### 3. Navegación por meses
- Año + pestañas Jan–Dic con indicador activo en violeta suave (`#e8e6f8 / #5b5bd6`).
- Botón "Editar columnas" alineado a la derecha.

### 4. Tabla rediseñada

| Columna anterior | Columna nueva |
|---|---|
| Nombre (texto) | **Nombre** con avatar de iniciales de color por categoría |
| Categoría | **Categoría** |
| Estado (texto) | **Estado** con badge/píldora coloreada (Activo verde, Borrador azul, Sin Stock rojo) |
| Fecha | **Última Act.** (fecha + hora) |
| Precio | **Precio** (negrita) |
| Costo | **Costo** (gris) |
| Stock | **Stock** (unidades) |
| — | **Margen** (donut SVG animado con %) |
| — | **Ventas Goal** (barra de progreso verde) |
| Acciones | **Menú ⋮** (tres puntos) |

- Sin bordes verticales.
- Hover sutil por fila (`#f9f9ff`).
- Checkboxes funcionales: selección individual y "seleccionar todos".
- Donut chart implementado en SVG puro (sin librerías).
- Progress bar en CSS puro (sin librerías).

## Cambios técnicos

### `productos.js`
- Carga desde `supabase.from('productos').select(...)` con join a `categorias`.
- `normalizar()` transforma el registro de BD al modelo de UI (calcula margen, goal, estado).
- Modo demo sin Supabase: si `window.SUPABASE_URL` no está configurado, carga
  `datosDemoEstaticos()` para visualizar la interfaz igualmente.
- Exportación a CSV con BOM UTF-8 (compatible con Excel en español).
- Escape de HTML en todos los campos dinámicos (previene XSS).
- `escHtml()` aplicado a todos los valores interpolados en `innerHTML`.

### `productos.css`
- Clases con prefijo `.prod-*` para evitar colisiones con el CSS compartido.
- Compatible con `shared/base-layout.css` y `shared/adminlte-components.css`.
- Responsive: colapso a columna única en ≤ 900px y ≤ 600px.
- Cache-bust: cargar con `?v=227` en la referencia del HTML.

## Integración con el resto del proyecto

La página referencia los mismos CSS compartidos del proyecto:
- `../shared/base-layout.css`
- `../shared/adminlte-components.css`
- `../shared/nav.css`

Y las mismas variables de Supabase ya configuradas en el proyecto
(`window.SUPABASE_URL`, `window.SUPABASE_ANON_KEY`).

## Verificación recomendada

1. Smoke test visual en Chrome DevTools responsive (360px / 768px / 1280px).
2. Verificar que la carga desde Supabase devuelva datos reales (o que el modo
   demo se active correctamente si las variables no están seteadas).
3. Confirmar que el CSV exportado se abra correctamente en Excel con tildes.
