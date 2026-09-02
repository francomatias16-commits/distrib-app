# CHANGELOG v618 — Escáner de producto autocompleta nombre y foto

## Qué cambia
Al escanear un código en el modal "Nuevo producto" (botón junto al campo
Código), además de completar `#fp-codigo` ahora se intenta traer el
**nombre** y la **foto** del producto consultando:

1. Open Food Facts (alimentos/bebidas) — mismo criterio que ya usa
   `/api/auto-imagenes` para fotos en lote.
2. Si no matchea, Open Products Facts (bazar/limpieza/perfumería, etc.),
   como fallback.

Ambas son gratis, sin API key, y ya estaban integradas en el proyecto para
otro flujo (carga de fotos en lote de productos existentes) — esto
reutiliza la misma fuente en el momento del alta.

## Comportamiento cuando NO matchea
Es "mejor esfuerzo": si el código es interno (no un EAN real de fábrica) o
no está en ninguna de las dos bases, no pasa nada — el formulario queda
exactamente como antes de este cambio, solo con el código cargado. No hay
mensaje de error ni bloqueo.

## Nunca pisa datos ya cargados
- El nombre solo se autocompleta si el campo está vacío
  (`setNombreProductoSiVacio` en `productos.js`).
- La foto solo se autocompleta si no hay una foto ya elegida en este modal
  ni una foto ya guardada (`setFotoProductoDesdeUrl` en `productos.js`) —
  relevante sobre todo en edición, donde el producto puede ya tener foto.
- Si la descarga de la foto tarda y en el ínterin el usuario elige o quita
  una foto a mano, esa elección manual gana.

## Archivos tocados
- `frontend/admin/js/productos-scanner-remoto.js` — agrega la consulta a
  Open Food/Products Facts tras completar el código.
- `frontend/admin/js/productos.js` — agrega `setNombreProductoSiVacio` y
  `setFotoProductoDesdeUrl`, expuestas en `window` para que las llame el
  script anterior.

## Notas
- No requiere cambios de backend ni de base de datos.
- La foto se trae con `fetch()` directo desde el navegador; si el CDN de
  imágenes de Open Food/Products Facts no responde con headers CORS
  habilitados, la descarga falla en silencio (se loguea un warning) y el
  nombre igual queda completado — la foto es un extra, nunca bloquea el
  resto del autocompletado.
