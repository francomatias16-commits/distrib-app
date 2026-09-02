# v944 — Revertir tarjeta destacada de "Asistente" en el mega-menú

## Motivo
El grupo "Asistente" (item "Trabajar con IA") se agregó en v961 con
`destacado:true`, que lo pintaba como una tarjeta aparte (fondo tintado +
borde), distinta del resto de los grupos del menú (lista de texto plano
bajo un encabezado). No era lo pedido: tiene que ser una opción más del
menú, como las demás, solo con su propio color y una fuente apenas más
grande.

## Cambios

**`frontend/admin/js/nav-data.js`**
- Sacado `destacado: true` del grupo `asistente-ia`. Ahora se renderiza
  igual que cualquier otro grupo (Alertas automáticas, Ventas, etc.).

**`frontend/admin/css/nav.css`**
- Sacado el bloque `.nav-ws--destacado` (tarjeta con fondo/borde/padding
  propio).
- Agregado en su lugar `.nav-ws-link[data-menu-accion="asistente-ia"]`:
  mismo link de siempre, con su color (`--nav-ia-text`, ya definido) y
  `font-size: 14.5px` (vs. 13.5px del resto) — nada más.

## No incluido en este cambio
- No se tocaron los tokens `--nav-ia`/`--nav-ia-text`/`--nav-ia-bg` (el
  último queda sin uso, se deja definido por si se necesita después).
- No se tocó `nav.js` — el `ws.destacado ? 'nav-ws--destacado' : ''` sigue
  ahí pero ya no lo dispara nada.
