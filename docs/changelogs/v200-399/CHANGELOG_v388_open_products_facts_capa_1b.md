# v388 — Capa 1b: Open Products Facts para no-alimentos

## Problema
La auto-carga de imágenes (`/api/auto-imagenes`) devolvía 0 fotos incluso con
cientos de productos procesados y códigos de barra EAN-13 argentinos válidos
(prefijo 779...). Causa: la Capa 1 consulta Open Food Facts, que es
específicamente una base de datos de **alimentos y bebidas**. Catálogos de
limpieza/bazar/perfumería/ferretería (acondicionadores, detergentes,
lavandina, escobillones, etc.) no están ahí por definición del proyecto, sin
importar si el código de barra es válido o no.

## Solución
Se agregó una Capa 1b entre la Capa 1 (Open Food Facts) y la Capa 2 (Pexels,
opt-in): si el código de barra es válido pero no matcheó en Open Food Facts,
se prueba contra **Open Products Facts** (world.openproductsfacts.org),
el proyecto hermano orientado a productos no alimenticios. Misma API, mismo
formato de respuesta, gratis, sin key.

## Archivos tocados
- `lib/handlers/auto-imagenes.js`
  - Nueva función `buscarPorOpenProductsFacts(codigo)`.
  - `resolverImagenProducto()` ahora prueba Open Food Facts → Open Products
    Facts → (opcional) Pexels, en ese orden.
  - `fuente: 'openproductsfacts'` para poder diferenciar en el detalle de
    resultado si hace falta a futuro.

## Sin cambios de compatibilidad
- El frontend (`buscarImagenesAutomaticas` en `productos.js`) no necesitó
  cambios: solo distingue `fuente === 'pexels'` para el contador de "banco
  de fotos genéricas"; `openfoodfacts` y `openproductsfacts` caen juntos como
  fotos reales del producto.
- No cambia el contrato de la respuesta del endpoint ni el rate limit.
