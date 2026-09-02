# CHANGELOG v923 — Fix: ícono roto en la miniatura de imagen del chat de IA

## Problema

En el chat del "Asistente de IA" (`frontend/shared/chat-widget.js`), al adjuntar o
pegar una imagen, la miniatura de vista previa aparecía como ícono de imagen
roto (con el `alt="Imagen adjunta"` cortado y visible), tanto en el chip de
adjunto pendiente (arriba del input) como en la burbuja del mensaje ya enviado.

## Causa raíz

El widget genera la vista previa con `URL.createObjectURL(archivo)`, que produce
una URL tipo `blob:https://...`, asignada directamente a `<img src="...">`.

Las políticas de `Content-Security-Policy` definidas en `vercel.json` para las
rutas donde vive el widget **no incluían `blob:` en la directiva `img-src`**:

- `/` → `img-src 'self' data:;`
- `/frontend/(.*)\.html` → `img-src 'self' data: https:;`

El navegador construye el blob URL sin error de JS, pero al pintar el `<img>`
lo bloquea silenciosamente por CSP (no lanza excepción, solo se ve en la
consola del navegador: `Refused to load the image 'blob:...' because it
violates the following Content Security Policy directive: "img-src ..."`).
Por eso el bug era invisible en los logs del backend/frontend, y solo se
notaba visualmente.

## Fix

Se agregó `blob:` a `img-src` en las dos entradas de `vercel.json` que lo
necesitaban:

```diff
- img-src 'self' data:;
+ img-src 'self' data: blob:;
```
(ruta `/`)

```diff
- img-src 'self' data: https:;
+ img-src 'self' data: https: blob:;
```
(ruta `/frontend/(.*)\.html`)

No se tocó código de `chat-widget.js`: la lógica de lectura/preview de
archivos ya era correcta, el bloqueo era puramente de la política CSP a nivel
de headers HTTP.

## Archivos modificados

- `vercel.json`

## Verificación sugerida post-deploy

1. Abrir el asistente de IA en cualquier pantalla bajo `/frontend/...` (ej.
   dashboard admin).
2. Adjuntar o pegar una imagen (JPG/PNG/WEBP).
3. Confirmar que la miniatura se ve correctamente en el chip previo al envío
   y en la burbuja del mensaje enviado.
4. Revisar la consola del navegador: no debe aparecer ningún error de CSP
   relacionado a `img-src` / `blob:`.
