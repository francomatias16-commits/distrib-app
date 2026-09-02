# v910 — Nivel de confianza más visible: pills de categoría en Clientes y Riesgo de cheques

## Contexto

El "nivel de confianza" (score 0-100, con categorías Premium/Bueno/Normal/
Riesgo/Bloqueado) hoy solo se ve como una columna más en la tabla de
Clientes — fácil de perder, sobre todo en mobile donde queda fuera de
vista hasta scrollear horizontal. Pedido directo: hacerlo más fácil de
ubicar más allá del ícono/badge en la fila.

## Cambio

### `/admin/clientes` (`clientes.html`, `clientes.js`, `clientes.css`,
`clientes-gentelella.css`)

Se agregan 4 pills de filtro por categoría de confianza, separados
visualmente (con un divisor) de los pills de estado operativo que ya
existían (Activos/Inactivos/Con deuda):

- **★ Premium** (dorado) — `score_categoria = 'premium'`
- **● Bueno** (verde) — `score_categoria = 'bueno'`
- **En riesgo** (rojo) — ya existía, sin cambios: sigue combinando
  `riesgo` + `bloqueado` (mismo criterio que el deep-link
  `?filter=riesgo` que usan las alertas de confianza del dashboard —
  no se tocó para no romper ese link).
- **⊘ Bloqueado** (gris) — nuevo, aísla solo esa categoría, más fina que
  "En riesgo".

Colores tomados 1:1 de `.score-badge`/`.score-premium`/`.score-bloqueado`
(mismos que ya se usaban en la columna Confianza), para que se reconozca
como el mismo sistema. Se agregan las clases `.e-pill-dorado` y
`.e-pill-gris` (base y variante gentelella) siguiendo el patrón que ya
existía para `.e-pill-rojo`/`.e-pill-amarillo`/`.e-pill-verde`.

`cargarClientes()` y `exportarExcel()` (`clientes.js`) suman los 3 casos
nuevos de `filtroEstado` (`premium`, `bueno`, `bloqueado`) al `if` que ya
armaba el filtro de riesgo — no se tocó el `select('*')`, ya traía
`score_categoria`/`score_actual`.

### `/admin/riesgo-cheques` (`riesgo-cheques.html`, `riesgo-cheques.js`)

Esa pantalla ya tenía filtro por las 5 categorías, pero como un
`<select>` perdido entre el buscador y el checkbox — mismo problema de
visibilidad. Se reemplaza por el mismo patrón de pills que Clientes
(reutiliza `.estado-pills`/`.e-pill*` de `clientes.css`, que esta página
ya cargaba). Nueva función `filtrarCategoriaRiesgo(cat, btn)` reemplaza
la lectura de `document.getElementById('filtro-categoria-riesgo').value`
por una variable de estado (`filtroCategoriaRiesgo`), mismo criterio que
`selFiltroEstado()` de `clientes.js`.

- Cache-busting: se bumpeó el `?v=` de `clientes.css`, `clientes-gentelella.css`
  y `clientes.js` en `clientes.html`, y el de `clientes.css` y
  `riesgo-cheques.js` en `riesgo-cheques.html`.

## No afectado

- La lógica de cálculo del score (`score_pagos`/`score_frecuencia`/etc.,
  `SCORE_CATEGORIAS`, `motivoFrase()`) no se tocó en ninguna de las dos
  pantallas.
- La columna "Confianza" en la tabla de Clientes y la columna homónima en
  Riesgo de cheques siguen igual — los pills son un acceso adicional, no
  un reemplazo.
- `fidelizacion.js`, `automatizacion.js` y `migracion.js` también usan la
  palabra "confianza" pero para conceptos distintos (confianza de una
  sugerencia de ciclo de compra, confianza de detección de columnas en
  importación) — no relacionados al score de cliente, no se tocaron.
