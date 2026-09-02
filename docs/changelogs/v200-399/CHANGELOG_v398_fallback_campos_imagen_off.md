# v398 — Fallback a otros campos de imagen en Open Food Facts / Open Products Facts

## Motivación
De los 20 productos de prueba (bebidas/alimentos con barcode real), 13
consiguieron foto y 7 no — a pesar de ser marcas masivas (Coca-Cola, Fanta,
Milka/Oreo) con ficha de producto confirmada en Open Food Facts. La
hipótesis: en una base colaborativa, es común que exista una ficha de
producto con datos (nombre, ingredientes, etc.) pero sin que ninguna foto
haya sido marcada como "la seleccionada" (`image_url`) — puede haber fotos
cargadas bajo otro campo (`image_front_url`) o por idioma
(`selected_images.front.display.en`, `.es`, etc.) sin que el genérico
`image_url` quede poblado.

## Cambios

### Backend (`lib/handlers/auto-imagenes.js`)
- Nueva función `extraerMejorImagen(product)`, compartida por
  `buscarPorOpenFoodFacts()` y `buscarPorOpenProductsFacts()`. Prueba en
  orden: `image_url` → `image_front_url` → primer idioma disponible en
  `selected_images.front.display`.
- Ambas funciones ahora piden esos 3 campos a la API (antes solo pedían
  `image_url`) — mismo request, sin costo adicional (OFF/OPF son gratis).
- No se tocó `buscarPorImagenReal()` (Capa 2 / Serper) ni la lógica de
  resolución por capas.

## Qué falta (no es código, es correr la prueba)
- Confirmar en vivo si esto rescata alguno de los 7 productos que
  fallaron. Si después de este fix + una corrida con "solo código de
  barras" siguen sin foto, significa que esa ficha de OFF realmente no
  tiene ninguna foto cargada bajo ningún campo — ahí la única opción real
  es la Capa 2 (Serper, por nombre), ya disponible con el flag
  `incluirBusquedaReal`.

## Deploy
```
vercel --prod
```
Sin cambios de base de datos.
