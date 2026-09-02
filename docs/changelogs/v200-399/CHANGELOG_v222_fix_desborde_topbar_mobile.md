# v222 — Fix desborde horizontal en mobile (topbar-workspace)

## Causa raíz confirmada
`nav.css` define `.topbar-workspace { display: inline-flex; ... }` **sin media query**,
y se carga después de `adminlte-components.css` (que sí lo ocultaba en mobile con
`@media (max-width:768px){ .topbar-workspace{display:none} }`). Misma especificidad
(una clase) + orden de carga posterior = nav.css gana, incluso en pantallas chicas.

Resultado: el badge "FACTURACIÓN" queda visible en el topbar del celular, sumando
ancho que no estaba contemplado. Junto con otros elementos del topbar sin colapsar,
el conjunto termina siendo más ancho que el viewport. Como `html/body` tienen
`overflow-x:hidden`, todo lo que sobra a la derecha se recorta en vez de scrollear
—de ahí el "22 compro..." y "Comercio...aure" cortados en la captura.

## Cambios

**frontend/admin/css/nav.css**
- Se agrega `.topbar-workspace { display: none !important; }` dentro del propio
  `@media (max-width:768px)` de nav.css, para que quede la última palabra sin
  depender del orden de los `<link>` en cada HTML.
- `min-width:0` en `.topbar-left`/`.topbar-right` y overflow-safety en `.layout`/`.main`
  como defensa adicional ante el mismo tipo de bug en otros elementos.
- Se sube el z-index de `.mnav-bar` (500→650), `.mnav-overlay` (490→640) y
  `.mnav-drawer` (500→651) para que la barra/drawer mobile nunca quede tapada
  por el widget de chat flotante (z-index 590) u otros elementos fixed.

**frontend/admin/css/facturacion.css**
- `min-width:0` en `.kpi-card` — un grid con columnas `1fr` no encoge por debajo
  del contenido mínimo de sus hijos si no se lo indicás explícitamente; si algún
  texto largo entraba en una kpi-card, podía forzar el ancho del grid entero.

## Impacto
Como nav.css es compartido, este fix aplica a las ~31 páginas admin que lo cargan,
no solo a Facturas. Se bumpeó el query param de versión (`?v=222`) en esos HTML
para forzar refresco de caché.

## v222b — Fix real confirmado con render headless (Playwright)

El fix anterior (`.topbar-workspace`) era correcto pero no era la causa principal
del corrimiento. Verificando con Chromium headless en viewport de 390px medí
`getComputedStyle(.layout).marginLeft` y daba **64px**, no 0px como debía.

**Causa:** `nav.js` agrega la clase `nav-collapsed` a `.layout` siempre, en
cualquier tamaño de pantalla (el panel del sidebar arranca colapsado por
defecto vía localStorage). La regla `.layout.nav-collapsed { margin-left:
var(--nav-rail-w) !important }` (especificidad 0,2,0) le gana a la regla
mobile `.layout { margin-left: 0 !important }` (especificidad 0,1,0) —
ambas `!important`, pero la de mayor especificidad manda sin importar el
media query.

**Fix (nav.css):**
```css
@media (max-width: 768px) {
  .layout, .layout.nav-collapsed { margin-left: 0 !important; ... }
}
```

Volví a medir después del fix: `margin-left` da `0px` limpio, `.layout` queda
pegado al borde del viewport. Confirmado empíricamente, no solo por lectura
de código.

El desborde horizontal está resuelto con alta confianza (bug de cascada reproducible
en el código). La visibilidad de la barra/drawer mobile debería mejorar por el
aumento de z-index, pero convendría confirmar en el celular real que la barra
"Hoy / Ventas / Depósito / Cobros / Más" se ve completa y sin recortes al abrir
"Más opciones".
