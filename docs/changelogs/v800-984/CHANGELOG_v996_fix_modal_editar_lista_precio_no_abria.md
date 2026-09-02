# v996 — "Editar" (y "+ Nueva lista") no abrían el modal en Listas de precio (clientes.html)

## Contexto

`clientes.html` (pestaña "Listas de precio") reportado: el botón "Editar"
de cada lista no responde. Reportado específicamente en mobile.

## Causa

`.modal` en este módulo es un panel lateral que siempre está en
`display:flex` (regla base en `componentes-admin.css`, scope
`body.dash-clientes-gentelella .modal`) y se desliza a la vista
animando `right` — arranca en `right: -600px` (fuera de pantalla) y pasa
a `right: 0` únicamente cuando se le agrega la clase `.open`
(`clientes.css`: `.modal.open { right: 0; }`).

Los otros dos modales del mismo módulo (`modal-precio` en
`precios-especiales.js`, `modal-direccion` en `direcciones.js`) hacen
correctamente `classList.add('open')` al abrir y `classList.remove('open')`
al cerrar, además de tocar `style.display` (que solo maneja el
mostrar/ocultar del backdrop y es redundante para el modal en sí, ya que
la base CSS ya lo deja en `flex`).

`abrirModalListaPrecio()` / `cerrarModalListaPrecio()` en
`listas-precio.js` — el tercer modal del mismo módulo, agregado en el
split de clientes.js del 25/08 — nunca tocaban la clase `.open`. El
`style.display = 'flex'` que sí seteaban no alcanzaba: la posición
seguía clavada en `right: -600px`, así que el modal nunca se veía, tanto
al editar una lista existente como al crear una nueva (mismo botón
`abrirModalListaPrecio()` sin argumento).

No es un bug exclusivo de mobile — el mecanismo de `right` off-canvas es
el mismo en cualquier ancho de pantalla — pero es consistente con el
reporte: no hay ningún override responsive para `.modal` que lo
distinga por viewport.

## Fix

**`frontend/admin/js/clientes/listas-precio.js`**:
- `abrirModalListaPrecio()`: agrega `document.getElementById('modal-lista-precio').classList.add('open')`.
- `cerrarModalListaPrecio()`: agrega el `classList.remove('open')` simétrico.

Mismo patrón ya usado en `modal-precio` y `modal-direccion` — no se
inventó un mecanismo nuevo.

## Fuera de alcance

- No se tocó `style.display` (sigue innecesario pero inofensivo — no se
  quitó para minimizar el diff).
- No se revisó ningún otro modal fuera de este módulo; los otros 4
  módulos que comparten la forma base de `.modal` (compras, facturación,
  productos, stock) no fueron reportados y no se auditaron acá.

## Verificación

- `node --check` sobre `listas-precio.js`: sin errores de sintaxis.
- Comparación línea por línea contra `precios-especiales.js` y
  `direcciones.js` (mismo módulo, mismo patrón de modal lateral):
  confirmado que son los únicos dos que sí tenían el `classList.add/remove('open')`
  y que `listas-precio.js` era el único de los tres sin él.
- No hay test e2e de "Listas de precio" en `tests/e2e/` (no existía
  cobertura que lo hubiera atrapado antes).
- No verificable en este entorno: click real en un dispositivo mobile
  para confirmar el panel deslizándose a la vista (no hay browsers
  disponibles en este sandbox).
