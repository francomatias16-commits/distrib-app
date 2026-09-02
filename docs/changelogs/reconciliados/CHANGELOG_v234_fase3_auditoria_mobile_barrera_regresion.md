# CHANGELOG v234 — Fase 3: QA visual real en mobile + barrera de regresión CSS

**Fecha:** 2026-08-25

## Contexto
La v233 (`reconciliados/CHANGELOG_v233_fase2_cierre_modal_y_breakpoints.md`)
había cerrado la Fase 2 dejando un único pendiente marcado como "bloqueado
por falta de navegador en el entorno": QA visual real en viewport mobile.
Esa restricción no aplica en este entorno — Chromium vía Playwright levanta
sin problema (`chromium.launch()` verificado) — así que la Fase 3 del
`PLAN_RESPONSIVE_MOBILE_COMPLETO.md` pasó de "código a ciegas" a auditoría
real, corrida y verificada de punta a punta en esta sesión.

## 1. Bug real encontrado y corregido: modal de compras siempre visible
`compras.html` reutiliza el modal de "generar etiquetas" (mismo HTML/JS que
`productos.html`), pero `compras.css` nunca tuvo su propia regla `.modal` —
a diferencia de `clientes/facturacion/productos/stock`, que sí la tienen
consolidada en `componentes-admin.css` desde la v233. Sin esa regla, el
modal caía al `.modal` genérico y centrado de `adminlte-components.css`,
que no define un estado "cerrado" — quedaba siempre visible tapando toda la
página, en cualquier ancho de pantalla (no es un bug de mobile específico).

**Reproducido y verificado en este entorno, no solo asumido:** se revirtió
el fix a propósito, se re-corrió la auditoría, y volvió a aparecer (ver
captura `docs/auditorias/screenshots_mobile/compras.png` de esa corrida:
modal "Nueva orden de compra" tapando el fondo). Con el fix reaplicado,
0 hallazgos en `compras`.

Fix: se sumó `compras` al selector compartido en
`frontend/shared/componentes-admin.css` (mismo patrón `body.dash-X .modal`
que las otras 4 páginas) y se agregó el delta propio (`right`, `width: 580px`
igual que `productos.css`, que es el mismo componente reutilizado) en
`frontend/admin/css/compras.css`.

## 2. Script de auditoría mobile automatizada (`npm run audit:mobile`)
Nuevo: `scripts/audit-mobile.js`. Reusa la infraestructura de mocks ya
construida para los E2E (`auth-helper`, `static-server`, `mock-network`,
`supabase-rest-mock`) — visita las 46 páginas admin con sesión, en viewport
375×812, y detecta 3 patrones:
- **overflow-x**: elemento cuyo `scrollWidth` excede el viewport y que
  efectivamente se pinta dentro de pantalla (se excluyen paneles fuera de
  pantalla a propósito, para no generar falsos positivos).
- **overlap** (P0): `.modal`/`.dropdown` visible cuyo bounding box se cruza
  con contenido de página también visible.
- **input-anomalo**: inputs/selects/textareas con `offsetHeight > 100px`.

Durante el desarrollo se corrigió un falso positivo propio: el detector de
overflow inicialmente marcaba paneles `.modal` correctamente cerrados fuera
de pantalla (`right: -600px`) como si excedieran el viewport, sin verificar
que el elemento se pintara dentro de los límites visibles. Corregido y
reverificado (`productos.html` ya no aparece por esa causa).

## 3. Resultado de la corrida completa (46 páginas)
**139 hallazgos reales en 15 páginas, 0 páginas con error de carga, 0 P0
(overlap) tras el fix del punto 1.** Reporte completo en
`docs/auditorias/2026-08_auditoria_mobile.md`, screenshots en
`docs/auditorias/screenshots_mobile/`.

Casi todos los hallazgos (P1, overflow-x) son tablas de datos sin el patrón
`.tabla-wrap` responsive: `cc-proveedores`, `comparador-precios`,
`conciliacion-bancaria`, `export-contable`, `productos`, `proveedores`,
`reglas-precio`, `rentabilidad-producto-vendedor`, `rentabilidad-zona`,
`reportes-financieros`, `reportes-stock`, `reportes-ventas`, `saas-billing`.
Dos casos puntuales no tabulares: `#pos-quickbar-admin` en `pos.html` y una
fila de tabs cortada por 11px en `facturacion.html`. Esto es una lista
concreta y accionable para una ronda de arreglos — bastante más grande que
lo que se sabía pendiente antes de tener QA visual real.

**No corregidos en esta ronda** (quedan para la ronda de arreglos que
justamente motiva este reporte): son 139 puntos de CSS específicos por
página, no una consolidación de componente compartido como los puntos 1 y 4
— mezclar ambos hubiera hecho un diff enorme y difícil de revisar.

## 4. Barrera de regresión CSS (`npm run check:shared-selectors`)
Nuevo: `scripts/check-shared-selectors.js`. Sin navegador — grep liviano
sobre `frontend/admin/css/*.css`. Falla si aparece un selector compartido
(`.filtros-bar`, `.modal`, `.tabla-wrap`, `.chip`, `.badge-estado`,
`.btn-exportar`/`.btn-importar`) declarado en un archivo que no está en una
lista blanca.

La lista blanca es un **snapshot real del estado actual**, generado
programáticamente (no a mano) al momento de escribir el script — incluye la
familia `frontend/admin/css/*-gentelella.css`, un segundo set de hojas de
estilo por página que la consolidación de la v233 no había relevado porque
varias páginas cargan ambos archivos en cascada (ej. `clientes.html` carga
`clientes.css` **y** `clientes-gentelella.css`). El punto del script no es
certificar que las ~70 declaraciones existentes son deltas prolijos, sino
impedir que se sume una **nueva** sin revisar — que es el mecanismo exacto
del bug del punto 1.

Verificado con una regresión simulada (se agregó `.modal` a `reportes.css`,
no whitelisteado): exit code 1, mensaje señala el archivo y selector
correctos. Revertida la simulación, vuelve a exit code 0.

## Archivos tocados
- `frontend/shared/componentes-admin.css` — suma `compras` al selector
  `.modal` compartido.
- `frontend/admin/css/compras.css` — delta propio del modal.
- `scripts/audit-mobile.js` — nuevo.
- `scripts/check-shared-selectors.js` — nuevo.
- `package.json` — scripts `audit:mobile`, `audit:mobile:json`,
  `check:shared-selectors`.
- `docs/auditorias/2026-08_auditoria_mobile.md` — nuevo, reporte de la
  corrida completa.
- `docs/auditorias/screenshots_mobile/*.png` — nuevo, 46 capturas.

## Estado de la Fase 3
El bloqueo de Fase 0/QA visual mencionado en la v233 no existe en este
entorno. Con eso resuelto: bug P0 encontrado y corregido, infraestructura de
auditoría reutilizable en pie, barrera de regresión activa y verificada.
Queda pendiente para una próxima ronda: los 139 hallazgos P1 (mayormente
`.tabla-wrap` faltante en tablas de reportes) y la migración de los ~20
breakpoints sueltos a la escala `--bp-*` (mencionada en la v233), que ahora
sí se puede hacer con QA visual real en vez de a ciegas.
