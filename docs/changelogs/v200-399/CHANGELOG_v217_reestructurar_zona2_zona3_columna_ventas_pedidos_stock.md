# CHANGELOG v217 — Reestructuración ZONA 2 + ZONA 3 del Panel principal

## Problema
Con el fix de v216 (`align-items: stretch` en `.dash-tablas-grid`), la
tarjeta "Ventas del período" quedaba emparejada directo contra "Necesita
tu atención" en la misma fila. Como la tarjeta de alertas suele ser mucho
más alta (varias alertas listadas), el stretch obligaba al gráfico de
ventas a estirarse a esa misma altura, dejando un gráfico chico flotando
en medio de una tarjeta enorme y vacía. Look poco profesional.

## Causa raíz
"Ventas del período" no tiene relación de contenido con "Necesita tu
atención" — emparejarlas en la misma fila fuerza una altura común que no
tiene sentido para ninguna de las dos. La agrupación natural es con
"Pedidos recientes" y "Stock crítico", que sí conforman junto al gráfico
un mismo bloque temático ("actividad reciente / ventas").

## Cambios — frontend/admin/dashboard.html
- **ZONA 2 + ZONA 3 unificadas** en un solo contenedor
  `dash-panel-grid` de 2 columnas:
  - **Columna izquierda:** `dash-atencion-card` ("Necesita tu atención"),
    ocupa toda la altura de la fila.
  - **Columna derecha:** `dash-columna-derecha`, un `flex-column` con:
    1. `dash-grafico-card` ("Ventas del período") arriba, con su alto
       natural (ya no estirado).
    2. `dash-tablas-grid` abajo, con "Pedidos recientes" y "Stock
       crítico" en 2 columnas, igual que antes.
- Eliminado el bloque duplicado de ZONA 3 (las tarjetas de Pedidos/Stock
  quedaron movidas dentro de la nueva columna derecha; no hay IDs
  repetidos).
- `#grafico-ventas`: `min-height` vuelve a 200px (ya no necesita
  compensar el estirado de v216, porque ahora convive con tarjetas de
  tamaño acorde en su propia columna).

## Cambios — frontend/admin/css/dashboard.css
- Nueva clase `.dash-panel-grid`: grid de 2 columnas
  (`minmax(320px, 1fr) minmax(420px, 1.6fr)`), `align-items: stretch`,
  `gap: 16px`. Reemplaza a `.dash-tablas-grid` como contenedor de
  ZONA 2+3.
- `.dash-panel-grid > .dash-atencion-card { height: 100% }` para que la
  tarjeta de alertas ocupe toda la fila.
- Nueva clase `.dash-columna-derecha`: `flex-direction: column`,
  `gap: 16px`, `height: 100%`.
  - `> .dash-grafico-card { flex: 0 0 auto }` — el gráfico no se estira,
    conserva su alto natural.
  - `> .dash-tablas-grid { flex: 1 }` — pedidos/stock ocupan el resto
    del espacio disponible en la columna.
- `.dash-tablas-grid` (uso interno, ahora anidada): `grid-template-columns`
  ajustado de `minmax(280px, 1fr)` a `minmax(340px, 1fr)` para que las
  tablas de pedidos/stock no queden demasiado angostas dentro de la
  columna derecha.
- Responsive (`max-width: 1024px`): `.dash-panel-grid` pasa a 1 columna;
  tanto `.dash-atencion-card` como `.dash-columna-derecha` vuelven a
  `height: auto`.

## Resultado esperado
- "Necesita tu atención" y el bloque de ventas/pedidos/stock quedan
  claramente separados en dos columnas, cada una con la altura que
  corresponde a su propio contenido.
- "Ventas del período" ya no aparece sobredimensionada ni con espacio
  vacío alrededor del gráfico.
- "Pedidos recientes" y "Stock crítico" se mantienen parejos entre sí
  (fix de v216 sigue vigente, ahora dentro de la columna derecha).
- Sin bloques duplicados ni IDs repetidos en el HTML.

## Archivos modificados
- `frontend/admin/dashboard.html`
- `frontend/admin/css/dashboard.css`
