# v800 — Fix: se podía registrar una devolución de un producto que el cliente nunca compró

## Problema
El alta manual de devoluciones (modal "Registrar devolución") dejaba
elegir cualquier producto activo de la empresa, sin importar si ese
cliente lo compró alguna vez. El campo "Pedido de origen" es
opcional, así que ni siquiera hacía falta atarlo a un pedido real.
Resultado: se podían generar notas de crédito al cliente y notas de
débito al proveedor sobre mercadería que nunca circuló.

## Causa raíz
- Backend (`crearDevolucionCore`, compartido por el alta manual del
  admin y por la app del chofer): solo validaba `motivo`, que hubiera
  al menos un ítem, y que existiera `cliente_id` — nunca cruzaba los
  `producto_id` contra el historial de compras del cliente.
- Frontend (`ProductoPicker` dentro del modal de devoluciones): lista
  siempre TODOS los productos activos de la empresa, sin filtrar por
  cliente.

## Fix

### Backend (bloqueo real, es la validación que importa)
- `lib/repos/pedidos.js`: nuevo `obtenerProductosCompradosPorCliente(empresa_id, cliente_id)`
  — set de `producto_id` que ese cliente compró alguna vez (via
  `pedido_items` ⋈ `pedidos`).
- `lib/handlers/pedidos.js` → `crearDevolucionCore()`: antes de
  insertar, rechaza (400) cualquier ítem cuyo producto no esté en ese
  set. Cubre tanto el alta manual del admin como el registro desde la
  app del chofer.

### Frontend (evita el error antes de que pase, guía al usuario)
- `frontend/admin/js/producto-picker.js`: nuevo método opcional
  `setSoloPermitidos(ids)` — filtro duro que restringe qué productos
  se pueden ver/agregar. `null`/no usarlo = comportamiento normal (no
  afecta los pickers de Pedidos ni Presupuestos, que no lo llaman).
  Mensaje de "vacío" distinto cuando el filtro viene de esto ("Este
  cliente no tiene productos comprados para devolver.").
- `frontend/admin/devoluciones.html` / `devoluciones.js`: el picker
  arranca tapado por un aviso ("Elegí un cliente para ver los
  productos que compró.") hasta que se selecciona un cliente. Al
  elegirlo, se carga su historial real de compras (mismo criterio que
  el backend) y se filtra el picker a eso. Si el cliente cambia
  después de haber agregado ítems, los que ya no correspondan se
  sacan automáticamente de "Seleccionados".

Verificado: ya no se puede seleccionar ni guardar un producto que el
cliente no compró, ni desde el picker (no aparece) ni forzando la
llamada al backend (la rechaza con 400).
