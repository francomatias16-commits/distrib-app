# v542 — Fix: botón de menú principal ausente en saas-billing.html

## Causa raíz real

La sesión anterior investigó cache-busting y CSS muerto, pero esas no eran
la causa de que el botón no apareciera. La causa real:

**`saas-billing.html` carga `nav-data.js` + `nav.js` + `nav-mobile.js` pero
nunca tuvo el `<div id="nav-root"></div>` en el `<body>`.**

`nav.js` (línea `renderConRol`) busca `document.getElementById('nav-root')`
y si no lo encuentra, retorna sin hacer nada — sin error visible en
consola. Por eso el botón nunca se rendereaba en esa pantalla específica,
en ninguna sesión ni navegador: no era un problema de caché, era un div
faltante en el HTML.

Se confirmó por barrido completo: de las 55 pantallas admin, `saas-billing.html`
era la única que cargaba `nav.js` sin el contenedor `#nav-root`. Las demás
pantallas sin `nav.js` (login, setup-wizard, sin-permiso, suspendida,
superadmin, y los redirects cta-cte/liquidacion/lotes/presupuestos) son
casos legítimos que no necesitan el menú.

## Cambios

1. **`frontend/admin/saas-billing.html`** — agregado `<div id="nav-root"></div>`
   justo después de `<body class="dash-saas-billing-gentelella dash-gentelella">`.
   Se verificó que los z-index de los modales propios de la pantalla (1000,
   1001, 9999) no chocan con el nav (`#nav-root` z-index 200, panel 401).

2. **`frontend/shared/gentelella-nav.css`** — reemplazado por una versión
   no-op documentada. Sus reglas apuntaban al riel oscuro viejo
   (`.nav-rail`, `.nav-ws-btn`, `.nav-panel`, `.nav-section-link`, etc.),
   selectores que ya no existen desde que `nav.js` v520 reemplazó ese riel
   por el mega-menú compartido (`#nav-menu-btn`, `#nav-menu-panel`, `.nav-ws`,
   `.nav-ws-link`). Se mantiene el archivo en el mismo path (linkeado desde
   ~45 HTML) para no generar 404 de CSS; queda documentado para quien quiera
   reskinear el mega-menú a futuro con los selectores correctos.

3. **Cache-busting unificado** — se re-aplicó sobre este snapshot la
   unificación de versión (`?v=1785554232617`) de `nav.css`, `nav.js`,
   `nav-data.js`, `nav-mobile.js` y `gentelella-nav.css` en las 44 pantallas
   restantes, para que coincida con `dashboard.html` (que ya traía esta
   versión de una sesión previa). No era la causa del bug, pero evita que
   quede desincronizado.

## Pendiente

Ninguno para este frente. El botón de menú ahora debería aparecer en las
55 pantallas admin (excepto las que legítimamente no lo necesitan).

---

# v543 — Fix real: botón invisible en TODAS las pantallas (no solo saas-billing)

## Lo que se vio en el navegador (captura real de producción)

En `depositos.html` en vivo (distrib-app-nine.vercel.app) el botón no aparecía
en ninguna parte — ni siquiera flotando en una esquina. Esa pantalla SÍ tenía
`#nav-root`, nav.css y nav.js correctamente incluidos (a diferencia de
saas-billing.html), así que el bug de v542 no explicaba este caso.

## Causa raíz

El disparador del mega-menú (botón + antes también hubiera tenido logo) se
renderizaba como **FAB flotante con `position: fixed; top:14px; left:14px`**,
fuera del flujo normal del documento e independiente del `<header class="topbar">`
de cada pantalla — a diferencia de `dashboard.html`, que tiene el logo y el
botón escritos a mano DENTRO de `.topbar-left`, en el flujo normal.

Un elemento `position:fixed` en la esquina superior izquierda queda "vivo" en
el DOM pero visualmente puede quedar tapado por cualquier otro elemento con
mayor z-index que ocupe esa zona — sin ningún error en consola, sin romper
nada funcionalmente, simplemente invisible. Esto es exactamente el tipo de bug
que no se detecta leyendo el HTML/CSS de una sola pantalla (el markup era
"correcto"), solo mirando el resultado renderizado real, como en la captura
que se compartió.

## Fix

- **`nav.js`**: el disparador (logo + separador + botón) ahora se inserta
  DENTRO de `.topbar-left` de cada pantalla — en el flujo normal del layout,
  igual que ya lo tenía `dashboard.html` a mano — en vez de flotar fixed en
  la esquina. El overlay (backdrop + panel modal) se queda en `#nav-root`,
  que conserva su propio `position:fixed` independiente.
- **`nav.css`**: `#nav-root` pasa a `display:contents` (ya no necesita
  posición propia); se agregan `.topbar-left .logo`, `.topbar-left
  .topbar-divider` y se ajusta `.nav-menu-btn` para vivir integrado en el
  topbar en vez de como FAB.
- Fallback: si alguna pantalla no tuviera `.topbar-left` (el único caso es
  `saas-billing.html`, que no usa el shell estándar), el botón se inserta en
  `#nav-root` igual, así nunca queda sin insertar.
- Mobile (`≤768px`): se agrega regla para ocultar logo/separador/botón
  integrados (el patrón mobile sigue siendo el FAB hamburguesa `mnav-fab` +
  drawer lateral, sin cambios).
- Cache-busting de `nav.css`/`nav.js` bumpeado a `?v=1785600000000` en las
  44 pantallas (esta vez el contenido sí cambió de verdad).

## Resultado esperado

En todas las pantallas admin, el botón "Menú principal" ahora aparece junto
al logo, dentro del topbar — igual que en `dashboard.html` — en vez de
depender de que ningún otro elemento le "gane" la esquina superior izquierda.
