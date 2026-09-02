# v907 — Se saca el logo redundante de la barra superior (junto a "Menú principal")

## Contexto

v744 había agregado un logo de empresa (`#topbar-logo`) pegado al botón
"Menú principal" en la esquina superior izquierda, en las 44 pantallas del
admin. Pedido directo: nunca se solicitó ahí, y desde v906 (logo en el
chip de usuario, `#topbar-avatar-ini`) quedaba duplicado — dos logos
distintos en la misma barra superior de cada pantalla.

## Cambio

Se retira `#topbar-logo` de las tres capas donde vivía:

- `frontend/admin/js/nav.js` — `buildMenuTrigger()` ya no inyecta el
  `<div class="topbar-logo" id="topbar-logo">` antes del botón "Volver"/
  "Menú principal".
- `frontend/admin/css/nav.css` — se eliminan las reglas `.topbar-logo`
  (tamaño, fondo, `img` interna) y la referencia a `.topbar-logo` en la
  regla mobile que ocultaba el disparador viejo.
- `frontend/admin/js/auth.js` — `pintarLogoEn()` ya no pinta en
  `topbar-logo` (elemento inexistente); se simplifica para pintar solo
  `#sidebar-logo` (adentro del cajón "Menú principal"), que sigue vigente
  y no es redundante con nada.
- Cache-busting: se bumpeó el `?v=` de `nav.js` y `auth.js` en las 44
  páginas que los cargan, para que no quede el trigger viejo servido
  desde caché del navegador.

## No afectado

- `#sidebar-logo` (logo adentro del cajón del menú principal) sigue
  igual, no se tocó.
- `#topbar-avatar-ini` (logo/iniciales en el chip de usuario, v906) sigue
  igual — es el que ahora queda como único logo visible en la barra
  superior sin abrir ningún menú.
- `frontend/cliente/catalogo.html` tiene su propio `.topbar-logo-catalogo`
  (tienda del cliente, no el admin) — no relacionado, no se tocó.
