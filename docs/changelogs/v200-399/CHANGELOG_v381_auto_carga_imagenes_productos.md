# v381 — Auto-carga de imágenes de productos

## Motivación

En productos importados por lista de precios (ej. distribuidoras de
ferretería, almacén, etc.) es habitual tener nombre, precio y código, pero
nunca foto. Cargarlas a mano una por una no escala (probado sobre el tenant
"Distribuidora del Litoral S.A.": 1001 de 1003 productos sin `foto_url`).

## Qué se agregó

- **`lib/handlers/auto-imagenes.js`** — nuevo módulo del dispatcher
  (`POST /api/auto-imagenes`, rewrite en `vercel.json`, registrado en
  `api/index.js`). Busca imagen para productos con `foto_url IS NULL` en
  lotes de hasta 50, en dos capas:
  1. **Barcode real** (si `codigo` es EAN-8/12/13 válido) → Open Food
     Facts (gratis, sin key, foto real del producto).
  2. **Banco de fotos por nombre** (fallback) → Pexels API (gratis,
     requiere `PEXELS_API_KEY`), foto representativa del tipo de producto,
     no necesariamente la marca exacta.

  Lo que no encuentra match en ninguna capa queda con `foto_url = null` a
  propósito — no se guarda una URL inventada. El frontend de catálogo debe
  interpretar `foto_url = null` como "mostrar ícono SVG de la categoría",
  no como error.

  Las imágenes se normalizan con `sharp` (800x800, fondo blanco, JPEG
  calidad 82) antes de subirse al bucket `productos-fotos` ya existente,
  reutilizando el mismo patrón de `nombreArchivo` que la carga manual en
  `productos.js`.

- **`frontend/admin/productos.html` / `productos.js`** — botón "Buscar
  imágenes automáticamente" en la toolbar de Productos. Llama al endpoint
  en loop (lotes de 20) hasta agotar los pendientes, con feedback vía
  `toast()`.

## Fix post-deploy (mismo día)

Se detectó que el botón se quedaba colgado en "Buscando imágenes…": el lote
de 20 productos se procesaba secuencial (uno por uno), y eso podía superar
el límite de 60s de `maxDuration` del plan Hobby — Vercel mataba la función
a mitad de camino y el navegador quedaba esperando una respuesta que nunca
llegaba.

- Lote por defecto bajado de 20 a 8 (máximo 15) y se procesa en **paralelo**
  (`Promise.all`) en vez de secuencial — el lote tarda lo que tarda el
  producto más lento, no la suma de todos.
- El frontend ahora tiene `AbortController` con timeout de 55s (por debajo
  del límite de 60s de la función) — si un lote se cuelga, avisa en vez de
  quedar tildado para siempre, y el proceso se puede reintentar desde donde
  quedó.
- Toast de progreso por tanda ("Tanda N: X/Y con foto — quedan Z"), en vez
  de un solo mensaje estático durante todo el proceso.

## Fix #2 (mismo día): Capa 2 (banco de fotos) pasa a ser opt-in

Prueba real en el admin: para "Agua Mineral x1 un" la Capa 2 devolvió una
foto de rocas. Causa: Pexels indexa en inglés, y "mineral" en inglés se
asocia a geología, no a agua — al buscar en español, le da más peso a esa
palabra que a "agua". El resultado es determinístico (misma foto siempre
para la misma query), por eso se repetía igual en varias filas.

Conclusión: una foto claramente incorrecta es peor que no tener foto (con
ícono de categoría como respaldo). Cambios:

- **Por defecto ahora solo se busca por código de barra real** (Capa 1,
  Open Food Facts) — match exacto, sin ambigüedad de idioma.
- La Capa 2 (Pexels, foto genérica por nombre) quedó **opt-in**: el botón
  pregunta explícitamente antes de incluirla, con la advertencia de que
  es representativa y puede no ser exacta.
- `PEXELS_API_KEY` ahora solo es obligatoria si se pide explícitamente
  incluir el banco de fotos (`incluirBancoFotos: true` en el body).
- Se sembraron 2 productos de prueba en el tenant demo
  ("Distribuidora del Litoral S.A.") con códigos de barra reales de
  productos argentinos para validar la Capa 1 en vivo:
  - `Agua Mineral x1 un` → `7790315000446` (Agua mineral Villavicencio 500ml)
  - `Aceite de Girasol x1 un` → `7790272001005` (Aceite de girasol Natura 900ml)

  Ambos tienen foto real confirmada en Open Food Facts — sirven para
  probar que la Capa 1 trae la foto correcta antes de decidir si vale la
  pena habilitar la Capa 2 para el resto del catálogo.

## Pendiente / decisiones para cuando se vaya a producción real

- **Variable de entorno nueva:** `PEXELS_API_KEY` — sacarla gratis en
  pexels.com/api (sin tarjeta) y agregarla en Vercel.
- **Atribución Pexels:** la licencia pide crédito visible cuando se usa su
  contenido ("Foto: Pexels" o similar). Hoy el resultado de `buscarPorPexels`
  devuelve `atribucion` (nombre del fotógrafo) pero no se persiste todavía
  porque `productos` no tiene columna para eso — si se generaliza esta
  feature a producción, agregar `foto_atribucion TEXT` y mostrarlo en la
  ficha del producto en el catálogo público.
- **Calidad del match:** Pexels da una foto *representativa*, no la foto
  exacta de la marca/SKU. Para catálogos reales (ej. cliente de
  ferretería con EAN reales en su lista de precios), la Capa 1
  (Open Food Facts u otra base de barcodes específica del rubro) es la que
  da fotos exactas — vale la pena pedirle al distribuidor que sus listas
  de precio incluyan el código de barras cuando lo tengan.
- **Google Custom Search API:** descartada a propósito — está cerrada
  para cuentas nuevas desde 2025 y Google discontinúa el servicio el
  1/1/2027 para las cuentas existentes.
