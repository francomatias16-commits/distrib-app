# v896 — Fix: botón "⋮" (más acciones) no abría el menú en 5 pantallas

## Causa raíz
El botón kebab (⋮) tenía `onclick="event.stopPropagation();"` inline. La única
lógica que abre el menú vive en un listener delegado en `document`
(`document.addEventListener('click', ...)`). Al detener la propagación en el
propio botón, el click nunca llegaba a `document` → el menú jamás se abría.
No era un botón sin función: era un botón cuyo propio código bloqueaba su
único mecanismo de apertura.

En `facturacion.html` (tab Facturas) la fila (`<tr>`) además tiene
`onclick="abrirModal(...)"`, así que sacar el `stopPropagation` sin más
hubiera abierto el modal de detalle al clickear el kebab.

## Fix
- `js/notas.js`, `js/notas-credito.js`, `js/compras.js`, `js/proveedores.js`:
  se quitó el `onclick="event.stopPropagation();"` inline del botón kebab
  (sus filas no tienen onclick propio, no hacía falta).
- `js/facturacion.js` (tab Facturas): mismo quite en el botón kebab, y el
  `onclick` de la fila pasó a
  `if (!event.target.closest('.fila-acciones')) abrirModal(...)` para que
  clickear "Ver" o el kebab no dispare también el modal.

## Alcance verificado
Los 5 menús ya tenían acciones reales cargadas (no eran duplicado de "Ver"):
- Notas: Anular
- Facturas: Reintentar emisión / Ver PDF (según estado)
- Notas de crédito/débito: Emitir a AFIP / Ver PDF (según estado)
- Compras (OC): Eliminar / Cancelar orden (según estado)
- Proveedores: Ver compras / Abrir portal

Se descartó el mismo bug en `cc-proveedores.js` (el patrón "piloto") y en
`cheques.js` (no usa kebab): ninguno tiene el `stopPropagation` inline
problemático.
