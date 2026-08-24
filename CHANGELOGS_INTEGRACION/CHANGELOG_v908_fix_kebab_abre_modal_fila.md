# Fix: click en botón "⋮ Más acciones" abre el modal de la fila en vez del menú

**Reportado en:** Notas crédito/débito (pantalla adjunta), y presente en el mismo
patrón copiado en otras 5 pantallas con menú kebab (Facturación no está afectada,
ver abajo).

## Bug

Las filas clickeables (`<tr onclick="...">`) usan un guard para no disparar el
modal cuando el click cae en un control interactivo dentro de la fila:

```js
onclick="if (event.target.closest('[onclick],a,select,input,textarea') === this) verDetalleNota('${n.id}')"
```

El botón "⋮" (`.btn-kebab-*`) **no tiene atributo `onclick` inline** — se conecta
por `document.addEventListener('click', ...)` con delegación (ver
`iniciarMenuAccionesNota` y equivalentes). Como el selector del guard solo
reconoce `[onclick]` (atributo HTML literal) y no `button` en general,
`closest()` no encuentra nada interactivo en el botón kebab ni en sus hijos
(`<svg>`, `<circle>`) y sigue subiendo hasta el propio `<tr>`, que sí tiene
`onclick` → el guard da `true` → se dispara `verDetalleNota()` **antes** de que
el listener delegado (adjunto en `document`, más arriba en el árbol) llegue a
ejecutarse y abra el menú. El `ev.stopPropagation()` del listener delegado no
sirve de nada acá: llega tarde, el `onclick` inline del `<tr>` ya se disparó
en el momento en que el evento burbujeó a través de él.

Por eso el modal se abre siempre al clickear los tres puntitos, y en algunos
casos también alcanza a abrirse el menú por debajo.

## Fix

Se agrega `button` a la lista de selectores del guard, en las 16 páginas que
repiten el mismo patrón (14 con fila clickeable, más `auditoria.js` que lo usa
dos veces):

```js
event.target.closest('[onclick],a,select,input,textarea,button') === this
```

Con esto, cualquier `<button>` dentro de la fila —tenga o no `onclick` inline—
frena el guard, sin romper nada de lo que ya andaba bien (los botones que sí
tenían `onclick` inline, como "Ver", ya funcionaban porque matcheaban `[onclick]`
directamente).

Archivos tocados:
`notas.js`, `notas-credito.js`, `cc-proveedores.js`, `compras.js`,
`proveedores.js`, `productos.js`, `clientes.js`, `cheques.js`, `stock.js`,
`lotes.js`, `zonas.js`, `gastos-generales.js`, `reglas-precio.js`,
`automatizacion.js`, `fidelizacion.js`, `auditoria.js`.

**`facturacion.js` no estaba afectado** pese a tener el mismo botón kebab
delegado: su guard usa otro patrón, ya inmune a este bug —
`if (!event.target.closest('.fila-acciones')) abrirModal(...)` — que chequea
contención en el contenedor de acciones en vez de la presencia del atributo
`onclick`. Es el patrón más robusto; podría valer la pena adoptarlo como
estándar en el resto de las páginas más adelante, en vez de mantener dos
convenciones en paralelo.

## Nota

Solo 6 de las 16 páginas tenían el bug manifestándose hoy (las que ya tienen
botón kebab: `notas`, `notas-credito`, `cc-proveedores`, `compras`,
`proveedores`, y potencialmente `cheques` si se le agrega kebab a futuro). Se
corrigió en las 16 de forma preventiva porque es el mismo código copiado y el
comentario en `notas.js` ("mismo patrón de menú flotante compartido que
Facturación/Cheques/NC") indica que se van agregando kebabs a más pantallas
con el tiempo — sin este fix, cada pantalla nueva que sume un botón kebab
delegado va a pisar el mismo bug.
