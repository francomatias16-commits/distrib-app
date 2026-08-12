# v643 — Plan offline, Etapa 2: Service Worker + manifest para cliente y proveedor

**Base:** integra v642 (limpieza de zócalo/topbar) + este cambio.

## Problema resuelto
De los 4 portales, `cliente` y `proveedor` eran los únicos sin ningún tipo
de offline: sin Service Worker, sin manifest, sin caché de ningún tipo. Sin
Internet, la página ni cargaba (pantalla en blanco). Es la brecha más
grande y más barata de cerrar del plan offline completo (ver
`PLAN_OFFLINE_COMPLETO.md`, recomendación §4, punto 2).

## Qué se agregó

### `frontend/cliente/`
- `sw-cliente.js` — Service Worker nuevo. Cache-First para shell/assets,
  Stale-While-Revalidate para catálogo (`/api/cliente/categorias`,
  `/api/cliente/productos`) y recompensas (`/api/fidelizacion`),
  Network-First para las 7 páginas HTML, Network-Only para auth, pagos,
  pedidos (precio recalculado) y tracking en vivo (`/api/rutas-live`).
- `manifest.json` — PWA instalable, `scope: /cliente`, íconos vía
  `/api/empresa/icon` (mismo patrón multi-tenant que admin/chofer).
- `pwa-init.js` — registra el SW y expone botón "Instalar app" (mismo
  patrón que `frontend/chofer/pwa-init.js`).
- Las 8 páginas HTML (`inicio`, `login`, `catalogo`, `carrito`, `pedidos`,
  `cuenta`, `checkout`, `notificaciones`) ahora incluyen el `<link
  rel="manifest">`, `<meta name="theme-color">` y el `<script>` de
  `pwa-init.js`.

### `frontend/proveedor/`
- `sw-proveedor.js` — Service Worker nuevo, **todo Network-First** (no
  SWR): a diferencia de cliente/admin/chofer, el acceso es por link con
  token en la URL (`?t=...`), sin sesión persistente, y los datos son
  financieros (facturas, saldo) — no conviene servir caché de entrada acá.
  El caché queda atado a la URL exacta (token incluido), así que un
  proveedor nunca puede ver el último dato cacheado de otro token.
- `manifest.json` — `scope: /proveedor`.
- `pwa-init.js` — solo registra el SW, **sin** botón "Instalar app": sin
  sesión propia, un ícono instalado no tiene una URL de arranque útil sin
  el token del link original que lo generó.
- `portal.html` con el `<link rel="manifest">`, `theme-color` y el
  `<script>` de `pwa-init.js`.

### `vercel.json`
- Headers nuevos: `Cache-Control`/`Access-Control-Allow-Origin` para
  `/frontend/cliente/manifest.json` y `/frontend/proveedor/manifest.json`;
  `Service-Worker-Allowed` + `Cache-Control` para `sw-cliente.js` (scope
  `/cliente`) y `sw-proveedor.js` (scope `/proveedor`) — mismo patrón que
  ya existía para `sw-admin.js`/`sw-chofer.js`.
- Rewrites nuevos: `/cliente/manifest.json` y `/proveedor/manifest.json`
  (no matcheaban ninguna regla existente, que solo cubría `.html/.js/.css`).
  `sw-cliente.js` y `sw-proveedor.js` ya quedaban cubiertos por los
  rewrites `.js` existentes de cada portal.

## Limitación conocida (no resuelta en este cambio)
`inicio.html` y `notificaciones.html` del portal cliente leen datos
llamando directo a Supabase (`sb.from(...)`), no a `/api/`. Esas llamadas
son cross-origin (`*.supabase.co`) y el Service Worker no puede
interceptarlas para cachearlas sin un proxy propio. Con este cambio esas
dos pantallas dejan de quedar en blanco offline (el shell carga desde
caché), pero los datos que muestran van a seguir fallando sin red hasta
que se migren a leer vía `/api/` — eso queda fuera de esta etapa.

## Qué sigue
Con esto, la Etapa 2 (recomendación §4 del plan) queda cubierta para
`cliente` y `proveedor`. `admin` y `chofer` ya la tenían. El siguiente
paso sugerido en el plan es la Etapa 3, ítem 3 (confirmar entrega/
devolución del chofer, hoy "solo red") — o, si se prefiere cerrar del
todo la lectura offline, extender `sw-admin.js` al resto de los
endpoints de lectura de las 75 páginas que hoy no cubre.
