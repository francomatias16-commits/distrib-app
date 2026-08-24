# v736 — Conciliación bancaria: auto-selecciona el extracto más reciente al abrir

## Problema
Al entrar a `/admin/conciliacion-bancaria`, la pantalla cargaba la lista de
"Extractos importados" pero el panel de movimientos quedaba vacío hasta que
el usuario clickeaba manualmente uno de la lista. `cargarLotes()` nunca
llamaba a `seleccionarLote()`.

## Cambio
`frontend/admin/js/conciliacion-bancaria.js`:

- `cargarLotes()`: después de traer y renderizar la lista, si no hay ningún
  lote activo (`!loteActivoId`) y hay al menos un extracto, auto-selecciona
  el primero — que ya viene primero por `created_at desc` desde
  `lib/repos/conciliacion-bancaria.js:60` (`.order('created_at', {
  ascending: false })`), o sea el más reciente.
- Se respeta la selección existente: si ya había un lote activo (por
  ejemplo, se está refrescando la lista después de eliminar otro extracto),
  no se lo pisa.
- `onArchivoSeleccionado()` (importar CSV nuevo): antes llamaba
  `cargarLotes()` y después `seleccionarLote(data.id)` a mano. Ahora limpia
  `loteActivoId = null` antes de `cargarLotes()`, que se encarga solo de
  seleccionar el recién importado (siempre queda primero en la lista) —
  se evita la doble llamada a `cargarMovimientos()`.

## Testing manual
1. Entrar a `/admin/conciliacion-bancaria` con extractos ya importados →
   el más reciente debe aparecer seleccionado y su tabla de movimientos
   cargada, sin clickear nada.
2. Importar un CSV nuevo → debe quedar seleccionado automáticamente
   (comportamiento ya existía, ahora sin duplicar el fetch).
3. Eliminar el extracto activo → debe caer al que quede primero en la
   lista (o vaciarse si no queda ninguno).
4. Eliminar un extracto que NO está activo → el seleccionado actual no
   debe cambiar.
