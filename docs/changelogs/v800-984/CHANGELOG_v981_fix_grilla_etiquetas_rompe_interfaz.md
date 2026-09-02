# Fix: la grilla de impresión de etiquetas quedaba visible en pantalla y rompía la interfaz (v981)

## Problema (confirmado con las 2 capturas)
Después de tocar "Vista previa de prueba" en Etiquetas de precio, o después
de cerrar el modal "Generar etiquetas" en Productos (que reusa el mismo
motor vía `etiquetas-preview.js`), la grilla de etiquetas quedaba flotando
sobre el resto de la interfaz — visible arriba a la derecha, tapando
contenido, sin cerrarse nunca.

## Causa raíz
`montarGrilla()` (`etiquetas-print.js`) agrega `#etiquetas-print-root` como
último hijo de `<body>` cada vez que se genera una vista previa/impresión —
eso está bien, es el mismo patrón que `pos-printer.js`. El problema estaba
en `prepararPaginaEtiquetas()`: el `display: grid` de `#etiquetas-print-root`
vivía **fuera** de `@media print`, aplicando siempre, en cualquier pantalla.
El `visibility: hidden` que sí estaba escopado a `@media print` solo oculta
el RESTO de la página durante la impresión — nunca ocultaba la grilla en sí
en el uso normal (pantalla), porque nunca tuvo un `display: none` de base.//
Resultado: cada vista previa dejaba una grilla real, visible, sin remover,
sentada en el DOM para siempre — se veía en cualquier pantalla que se
visitara después mientras esa página siguiera cargada.

## Fix
`#etiquetas-print-root` ahora arranca con `display: none` por defecto, y
solo pasa a `display: grid` (posicionado absoluto) dentro de `@media print`.
En pantalla nunca se ve; en el diálogo de impresión del navegador se
muestra igual que antes. Un solo archivo tocado: `frontend/admin/js/etiquetas-print.js`.

Mismo motor compartido por las dos pantallas (Etiquetas de precio directo,
y Productos vía `etiquetas-preview.js` → `EtiquetasPrint.imprimir()`), así
que el fix resuelve los dos casos de la captura con un solo cambio.
