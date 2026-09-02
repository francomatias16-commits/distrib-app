# v1000 — Chips de Estado en Pedidos forzaban scroll horizontal de toda la lista en mobile

## Contexto

Reportado con captura de un celular: en `pedidos.html`, vista de tarjetas
mobile, varias tarjetas seguidas aparecen con el borde izquierdo cortado
— el botón hamburguesa (FAB, fijo y correcto) tapa parte de la primera
tarjeta, y en las siguientes los labels ("Vendedor", "Zona", "Entrega")
aparecen truncados por la izquierda en cantidades de caracteres distintas
según el ancho de cada palabra, mientras los valores ("Lucía Fernández",
"Zona Norte", "14/08/2026") se ven completos. Mismo síntoma que v998
(panel desplazado), pero esta vez el desplazamiento es scroll horizontal
real de un contenedor, no un panél mal anclado.

## Causa

En la columna "Estado" de la tarjeta, un pedido puede mostrar hasta 3
chips a la vez: el estado (`chip-<estado>`), "Factura con error" (si la
factura de ARCA falló) y el de devolución. En el breakpoint mobile
(`@media max-width:768px`), esa `<td>` pasa a ser `display:flex` — y sus
hijos (los `<span class="chip">` sueltos) son flex items con
`flex-shrink` default (`1` pero sin `min-width:0`, así que en la práctica
no se achican por debajo de su contenido) y sin `flex-wrap` en el
contenedor. Con los 3 chips presentes, el conjunto no entra en el ancho
de la tarjeta y no tiene dónde wrappear, así que la fila (`<tr>`) termina
siendo más ancha que la pantalla.

Esa tarjeta vive dentro de `.tabla-wrap`, que tiene
`overflow-x: auto !important` a nivel global
(`frontend/shared/responsive-mobile.css`) para permitir scroll horizontal
en tablas anchas de escritorio. Al aparecer una sola fila más ancha que
el resto, **toda la lista** de pedidos (no solo esa tarjeta) se vuelve
scrolleable horizontalmente. Si ese scroll queda en una posición distinta
de cero — por ejemplo, tras un swipe accidental al scrollear la lista
verticalmente cerca del borde — todas las tarjetas se ven desplazadas por
igual, cortando sus labels por la izquierda en proporción a lo angosto o
ancho de cada palabra, exactamente el patrón reportado.

## Fix

**`frontend/admin/js/pedidos.js`**: los hasta 3 `<span class="chip">` de
la columna Estado ahora se envuelven en un único
`<span class="chips-estado-pedido">`, para que sea un solo flex item
dentro de la `<td>` (no varios) y su wrap interno no dependa del
`<td>` padre.

**`frontend/admin/css/pedidos.css`**: se agregó la regla
`.chips-estado-pedido { display:flex; flex-wrap:wrap; justify-content:
flex-end; gap:6px; min-width:0; }`, scopeada a
`#panel-pedidos .table-responsive-cards` (mismo bloque `@media
max-width:768px` ya existente). Con `flex-wrap:wrap`, si los 3 chips no
entran en una línea, el tercero baja a una segunda línea en vez de
empujar el ancho total de la tarjeta — cada línea mantiene el alineado a
la derecha (`justify-content:flex-end`) por separado, así que el wrap no
rompe la alineación visual. Esto elimina la posibilidad de que esta
columna en particular fuerce overflow horizontal en la lista completa.

Bump de cache-busting (`?v1000fix`) en `pedidos.html` para
`pedidos.css` y `pedidos.js`.

## Fuera de alcance

- No se tocó el `overflow-x:auto !important` global de `.tabla-wrap` en
  `responsive-mobile.css` — sigue siendo necesario para tablas anchas de
  escritorio; el fix ataca la causa puntual (el contenido que fuerza el
  ancho extra), no el mecanismo de scroll en sí.
- No se auditaron otras columnas o pantallas por el mismo patrón (varios
  elementos inline sin wrap dentro de una `<td>` que pasa a flex en
  mobile) — este fix es puntual al caso reportado (columna Estado de
  Pedidos). Si aparece el mismo síntoma en otra lista con chips/badges
  múltiples por fila, el mismo patrón (agrupar en un wrapper con
  `flex-wrap:wrap`) aplicaría igual.

## Verificación

- Revisado el CSS resultante: la regla nueva no tiene `!important` y no
  compite con ninguna otra sobre `.chips-estado-pedido` (clase nueva, sin
  usos previos en el proyecto).
- No verificable en este entorno: confirmación visual en un dispositivo
  mobile real con un pedido que tenga los 3 chips simultáneos (no hay
  navegador/Playwright disponible en este sandbox — mismo problema ya
  documentado en `docs/auditorias/2026-08_auditoria_mobile_PROGRESO.md`).
