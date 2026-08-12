# v382 — Auto-imágenes: modal propio, botón detener, deshacer

## Contexto
El flujo de búsqueda automática de imágenes (`buscarImagenesAutomaticas()` en
`productos.js`) usaba `confirm()` nativo del navegador para elegir el modo de
búsqueda, sin forma de frenar el proceso a mitad de camino ni de deshacer si
se tocaba la opción equivocada por error (causa del reset de datos de prueba
de esta sesión).

## Cambios — `frontend/admin/js/productos.js`

1. **`elegirModoImagenes()`** — reemplaza el `confirm()` nativo por un modal
   propio (overlay centrado, mismos tokens CSS que `window.confirmar()`) con
   dos opciones bien diferenciadas en tarjetas:
   - "Solo código de barras" (recomendado) — foto real vía Open Food Facts.
   - "+ Incluir banco de fotos genérico" — fallback por nombre para productos
     sin match, con aviso de que puede traer una foto no relacionada.

2. **`mostrarProgresoImagenes()`** — panel de progreso en vivo (tanda actual,
   productos con foto / procesados) con botón **Detener**, que corta el loop
   antes de arrancar el siguiente lote (no aborta un lote ya en vuelo).

3. **`mostrarResultadoImagenes()` + `deshacerBusquedaImagenes()`** — resumen
   final con botón **Deshacer esta búsqueda**, que revierte SOLO los
   productos tocados en esa corrida: pone `foto_url = NULL` y borra el
   archivo del bucket `productos-fotos` (`${empresa_id}/${producto_id}.jpg`,
   mismo patrón que usa el endpoint de subida en
   `lib/handlers/auto-imagenes.js`). No toca fotos cargadas en corridas
   anteriores.

4. Manejo de errores mejorado: timeout de lote (55s, por debajo del límite de
   60s de la función) muestra mensaje específico e indica que se puede
   reintentar desde donde quedó.

5. **Fix**: la función de resultado llamaba a `esc(errorMsg)` para escapar el
   mensaje de error, pero `productos.js` solo define `escHtml()` localmente
   (no hay `esc` en scope, el script no es módulo y no hay `window.esc`).
   Se corrigió a `escHtml()` antes de empaquetar — con `esc()` tal como
   estaba, cualquier error de red durante la búsqueda hubiera roto el modal
   de resultado con un `ReferenceError`.

## Base de datos
Se resetearon a `NULL` los 22 `foto_url` de prueba de la empresa
`4462586e-e11a-4d34-a405-17103bb9cf9f` (click accidental en el confirm
anterior), para volver a probar el flujo nuevo desde cero.

## No requiere
- Cambios de CSS (el modal usa estilos inline con las variables `--color-*`
  ya definidas globalmente, mismo patrón que `window.confirmar()`).
- Endpoint nuevo en el backend (`deshacer` opera directo contra Supabase
  desde el cliente, igual que el resto de `productos.js`).
- Migración de base de datos.

## Deploy
```
vercel --prod
```
