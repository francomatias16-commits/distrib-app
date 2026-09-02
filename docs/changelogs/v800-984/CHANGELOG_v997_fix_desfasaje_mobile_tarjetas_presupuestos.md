# v997 — Desfasaje/desborde en las tarjetas mobile de Presupuestos (pedidos.html)

## Contexto

Reportado: en la pestaña "Presupuestos" de `pedidos.html`, en mobile, las
tarjetas de cada presupuesto se ven desalineadas — sobre todo la fila de
acciones ("Reenviar WhatsApp", "✓ Pedido generado"), que aparece
desbordada/desprendida del borde de la tarjeta.

## Causa

`pedidos.html` tiene dos tablas `.tabla-admin` dentro de `.tabla-wrap
.table-responsive-cards` en la misma página: la de Pedidos (`#panel-pedidos`,
usa clases propias `.td-id`/`.td-cliente`/`.td-text`/`.btn-estado`/etc.) y la
de Presupuestos (`#panel-presupuestos`, celdas planas con solo `data-label`,
sin esas clases).

El bloque "tabla → tarjetas" para mobile en `pedidos.css` estaba escrito
para la tabla de Pedidos pero **sin scopear** — su selector era
`.table-responsive-cards .tabla-admin ...` a secas, así que también
matcheaba la tabla de Presupuestos. Esa tabla ya tenía su propia
implementación genérica del mismo patrón en
`frontend/shared/componentes-admin.css` (agregada como generalización del
patrón "Hallazgo #5" para cualquier `.tabla-admin` de cualquier página),
con una mecánica de layout **distinta**: `pedidos.css` arma cada `<td>`
como flexbox (`display:flex`, label y valor lado a lado); la de
`componentes-admin.css` usa `position:absolute` para el label sobre un
`<td>` en `display:block` con `padding-left:42%`.

Al competir ambas reglas con la misma especificidad sobre el mismo
elemento, y cargarse `componentes-admin.css` *después* de `pedidos.css` en
el `<head>`, el resultado terminaba siendo una mezcla: `display` quedaba
en `block` (ganado por `componentes-admin.css`, por orden de carga) pero
sin el `padding-left`/`position:absolute` completos porque el resto de
reglas de `pedidos.css` (con clases que Presupuestos no tiene, como
`.td-acciones`) nunca llegaban a aplicarse — el `<td>` de acciones de
Presupuestos usa la clase `acciones`, no `td-acciones`. El resultado:
un layout híbrido roto, con el número/label de la primera celda sin
mostrarse bien y los botones de acción (con `white-space:nowrap` inline)
desbordando el ancho de la tarjeta en vez de apilarse o achicarse.

## Fix

**`frontend/admin/css/pedidos.css`**: se scopeó todo el bloque "Tabla →
Tarjetas en mobile" a `#panel-pedidos` (el contenedor real de la tabla de
Pedidos), para que deje de matchear la tabla de Presupuestos. Presupuestos
ahora depende exclusivamente de la implementación genérica de
`componentes-admin.css`, que ya funciona correctamente en otras páginas
con celdas planas (ej. Stock).

No se tocó `componentes-admin.css` ni la lógica JS de ninguna de las dos
tablas — el bug era puramente de dos hojas de estilo compitiendo por el
mismo selector sin scope.

## Fuera de alcance

- `pedidos-gentelella.css` tiene su propio bloque mobile
  (`body.dash-pedidos-gentelella .table-responsive-cards ...`), pero solo
  toca colores/bordes/sombra vía tokens `--ge-*`, todo con `!important` —
  no define `display`/`padding`/`position`, así que no participa del
  conflicto y no fue necesario tocarlo (sigue aplicando, inofensivamente,
  también a Presupuestos — incluso ayuda a que ambas tablas compartan
  paleta).
- No se auditaron otras páginas por el mismo patrón de bloques
  "tabla → tarjetas" sin scopear — este chequeo quedó acotado a
  pedidos.html porque es la única página con dos tablas `.tabla-admin`
  distintas conviviendo en el mismo documento.

## Verificación

- Repasado el CSS resultante: balance de llaves correcto, sin quedar
  ningún selector de ese bloque sin el prefijo `#panel-pedidos`.
- Confirmado en `pedidos.js` que `.td-id`/`.td-cliente`/`.td-text`/
  `.btn-estado`/`.btn-cancelar-small`/`.btn-eliminar-small` se usan
  exclusivamente en el render de la tabla de Pedidos, nunca en
  `presupuestos.js` — el scope no le quita nada al comportamiento mobile
  ya andando de Pedidos.
- No hay tests e2e de mobile para Presupuestos (`tests/e2e/page-objects/admin/presupuestos.page.js`
  no tiene locators ni specs de viewport mobile) que hubieran atrapado
  esto antes.
- No verificable en este entorno: captura real en un dispositivo mobile
  para confirmar visualmente que las tarjetas de Presupuestos ahora usan
  el layout de `componentes-admin.css` sin mezcla (no hay browsers
  disponibles en este sandbox).
