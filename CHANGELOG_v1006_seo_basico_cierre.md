# v1006 — SEO básico: cierre del pendiente #14

## Diagnóstico

El pendiente #14 de `PENDIENTES_CONSOLIDADO_2026.md` ("falta robots.txt
y sitemap.xml — bloqueado por no identificar el dominio de producción")
**estaba desactualizado**: `frontend/robots.txt` y `frontend/sitemap.xml`
ya existen, ya usan `https://fluxoapp.com.ar` como dominio real, y
`vercel.json` ya los reescribe correctamente a `/robots.txt` y
`/sitemap.xml` (sin conflicto de orden con ningún catch-all previo).
El catálogo dinámico por tenant (`/cliente/catalogo/:slug`) queda fuera
del sitemap a propósito, con comentario explicativo — decisión correcta,
sin acción.

## Gaps reales encontrados y corregidos

- **`index.html`**: faltaban `og:image` y los tags `twitter:card`. Se
  agregaron usando `frontend/video/hub-flow-bg-poster.jpg` (imagen ya
  existente en el repo, sin usar actualmente en ningún `<img>`/`<video>`,
  que resume visualmente los módulos de Fluxo).
- **`registro.html`**: no tenía `<meta name="description">` ni
  `canonical` — se agregaron ambos. Es una página pública (permitida en
  `robots.txt`) que no tenía ningún dato para que el buscador la
  describa.
- **`terminos.html`, `privacidad.html`, `eliminacion-datos.html`**:
  tenían `title` y `description` pero no `canonical`. Como
  `robots.txt` permite indexar tanto `/pagina` como `/pagina.html`
  (misma página, dos URLs), sin `canonical` eso es contenido duplicado
  a ojos de Google. Se agregó `canonical` apuntando a la versión sin
  `.html` en las 3.

## Sin tocar (fuera de alcance de este pendiente)

- No se generó un sitemap-index para el catálogo dinámico por tenant
  (ya documentado como decisión pendiente en el propio `sitemap.xml`).
- No se optimizó/redimensionó `hub-flow-bg-poster.jpg` al ratio ideal
  de Open Graph (1200×630) — su tamaño actual (1024×682) es aceptable
  para la mayoría de los previsualizadores sociales.

Verificado: balance de tags `<html>`/`</html>` en las 5 páginas, y
presencia de los meta tags nuevos.
