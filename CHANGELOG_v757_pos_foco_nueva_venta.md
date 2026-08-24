# v757 — POS: foco automático en "Nueva venta" tras cerrar/facturar

## Pedido
Después de facturar (o de cerrar el modal "¿Emitir factura?" de cualquier
forma), el foco debe quedar en el botón "Nueva venta" del ticket para que
un segundo Enter arranque la siguiente venta sin tocar el mouse.

## Cambios (`pos.js`, `pos.html`)
- Botón "Nueva venta" del modal de ticket: se le agregó
  `id="btn-ticket-nueva-venta"` para poder enfocarlo por código.
- `cerrarModalFacturarOpcional()`: ahora, al cerrar el modal "¿Emitir
  factura?" (por "No, solo ticket", por la X, o automáticamente al
  terminar de facturar / encolar offline — los tres casos lo llaman),
  enfoca "Nueva venta". Cubre exactamente el estado de la captura:
  factura ya emitida, modal de ticket como único activo.
- `mostrarTicket()`: si el usuario no es dueño/admin (o no hay
  `venta_id`), el modal "¿Emitir factura?" nunca se abre — en ese caso
  el foco va directo a "Nueva venta" apenas se muestra el ticket, en vez
  de quedar sin ningún elemento enfocado.

Como el handler de Enter (v756) ya deja pasar el Enter nativo cuando el
foco está sobre un `<button>`, con el foco puesto ahí un segundo Enter
dispara el click de "Nueva venta" sin necesitar más lógica.
