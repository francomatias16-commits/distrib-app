# CHANGELOG v235 — Fix overflow-x en #filtros-der (pedidos/presupuestos) + `npm run audit:breakpoints`

**Fecha:** 2026-08-26

## Contexto
La v234 (`reconciliados/CHANGELOG_v234_fase3_auditoria_mobile_barrera_regresion.md`)
había cerrado la corrida de auditoría mobile a 375px, y de paso corrió una
regresión puntual a 480/640/900/1200px que encontró 2 hallazgos preexistentes
en `pedidos` y `presupuestos` (`#filtros-der`, overflow-x a 1200px), anotados
como "no relacionados a esa migración, no tocar en esa ronda". Esta sesión
retoma exactamente ese pendiente.

## 1. Bug real: `#filtros-der` se sale del viewport entre ~901px y ~1250px
`#filtros-der` (pedidos.html, también usado por presupuestos.html vía
redirect) contiene 7 campos de filtro + 3 botones que miden ~1207px sin
envolver. Por debajo de 900px queda colapsado detrás del botón "Más
filtros" (fix v706), así que nunca es visible ahí. Por encima de esa
franja, es visible y termina saliéndose de la página en vez de envolver
sus propios hijos dentro del espacio disponible.

**Causa raíz (confirmada con Chromium real vía Playwright, no a ojo),
dos factores combinados:**

1. `frontend/shared/componentes-admin.css` tiene un selector genérico
   `.filtros-bar > *` con un reset de escritorio en
   `@media (min-width: 641px) { width: auto; max-width: none; }`. Por
   especificidad igual a `.filtros-der` (una clase cada uno) y orden de
   carga posterior, este reset pisa cualquier `max-width` que se
   intente poner en `.filtros-der` vía clase — no importa el orden en
   que se declaren las propiedades dentro de esa regla, gana por orden
   de `<link>`.
2. Aun neutralizando eso, `#filtros-der` es a la vez flex item de
   `.filtros-bar` y flex container de sus propios hijos (tiene su
   propio `flex-wrap: wrap`). Con `min-width: auto` (el default de todo
   flex item), el tamaño mínimo automático que Chromium le asigna es su
   ancho "sin envolver" — no el del hijo más angosto — así que sin
   `min-width: 0` explícito, seguía renderizándose más ancho que el
   viewport aunque tuviera `max-width` correcto.

**Fix** en `frontend/admin/css/pedidos.css`: nueva regla
`#filtros-der { min-width: 0; max-width: 100%; }`. Se usa el id (no la
clase) a propósito, para tener más especificidad que el reset genérico
de `componentes-admin.css` sin depender de en qué orden se carguen los
`<link>` — más robusto que reordenar imports o que un `!important`.

**Verificado con Chromium real, barrido de 480 a 1440px (no solo los 4
anchos de la escala de tokens), antes y después:** antes del fix,
`#filtros-der` medía 1207px fijos y se salía del viewport en todo el
rango 901–1250px (`rectRight` hasta 1258px, viewport hasta 1200px).
Después del fix, 0 excesos en todo el rango barrido, en `pedidos` y en
`presupuestos`.

## 2. `npm run audit:breakpoints` — regresión multi-ancho reutilizable
Nuevo: `scripts/audit-breakpoints.js`. Mismos 3 detectores que
`scripts/audit-mobile.js` (overflow-x / overlap / input-anómalo) y
misma infraestructura de auth/mocks, pero parametrizado por una lista
de anchos en vez de fijo a 375px — nace justamente de este bug, que
`audit-mobile.js` no podía ver (está fuera de su único viewport) y que
tampoco aparecía chequeando un solo ancho de escritorio al azar (la
ventana real del bug es angosta: ~350px de rango).

Uso: `npm run audit:breakpoints` (46 páginas × 480/640/900/1200px por
defecto) o acotado: `node scripts/audit-breakpoints.js
--paginas=pedidos,presupuestos --anchos=480,640,900,1200,1400`.

## 3. Regresión completa post-fix (46 páginas × 4 anchos token)
0 apariciones de `pedidos`/`presupuestos` en cualquier ancho — el bug
target quedó resuelto sin efectos secundarios. Los hallazgos restantes
son exactamente los mismos que ya documentaba la v234 como pendientes
para una ronda aparte (tablas sin `.tabla-wrap`: `cc-proveedores`,
`comparador-precios`, `conciliacion-bancaria`, `productos`,
`proveedores`, `reglas-precio`, `rentabilidad-producto-vendedor`,
`rentabilidad-zona`, `reportes-financieros`, `reportes-stock`,
`reportes-ventas`, `saas-billing`, más `#pos-quickbar-admin` en `pos`).
0 páginas con error de carga, 0 P0 (overlap).

## Archivos tocados
- `frontend/admin/css/pedidos.css` — regla `#filtros-der` nueva
  (`min-width: 0; max-width: 100%;`).
- `scripts/audit-breakpoints.js` — nuevo.
- `package.json` — scripts `audit:breakpoints`, `audit:breakpoints:json`.

## Pendiente (sin tocar en esta ronda, a propósito)
- La migración de los ~20 breakpoints sueltos a la escala `--bp-*`
  (mencionada en v233/v234) — quedó fuera del alcance de esta sesión
  por decisión explícita, no por falta de tooling: ya está disponible
  `audit:breakpoints` para verificarla cuando se encare.
- Los 139 hallazgos P1 de la v234 (mayormente `.tabla-wrap` faltante).
