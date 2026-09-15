# CHANGELOG v1089 — Buscador que rompía con comas/paréntesis (punto 3) y exportación de lista de precios (punto 7)

Dos puntos del audit, sin migración de base: todo Node + frontend.

---

## Punto 3 — El buscador no encontraba productos con coma o paréntesis en el nombre

### Reporte

*"El buscador no siempre encuentra el producto aunque esté escrito igual."*

### Causa raíz

`buscarProductosPos()` (`lib/repos/productos.js`) interpolaba el texto
del cajero **crudo** en los tres niveles del ranking:

```js
.or(`codigo.ilike.${term},nombre.ilike.${term}`)
```

La coma separa condiciones y los paréntesis agrupan **dentro de la
sintaxis de `.or()` de PostgREST**. Si el texto trae alguno de esos
caracteres, la condición se parte al medio: la búsqueda deja de ser la
que se pidió.

Sobre el catálogo real de la empresa piloto: **104 de 1458 productos
activos (7%)** tienen coma o paréntesis en el nombre. Caso típico:
`SECADOR GOMA SIMPLE HACENDOSA 40 CM (SIN CABO)`. El cajero escribía el
nombre **exacto** y no aparecía nada.

Lo llamativo: el escapeo ya existía en el repo, pero como **copia local**
en `lib/handlers/busqueda.js` (auditoría Etapa 2, v232) y en
`lib/handlers/proveedores.js`. Al no estar compartido, los buscadores que
nacieron después quedaron sin cubrir — incluido el del POS, que es el que
se usa todo el día contra un lector de código de barras.

### Solución

Nuevo **`lib/postgrest-filtros.js`** con `escaparFiltroPostgrest()` y
`likeContiene()`, una sola implementación para todo el proyecto. Se
aplica en:

- `buscarProductosPos()` — los tres niveles del ranking (exacto →
  prefijo → contiene). **Este era el bug reportado.**
- `buscarIdsProductos()` — buscador de la vista de Stock, mismo problema.
- `buscarProductosParaRemito()` — picker de remitos del chofer, ídem.
- `lib/asistente-tools/stock.js` — consulta de stock por texto del
  asistente, ídem.
- `lib/handlers/busqueda.js` y `lib/handlers/proveedores.js` — se borran
  las copias locales y pasan a importar el helper.

No se escapan `%` ni `_` (los comodines de ILIKE), a propósito: el `%` lo
pone el propio caller para armar el patrón, y un `_` haciendo de comodín
en un nombre matchea de más, nunca de menos.

### Tests

Dos tests nuevos en `tests/repos/productos.test.js`, con datos reales del
catálogo:

- `SECADOR GOMA SIMPLE HACENDOSA 40 CM (SIN CABO)` → verifica que el
  paréntesis viaja escapado en los tres niveles y que no queda ninguno
  suelto que PostgREST pueda leer como agrupación.
- `CAFE, TE Y MATE` → verifica que el filtro sigue teniendo 2
  condiciones y no 4 (que es lo que pasaba con la coma sin escapar).

---

## Punto 7 — Exportación de lista de precios

### Reporte

*"Solo hay CSV, no Excel real ni PDF"* — y, peor, *"el botón Exportar CSV
exporta únicamente la página que está viendo en pantalla"*.

### Causa raíz

`exportarProductos()` hacía `const lista = productosPage`, que es la
página de 50 filas que devolvió `fn_productos_lista` con LIMIT/OFFSET.
El archivo bajaba igual, sin ningún aviso: alguien que exportaba
esperando su catálogo entero se llevaba 50 productos y no tenía forma de
enterarse. Es el peor tipo de bug de export — falla en silencio y con
apariencia de éxito.

### Solución

Nuevo módulo **`frontend/admin/js/productos/exportar-lista.js`** (se saca
de `guardar-eliminar-producto.js`, que ya venía con cuatro
responsabilidades distintas):

1. **Exporta el filtro completo.** Vuelve a pedir `fn_productos_lista`
   con los **mismos** filtros activos (búsqueda, categoría, estado,
   mes/año, foto, etiqueta) y el mismo orden, pero con `p_limit` alto y
   `p_offset` 0. Tope de 5000 filas; si se alcanza, se avisa
   explícitamente con un toast y se sugiere filtrar por categoría — nunca
   se recorta en silencio.
2. **Excel real (.xlsx)** vía SheetJS: `aoa_to_sheet` para fijar el orden
   de columnas y que los números queden como número en la celda (la
   diferencia concreta contra renombrar un CSV), con anchos de columna y
   autofiltro en la fila de encabezado.
3. **PDF** vía jsPDF + autotable: apaisado (con 10 columnas, en vertical
   el nombre del producto se parte en tres renglones), encabezado con
   nombre de empresa, fecha, cantidad de productos y **qué filtros se
   aplicaron**, y numeración de páginas al pie — una lista de 1500
   productos son ~40 páginas y se imprime para repartir.

Las dos librerías se cargan por CDN **recién al primer uso**, mismo
patrón que ya usa `dashboard-ejecutivo.js`: no suman peso a la carga
inicial de Productos.

El CSV mantiene el BOM UTF-8 para que Excel en español no rompa acentos
ni la ñ, y suma dos columnas que antes no salían (Código y Stock
mínimo).

### UI

El menú "Más funciones" pasa de un único *Exportar CSV* a tres entradas:
**Exportar a Excel**, **Exportar a PDF** y **Exportar a CSV**, las tres
con `btnAsyncClick` (anti doble click, ya que ahora hay una llamada de
red y una descarga de librería de por medio).

---

## Verificación

- `tests/repos` + `tests/handlers` + `tests/frontend`: **1163 tests en
  verde** (100 archivos).
- `scripts/check-asset-wiring.js`: 0 referencias rotas.
- `scripts/audit-bridges-window.js`: `productos.html` OK (los 2 FAIL que
  reporta son de `clientes.html` y son previos a este cambio).

## Cómo probarlo

**Punto 3:** en el POS, buscar un producto cuyo nombre tenga paréntesis
(ej. `(SIN CABO)`) escribiendo el nombre completo con el paréntesis
incluido. Antes no devolvía nada; ahora aparece.

**Punto 7:** en Productos, poner un filtro que dé más de 50 resultados
(ej. estado "activo" sin más filtros) y exportar en cualquiera de los
tres formatos. El archivo tiene que traer **todos** los productos del
filtro, no los 50 de la página. El PDF además tiene que declarar el
filtro aplicado en el encabezado.
