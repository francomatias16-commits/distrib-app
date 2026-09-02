# CHANGELOG v933 — Recolor de acento: azul → verde en toda la landing

## Pedido
Reemplazar el color de fuente/acento azul de la landing por el verde que
ya usa el proyecto (el mismo verde del isotipo/`--green:#18a873`).

## Qué se cambió
Se tocaron únicamente los **colores del sistema de diseño de la landing**
(variables CSS en `:root` de `styles.css` + sus copias literales
hardcodeadas para sombras/hovers), no el markup ni la estructura:

- `--blue` (azul vivo de botones, links, íconos, "em" en títulos, chips,
  bordes activos, etc.): `#0540ad` → `#18a873` (el verde del proyecto).
- `--navy` / `--ink` (azul oscuro usado como color principal de texto en
  títulos h1/h2, dashboard mock, etc.): `#002253` → `#0a3d2b` (verde
  oscuro con el mismo contraste/jerarquía que tenía el navy).
- Todos los tonos derivados (sombras y fondos con alpha construidos a
  partir de esos dos colores, ej. `#0540ad38`, `#00225329`, etc.) se
  actualizaron en bloque para seguir siendo coherentes con los nuevos
  colores base.
- Hover oscuro de botones/íconos (`#0b2e79`) → verde oscuro `#106b47`.
- Fondo clarito de hover en el nav (`#eef7fd`) → el mismo verde clarito
  que ya usa `.green-chip` (`#e2faef`), para no introducir un tono nuevo.
- Los dos fondos grandes que eran visiblemente azules:
  - Sección de productos (`.product-section`): `#80c4f3` / `#72b8e9` →
    verdes (`#7bd6ab` / `#5fc79a`).
  - Sección CTA final (`.cta-section`, gradiente radial): stops
    `#1763bd` / `#00317f` → verdes (`#1f8f63` / `#062f21`).

Archivos tocados: `frontend/landing/styles.css`,
`frontend/landing/refinamiento-v1.css`,
`frontend/landing/pricing-section.css`.

## Qué NO se tocó (a propósito)
- `--sky` / `--sky-soft` (`#6bcaff` / `#f5fbff`): es el celeste clarito
  decorativo (nubes, líneas punteadas, puntitos del eyebrow, fondo del
  botón ghost). No es el "azul" de marca ni afecta letras, así que se
  dejó igual para no romper el tema visual de las ilustraciones.
- Los colores de las ilustraciones/mockups (las "pantallitas" simuladas
  del hero, de las product-cards, el mapa de rutas, los avatares, etc.):
  son paletas decorativas propias de cada mockup, no el acento de marca.
  Si también se quiere pasar esas ilustraciones a tonos verdes, es un
  cambio aparte (son decenas de tonos puntuales por mockup).

## Resultado
Todo texto, ícono, botón, borde activo y título que antes se pintaba con
el azul de marca ahora usa el verde del proyecto, incluyendo las dos
secciones de fondo sólido/gradiente que eran azules. La jerarquía visual
(qué es más oscuro/claro) se mantiene igual, solo cambia el matiz.
