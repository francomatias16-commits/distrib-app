# v799 — Fix: modal "Registrar devolución" aparecía abierto solo y no cerraba

## Problema
Al entrar a Devoluciones, el modal "Registrar devolución" aparecía
abierto sin que nadie lo abriera, y ni el botón "Cancelar" ni la "X"
lo cerraban.

## Causa raíz
En el fix del layout del v797 (header/footer fijos del modal), la
regla CSS `#modal-nueva-devolucion { display: flex !important; ... }`
quedó aplicada **siempre**, por ID, sin condicionarla a que el modal
esté realmente abierto. Un `!important` en CSS le gana a un estilo
inline sin `!important` — así que esa regla pisaba tanto el
`style="display:none"` inicial del HTML (por eso aparecía abierto al
cargar la página) como el `style.display = 'none'` que
`cerrarModalNuevaDevolucion()` pone al hacer clic en "Cancelar"/"X"
(por eso no cerraba nunca: el JS corría bien, pero el CSS ganaba
igual).

## Fix
- `frontend/admin/css/devoluciones-gentelella.css`: el `display: flex
  !important` se movió a una regla aparte, condicionada a la nueva
  clase de estado `#modal-nueva-devolucion.nd-abierto`. El resto del
  layout (position, tamaño, flex-column, overflow del v797) sigue
  igual e inofensivo mientras el modal está oculto.
- `frontend/admin/js/devoluciones.js`: `abrirModalNuevaDevolucion()`
  ahora agrega la clase `nd-abierto` (y pone `display:'flex'` inline)
  al abrir; `cerrarModalNuevaDevolucion()` saca la clase (y pone
  `display:'none'`) al cerrar — clic en "Cancelar", en la "X" o en el
  backdrop.

Verificado: el modal ya no aparece al cargar Devoluciones, y
"Cancelar" / "X" / clic afuera lo cierran correctamente.
