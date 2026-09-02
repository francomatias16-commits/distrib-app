# CHANGELOG v474 — Fix botón "Más acciones" en clientes + superposición visual en stock

## 1. Botón de acciones en Clientes (clientes.html / clientes.js)

Antes: el botón siempre decía "Más acciones" con chevron y dropdown, incluso
cuando la única opción disponible era "Exportar" (caso normal, sin clientes
pendientes de geocodificar). Un dropdown de una sola opción no es lógico.

Ahora el botón tiene dos modos, controlados por `actualizarModoBotonAcciones()`:

- **Modo "menu"** (hay clientes pendientes de geocodificar → 2+ acciones):
  se comporta como dropdown, label "Más acciones", chevron visible.
- **Modo "directo"** (solo Exportar disponible, caso normal): el botón deja
  de ser dropdown, no tiene chevron ni menú, y al hacer click exporta
  directamente. Label pasa a "Exportar" con ícono de descarga.

El modo se recalcula al cargar la página y de nuevo tras resolverse el
chequeo asíncrono de geocodificación pendiente, para que el botón cambie a
"menu" si aparecen pendientes después de la carga inicial.

De paso se corrigió un bug de TDZ (temporal dead zone): `_pendientesGeocodificar`
se estaba referenciando antes de su declaración en el flujo de arranque; se
reordenó la declaración para que quede antes de los llamados inmediatos que
la usan.

## 2. Superposición "Normal" / "Ajustar stock" en Stock (stock.html / stock.js)

Causa raíz: la columna "Acciones" tenía la clase `col-sticky-end`
(`position: sticky`), pensada para tablas con scroll horizontal como
Clientes/Proveedores. La tabla de Stock tiene 9 columnas que entran
completas en pantalla sin necesitar scroll, así que el sticky no cumplía
ningún propósito ahí — y en cambio hacía que la columna "Acciones" se
desplazara y quedara montada sobre el badge "Normal" de la columna
"Estado" contigua.

Se sacó `col-sticky-end` de:
- El `<th>` de "Acciones" en `stock.html` (ya corregido en la sesión anterior).
- El `<td class="td-acciones">` de cada fila en `stock.js` — **este quedaba
  pendiente**: el header ya no era sticky, pero cada celda de datos de
  "Acciones" seguía teniendo la clase y el problema de superposición se
  iba a repetir en cada fila de la tabla. Ya está resuelto en ambos lugares.

## Archivos modificados
- `frontend/admin/clientes.html`
- `frontend/admin/js/clientes.js`
- `frontend/admin/stock.html`
- `frontend/admin/js/stock.js`
