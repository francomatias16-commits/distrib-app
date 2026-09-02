# CHANGELOG v931 — Logo real de Fluxo + tab "Descargar app" en la landing

## Contexto
Se pidió reemplazar el logo dibujado en CSS de la landing (el mark
`.brand-mark` armado con `<span>`s + pseudo-elementos) por el isotipo real
de Fluxo, y eliminar la pestaña de nav "Acerca de" para reemplazarla por
"Descargar app", con dos opciones: app real y app demo.

## 1) Logo real
- El archivo `fluxo.png` recibido era un mockup de marketing (tarjeta 3D +
  sombra + leyenda "Redes Conectadas" sobre fondo gris), no un logo limpio.
  Se recortó y se le quitó el fondo (transparencia por saturación de color).
- v931: primer recorte incluía isotipo (flecha) + wordmark "FLUXO".
- v932 (ajuste): como el wordmark "FLUXO" ya se muestra aparte como texto
  en el header/footer/CTA (era redundante repetirlo dentro de la imagen),
  se volvió a recortar dejando **únicamente el isotipo** (la flecha), sin
  texto.
- Asset final: `frontend/landing/img/logo-fluxo.png` (226×194, solo
  isotipo, fondo transparente).
- `frontend/landing/app.js`: la función del logo (antes `eg()` devolvía
  `<span class="brand-mark">` con dos spans hijos vía CSS) ahora devuelve
  un `<img class="brand-logo-img" src="/frontend/landing/img/logo-fluxo.png">`.
  Esta función se usa en 3 lugares (header, sección CTA, footer), así que
  el cambio se propaga a los tres automáticamente.
- CSS nuevo en `frontend/landing/refinamiento-v1.css`:
  - `.brand-logo-img` (tamaño base 34px, hover, tamaño en header scrolleado,
    tamaño en footer).
  - `.cta-content .brand-logo-img` con `filter: brightness(0) invert(1)`
    para que se vea blanco sobre el fondo azul de la sección CTA (igual
    que hacía antes `.cta-content .brand-mark`).
- Las reglas CSS viejas de `.brand-mark` / `.brand-mark-route` /
  `.brand-mark-box` quedaron sin uso (no se tocó `styles.css` para no
  arriesgar el bundle de Tailwind); no rompen nada, simplemente no se
  aplican más.

## 2) Nav "Acerca de" → "Descargar app" (dropdown con 2 opciones)
- `frontend/landing/app.js`: el botón de nav desktop y el botón del menú
  mobile que decían "Acerca de" (`onClick:()=>ee("acerca")`) ahora dicen
  "Descargar app" y llevan las clases `nav-download-app` y
  `nav-download-app-mobile` respectivamente, para que el patch
  `descargar-app-nav.js` (mismo patrón que `module-card-links-v2.js` /
  `tarjeta-responsive.js`, patch post-render sin tocar el estado interno
  de React) los detecte y los convierta en un desplegable con:
  - "Descargar app real"
  - "Descargar app demo"
- Desktop: se arma un `.nav-popover` con `.popover-card` (mismas clases
  visuales que el resto del nav) que abre/cierra al click, con cierre por
  click afuera y por Escape.
- Mobile: acordeón inline dentro de `.mobile-menu`, inserta los dos ítems
  justo debajo del botón.
- Se agregó `frontend/landing/descargar-app-nav.js` (provisto) y se
  referenció en `index.html` junto a los demás scripts de patch de la
  landing.
- Se agregaron estilos `.nav-download-app-item` en `refinamiento-v1.css`
  para que los ítems del dropdown/acordeón respeten la estética existente.
- El onClick original (`ee("acerca")`, que scrollea a la sección de
  principios de operación) se dejó intacto como fallback silencioso: el
  patch hace `stopPropagation()` en el click real, así que en condiciones
  normales el dropdown gana; si por algún motivo el script no cargara, el
  botón simplemente scrollearía a esa sección en vez de no hacer nada.

## Pendiente (a cargo de Ruben)
- Completar `REAL_APP_URL` y `DEMO_APP_URL` en
  `frontend/landing/descargar-app-nav.js` (hoy en `"#"` como placeholder,
  tal cual venían marcados con TODO en el archivo original).
- Los ítems pendientes mencionados aparte (13 reglas IA, sección terminal
  POS) no se tocaron en este changelog — quedan para una próxima entrega.

## Archivos tocados
- `frontend/landing/app.js`
- `frontend/landing/index.html`
- `frontend/landing/refinamiento-v1.css`
- `frontend/landing/descargar-app-nav.js` (nuevo, copiado del adjunto)
- `frontend/landing/img/logo-fluxo.png` (nuevo, logo recortado/limpio)
