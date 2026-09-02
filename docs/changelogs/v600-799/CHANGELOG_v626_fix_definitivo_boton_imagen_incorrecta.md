# v626 — Fix definitivo: botón "Imagen incorrecta" + refresco de imagen

## Problema
Después de escanear un código de barras que cargaba una imagen equivocada, el botón
"⚠ Imagen incorrecta — intentar otra" **no aparecía en pantalla** y aunque se
borrara la caché en Supabase (`foto_url = NULL`), la imagen seguía siendo incorrecta.

## Causa raíz (dos bugs combinados)

### BUG 1 — Botón invisible (overflow:hidden)

`mostrarBotonImagenIncorrecta()` en `productos-scanner-remoto.js` insertaba el botón
**dentro de** `#fp-foto-preview-wrap`, que tiene:

```css
width:84px; height:84px; overflow:hidden;
```

El botón existía en el DOM pero era completamente invisible porque el contenedor
lo recortaba. No era un problema de condicional ni de permisos — el botón se
creaba, pero no se podía ver.

**Fix:** ahora se inserta con `insertAdjacentElement('afterend')` en
`#fp-foto-quitar` / `#fp-foto-input`, que están en el `flex-column` de controles
(columna derecha del preview), donde se ve correctamente.

### BUG 2 — Refresco silenciosamente bloqueado (guard en setFotoProductoDesdeUrl)

Cuando `refrescarImagen()` recibía la imagen nueva del servidor (respuesta 200 con
`foto_url`), llamaba a `window.setFotoProductoDesdeUrl(data.foto_url)`. Esa función
tiene el guard:

```js
if (!url || fotoProductoFile || fotoProductoUrlActual) return;
```

Después del primer scan, `fotoProductoFile` ya estaba seteado con el archivo
descargado. El guard bloqueaba silenciosamente el refresco. La imagen correcta
llegaba del servidor pero nunca se aplicaba en pantalla.

**Fix:** `productos.js` ahora expone `window.forzarFotoProductoDesdeUrl()` (nueva
función v626) que descarga y aplica la imagen sin esos guards, pero mantiene el
chequeo de concurrencia para no pisar una foto elegida manualmente por el usuario.
`refrescarImagen()` usa esta función en lugar de `setFotoProductoDesdeUrl()`.

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `frontend/admin/js/productos-scanner-remoto.js` | Fix botón (afterend) + usar `forzarFotoProductoDesdeUrl` |
| `frontend/admin/js/productos.js` | Agregar `forzarFotoProductoDesdeUrl` + `window.forzarFotoProductoDesdeUrl` |

## Solución general (cualquier producto)

Estos fixes aplican a **cualquier código de barras**, no solo al TALCO VERITAS.
El problema era estructural: cualquier producto cuya imagen del banco fuera
incorrecta no podía corregirse desde la UI. Ahora:

1. Escanear el código → imagen auto-completada aparece en el form
2. Si la imagen es incorrecta → aparece el botón "⚠ Imagen incorrecta" (visible)
3. Click en el botón → servidor limpia la caché y re-busca (supermercados > sin ML > ML)
4. Nueva imagen se aplica en el form correctamente (sin bloqueo de guard)
5. Si tampoco la segunda búsqueda encuentra imagen → campo queda en blanco para carga manual

Para el TALCO VERITAS (código `7791520009729`) que ya estaba cacheado con imagen
incorrecta, ejecutar en Supabase SQL Editor antes de re-escanear:

```sql
UPDATE banco_codigos_producto
SET foto_url = NULL, fuente = 'manual'
WHERE codigo = '7791520009729';
```

Esto limpia la caché vieja. El próximo escaneo va a buscar la imagen con la
estrategia nueva (supermercados verificados primero).
