# v756 — POS: Enter también en los modales "¿Emitir factura?" y "Venta registrada"

## Problema
El Enter ya confirmaba el cobro dentro del modal de pago (v753/v754), pero
los dos modales que aparecen justo después de registrar la venta —
"¿Emitir factura?" y el ticket ("Venta registrada")— no reaccionaban a
Enter: había que clickear el botón a mano.

## Fix
Se extendió el mismo listener de Enter (`pos.js`) para cubrir ambos modales:

- **"¿Emitir factura?"** (`modal-facturar-opcional-overlay`): Enter →
  "Sí, facturar ahora" (`btn-fo-facturar`), salvo que el foco ya esté
  sobre un botón (ahí se deja que el Enter nativo dispare *ese* botón
  puntual — permite Tab hasta "No, solo ticket" + Enter para cancelar).
  Se le agregó `id="btn-fo-cancelar"` al botón de cancelar para dejarlo
  identificable si hace falta en el futuro.
- **Ticket / "Venta registrada"** (`modal-ticket-overlay`): Enter →
  "Nueva venta" (su acción primaria), con el mismo criterio de no pisar
  el Enter nativo si el foco está en un botón.

Como el modal de "¿Emitir factura?" se abre encima del modal de ticket
(ambos quedan con `display` visible al mismo tiempo), el chequeo de Enter
lo prioriza a él primero.
