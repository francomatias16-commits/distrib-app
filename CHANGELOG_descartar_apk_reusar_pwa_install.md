# Descartar descarga de .apk — reusar el instalador PWA ya existente

## Contexto

El nav "Descargar app" de la landing (agregado en v931) se había implementado
con la idea de ofrecer dos `.apk` propios ("app real" / "app demo") para
descarga directa desde el navegador.

Antes de generar esos binarios se revisó si tenía sentido para este caso, y
se decidió que no:

- Un `.apk` bajado del navegador dispara en Android el warning de "fuente
  desconocida"/Play Protect — justo en el peor momento posible, con un
  prospecto evaluando si confiar en el producto.
- No se actualiza solo: cada fix requeriría generar y resubir un `.apk`
  nuevo a mano.
- Es redundante: el proyecto ya tiene una instalación PWA completa y
  probada, sin ninguno de esos problemas.

## Qué ya existía (y se reutiliza)

- `/admin/login` ya maneja `beforeinstallprompt` con fallback manual para
  iOS (`frontend/admin/js/auth.js`, función `_mostrarBotonInstalarAdmin`).
- `/demo` ya redirige a `/admin/login?demo=1` (`vercel.json`, sección
  `redirects`), que hace auto-login con la cuenta demo sin que el usuario
  toque nada (`frontend/admin/login.html`,
  `activarModoDemoSiCorresponde`).
- El header de la landing ya tenía sus propios CTA a estas dos URLs
  ("Inicio de sesión" → `/admin/login`, "Ver demo en vivo" → `/demo`),
  independientes del dropdown de nav.

## Cambios de este changelog

- `frontend/landing/descargar-app-nav.js`: el dropdown ya no descarga
  nada. Sus dos ítems navegan a `/admin/login` (real) y `/demo` (demo).
  Una vez ahí, el botón "Instalar app" que ofrece la instalación PWA real
  es el que ya vive en `auth.js` — no se agregó lógica de instalación
  nueva.
- `frontend/landing/app.js`: el texto del botón de nav pasó de
  "Descargar app" a "Ingresar" (desktop y mobile), porque ya no descarga
  nada.
- `frontend/landing/index.html`: bump de cache-busting de
  `descargar-app-nav.js` (`?v=20260822-02`).
- Se eliminó `frontend/apk/` (placeholder de una entrega anterior, sin
  binarios reales subidos nunca).
- Se revirtió el bloque de `headers` para `/frontend/apk/*.apk` agregado
  a `vercel.json` en la entrega anterior (ya no aplica).

## Verificación

- `node --check` OK en `descargar-app-nav.js` y `app.js`.
- `vercel.json` valida como JSON.
- Sin referencias a `apk` restantes en el proyecto.
