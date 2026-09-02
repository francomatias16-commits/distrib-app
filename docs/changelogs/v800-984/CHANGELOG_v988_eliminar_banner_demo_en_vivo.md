# v988 — Eliminar banner "demostración en vivo"

## Problema
Con el drawer de navegación mobile abierto, el banner sticky de "demostración
en vivo" (`z-index:10000`, insertado por `auth.js` cuando `perfil.solo_lectura`)
quedaba pintado por encima del drawer (`--z-mnav-panel:691`), tapando el
botón para volver al dashboard dentro del menú.

Ya se había parchado una vez (fix "456") para correr el FAB hamburguesa con
`--demo-banner-h`, pero ese parche solo cubría el botón que abre el drawer,
no los ítems de navegación *dentro* del drawer una vez abierto — cada
elemento `position:fixed` nuevo iba a necesitar el mismo tipo de parche.

## Decisión
En vez de seguir sumando offsets de z-index para un aviso puramente
informativo, se elimina el banner por completo.

## Cambios
- `frontend/admin/js/auth.js`: se sacó la creación del `<div>` del banner, su
  inserción en `.layout`, y el listener de resize que actualizaba
  `--demo-banner-h`. Se mantiene `document.body.classList.add('modo-demo-solo-lectura')`
  como señal (sin uso de CSS actual, pero documentado por si se necesita a
  futuro). El bloqueo real de escritura en modo `solo_lectura` sigue 100% en
  el backend (`lib/solo-lectura.js`), sin cambios ahí.
- `frontend/admin/css/nav.css`: `.mnav-fab` vuelve a `top: 12px` fijo, sin el
  `calc(12px + var(--demo-banner-h, 0px))`.
- `frontend/shared/tokens.css`: se sacó la declaración de `--demo-banner-h`
  (ya sin ningún consumidor).

## Alcance
Solo afecta a usuarios con `perfil.solo_lectura = true` (los que entran vía
"Ver demo en vivo"): antes veían el aviso arriba de la pantalla, ahora no ven
ningún indicador visual — la restricción de guardado sigue aplicando igual.
