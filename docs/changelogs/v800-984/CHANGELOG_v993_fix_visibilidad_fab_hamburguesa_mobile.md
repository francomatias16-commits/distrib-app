# v993 — FAB hamburguesa pasaba desapercibido en mobile (todas las páginas)

## Contexto

El botón que abre el drawer de navegación en mobile (`.mnav-fab`,
`frontend/admin/js/nav-mobile.js` + `frontend/admin/css/nav.css`) es un
FAB fijo arriba-izquierda, presente en las 45 páginas de admin que
incluyen `nav.css`. Reporte: se nota poco/pasa desapercibido en mobile en
todas las pantallas.

## Causa

`background: var(--nav-dark-bg)` → `#0A1119`, casi negro. Se pierde
contra la status bar del navegador/OS y contra cualquier UI oscura de la
propia app (ej. el topbar), quedando casi invisible pese al `box-shadow`.

## Fix

**`frontend/admin/css/nav.css`** (único archivo, cubre las 45 páginas):

- `.mnav-fab`: fondo cambiado de `var(--nav-dark-bg)` a `#2563EB` (el
  mismo azul de acento ya usado en ~50 lugares del admin para CTAs —
  botones "Subir a este plan", links de ayuda, etc. — así que es
  reconocible y no un color nuevo inventado). Deliberadamente **no** se
  usó `var(--color-primary)`: varias páginas lo redefinen localmente por
  workspace (`compras.css`, `finanzas.css`, `rutas.css`, etc. lo pisan
  con `--nav-deposito`; `pedidos-gentelella.css` con `--ge-teal`), y el
  FAB necesita verse igual en todas las pantallas, no cambiar de color
  según la sección.
- `box-shadow` reforzado: se agregó un glow de color (`rgba(37,99,235,.55)`)
  además de la sombra oscura, para que resalte incluso sobre fondos
  claros.
- `.mnav-fab:active`: de `var(--nav-dark-rail)` (también casi negro) a
  `#1D4ED8` (mismo azul, un tono más oscuro al tocar).

Cache-busting: `css/nav.css?v=...` bumpeado en las 45 páginas que lo
referencian (estaba consistente en `1786751950483` en todas → ahora
`1787792692836`).

## Fuera de alcance

- No se tocó el ícono (sigue siendo las 3 líneas horizontales / hamburguesa
  estándar) ni el tamaño (40×40px) — solo color y sombra.
- No se tocó `--nav-dark-bg`/`--nav-dark-rail` como tokens globales:
  siguen usándose para el rail/drawer oscuro en sí, que sí debe quedar
  oscuro; el cambio es puntual al FAB.

## Verificación

- Confirmado que `#2563EB` ya es un color establecido en el codebase (53
  usos previos) antes de introducirlo acá.
- Confirmado que `css/nav.css?v=` estaba en la misma versión en las 45
  páginas antes del bump (sin drift).
- No verificable en este entorno: contraste real contra los distintos
  fondos de topbar por workspace en un dispositivo.
