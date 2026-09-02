# v917 — Reemplazo de la landing pública por fluxo-landing-simple-v931

## Qué se hizo

Se integró la landing entregada en `fluxo-landing-simple-v931.zip` (export
estático de un builder tipo "Manus": React 19 + Tailwind v4 compilados a
`app.js`/`styles.css`, más fuente propia `ESBuild`) en reemplazo de la
landing pública anterior (`frontend/index.html`, HTML+CSS+JS artesanal).

## Optimización aplicada — bug grave en el export original

El `index.html` tal como vino **pesaba 367 KB**, pero el 99.7% de eso
(366 KB) era un `<script id="manus-runtime">` con: React+ReactDOM
completos otra vez (duplicados — `app.js` ya trae los suyos), un selector
de elementos DOM con overlay en canvas, un panel de edición de estilos
en vivo, un capturador de errores con toast, y un banner "Preview mode".
Es tooling **exclusivo del editor** del builder — no tiene ninguna función
en producción, y encima duplicaba React innecesariamente. También traía
un `<script>` de analytics de terceros apuntando a `manus-analytics.com`
(la plataforma del builder, no de Fluxo).

Se eliminaron ambos. Resultado: el HTML que baja el navegador antes de
poder pintar algo pasó de **367 KB a ~1.2 KB** — el mismo `app.js`/
`styles.css` reales (que sí son el sitio) ahora se piden con `defer` sin
competir con ese bloque muerto.

`app.js` (600 KB) y `styles.css` (140 KB) se dejaron intactos: ya vienen
minificados (Tailwind v4 compilado, una sola línea) y no hay forma segura
de reducirlos más sin el proyecto fuente (son código de React ya
compilado). 600 KB para un bundle de React+contenido autocontenido, sin
compartir React vía CDN, es esperable para este tipo de export; si en el
futuro se regenera desde fuente, cargar React desde un CDN compartido con
el resto del panel admin sería la próxima optimización real.

## Archivos y rutas

- **Nuevo:** `frontend/landing/index.html`, `frontend/landing/app.js`,
  `frontend/landing/styles.css`, `frontend/landing/fonts/*.woff2`
  (contenido de `app.js`/`styles.css`/fuentes sin modificar, solo movidos
  a esta carpeta).
- **Eliminado:** `frontend/index.html` (landing anterior).
- **`vercel.json`**:
  - El rewrite de `/` ahora apunta a `/frontend/landing/index.html` (antes
    `/frontend/index.html`).
  - Nuevos rewrites: `/app.js`, `/styles.css` y `/fonts/(*.woff2)` →
    los archivos reales bajo `frontend/landing/` (así el `index.html`
    puede seguir usando rutas raíz simples `/app.js`, `/styles.css`,
    `/fonts/...` en vez de tener que reescribir el build del builder).
  - Headers nuevos para esas 4 rutas, seguros el mismo criterio que ya
    usa el resto del sitio: `Cache-Control: no-cache, no-store,
    must-revalidate` para el HTML/JS/CSS (igual que
    `/frontend/(.*)\.html|js|css`), y `Cache-Control: public,
    max-age=31536000, immutable` para las fuentes woff2 (son estáticas
    y no cambian de nombre entre versiones, a diferencia del resto). El
    documento raíz (`/`) también suma una Content-Security-Policy propia
    (`script-src 'self'`, `style-src 'self' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com`, etc.) — sin esto el
    `<link>` de Google Fonts (tipografía "Inter", usada como texto de
    cuerpo real en el diseño) quedaría bloqueado por CSP en cuanto se le
    aplique alguna política a esa ruta.
- **`tests/e2e/helpers/static-server.js`**: `'/'` ahora resuelve a
  `/frontend/landing/index.html` (antes apuntaba al archivo eliminado).
- **`frontend/admin/js/auth.js`**: actualizado un comentario que
  referenciaba `frontend/index.html` como ejemplo (sin cambio de código).

## ⚠️ Gaps encontrados — necesitan una decisión, no los resolví por mi cuenta

Comparé el contenido de `app.js` contra la landing anterior y contra el
resto del sitio (`grep` sobre el bundle, no hay forma de renderizarlo acá)
y encontré 3 diferencias funcionales, no solo visuales:

1. **No tiene botones de "Ingresar" / "Registrarme" / "Ver demo en vivo".**
   La landing anterior tenía esos tres CTA apuntando a `/admin/login`,
   `/registro` y `/demo` (los tres siguen andando, no los toqué). La
   nueva landing solo tiene navegación por anclas (`#producto`,
   `#precios`, etc.) y un `mailto:`. Si se publica tal cual, no hay forma
   de entrar al sistema ni de registrarse desde el home.
2. **El mail de contacto no coincide con el resto del sitio.** La nueva
   landing usa `mailto:hola@distrib.app`; el resto de las páginas legales
   (`privacidad.html`, `terminos.html`, `eliminacion-datos.html`,
   `suspendida.html`) usan `soporte@distrib.com.ar`.
3. **No tiene el modal "Instalar app" (PWA)** que sí tenía la landing
   anterior (mencionado en el comentario de `auth.js` de arriba).

No los toqué porque son decisiones de producto/diseño, no bugs de
integración — puedo agregar los tres CTA y corregir el mail con un
pequeño script que los inyecta en el DOM ya renderizado (no requiere
recompilar `app.js`), si me confirmás que es lo que corresponde.

## Sin migraciones de base de datos
