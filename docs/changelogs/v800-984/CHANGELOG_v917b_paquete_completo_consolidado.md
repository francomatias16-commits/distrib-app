# v917b — Paquete completo consolidado (base v914 + patch v916 + landing v917)

## Qué se hizo

La sesión anterior había dejado tres piezas sueltas: la app base completa
(`distrib-app-v914.zip`), un patch de 4 archivos (`distrib-app-v916-fix-toast-tapado.zip`,
dentro de `files.zip`, con los fixes de `riesgo-cheques.html/css` y
`clientes.html/css`) y la integración de la landing nueva (`vercel.json`,
`auth.js`, `static-server.js`, `frontend/landing/*`). Se armó todo sobre un
único árbol y se generó `distrib-app-v917-full.zip` con la app completa y
lista para desplegar — no hace falta aplicar nada más encima.

## Orden de integración

1. **Base:** se extrajo `distrib-app-v914.zip` tal cual.
2. **Patch v916:** se sobrescribieron los 4 archivos del fix de toast tapado
   (`frontend/admin/riesgo-cheques.html`, `frontend/admin/css/riesgo-cheques-gentelella.css`,
   `frontend/admin/clientes.html`, `frontend/admin/css/clientes-gentelella.css`).
   Se agregaron `CHANGELOG_v915_...md` y `CHANGELOG_v916_...md` a
   `CHANGELOGS_INTEGRACION/`, siguiendo la convención ya usada ahí.
3. **Landing v917:** se reconstruyó `frontend/landing/index.html` desde
   `fluxo-landing-simple-v931.zip` aplicando la misma optimización descripta
   en `CHANGELOG_v917_integracion_landing_fluxo_simple.md` (se quitó el
   `<script id="manus-runtime">` de 366 KB y el `<script>` de
   `manus-analytics.com`; se sincronizaron meta tags con el resto del sitio:
   `manifest.json`, `apple-touch-icon`, `og:title`, `og:description`). Se
   copiaron `app.js`, `styles.css` y las 3 fuentes `.woff2` sin modificar. Se
   aplicaron los `vercel.json` y `frontend/admin/js/auth.js` ya editados
   (confirmado: `vercel.json` ya traía los rewrites/headers de
   `/`, `/app.js`, `/styles.css`, `/fonts/(.*.woff2)` apuntando a
   `frontend/landing/`, con la CSP correspondiente). Se eliminó
   `frontend/index.html` (landing anterior).

## Gap adicional encontrado y corregido en esta pasada

`tests/e2e/helpers/static-server.js`, tal como vino editado, solo
actualizaba el alias de `/` hacia `frontend/landing/index.html`, pero **no**
replicaba los rewrites de `/app.js`, `/styles.css` ni `/fonts/*.woff2` que sí
están en `vercel.json`. Sin eso, cualquier test e2e que cargue `/` y deje
avanzar la carga real de la página (no solo el HTML) iba a pegar un 404
local contra esos tres assets — aunque en Vercel resuelven bien por el
rewrite. Se agregó `LANDING_ASSET_ALIASES` y `LANDING_FONT_URL` al resolver,
replicando el mismo patrón que el archivo ya usa para el resto de las
rutas (`/shared/*`, `/admin/*.js`, etc). Verificado con `node --check`.

## Qué quedó igual (sin tocar, son decisiones de producto pendientes)

Los 3 gaps funcionales de la landing nueva señalados en
`CHANGELOG_v917_integracion_landing_fluxo_simple.md` siguen abiertos:
falta CTA de "Ingresar/Registrarme/Ver demo", el mail de contacto no
coincide con el resto del sitio, y no está el modal de instalación PWA.
No se resolvieron acá porque requieren una decisión de producto, no son
bugs de integración.

## Contenido del zip entregado

`distrib-app-v917-full.zip` contiene el árbol completo del proyecto
(frontend, api, lib, supabase, tests, docs, changelogs, etc.), no un patch
parcial — se puede desplegar directamente reemplazando el árbol anterior.

## Sin migraciones de base de datos
