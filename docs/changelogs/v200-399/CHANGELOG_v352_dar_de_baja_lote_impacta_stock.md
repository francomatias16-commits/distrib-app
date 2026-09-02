# v352 — "Dar de baja" un lote ahora descuenta el stock real

## Problema

En `Depósito → Lotes y vencimientos`, cuando hay lotes vencidos aparece el
cartel *"N lotes vencidos. Revisar y dar de baja."* — pero no existía
ninguna acción real de "dar de baja": ni botón, ni endpoint, ni RPC. La
única forma de vaciar un lote era abrir "Editar" y poner la cantidad en 0
a mano, y eso **no tocaba el stock real**, porque la tabla `lotes` es un
tracking manual de vencimientos totalmente desconectado de `stock` (así lo
dice el propio comentario del código: *"lotes es un tracking manual de
vencimientos, no se descuenta de stock"*). Resultado: un depositero podía
"vaciar" un lote vencido en la pantalla y el sistema seguía pensando que
esa mercadería está disponible para vender.

## Cambios

### Base de datos (migración `352_dar_de_baja_lote_impacta_stock.sql`)

- Nueva función `fn_lotes_dar_de_baja(p_lote_id, p_motivo, p_usuario_id)`,
  `SECURITY DEFINER`, que en una sola transacción:
  1. Descuenta del `stock` real (por `producto_id` + `deposito_id` del
     lote) exactamente la cantidad que tenía el lote — nunca lo deja
     negativo (si el stock real ya estaba por debajo, lo deja en 0).
  2. Inserta un `movimiento_stock` tipo `egreso`, con referencia al lote,
     para que quede en el historial de Stock como cualquier otro ajuste.
  3. Pone el lote en `cantidad = 0` y `cantidad_disponible = 0`.
- A propósito **no** reutiliza `ajustar_stock()` / `fn_lotes_consumir_fefo()`
  (las funciones que ya existen para ajustes normales de stock): esas
  consumen lotes por FEFO (el de vencimiento más próximo primero) sin
  importar cuál eligió el usuario. Si hay dos lotes vencidos del mismo
  producto/depósito, dar de baja uno específico por FEFO podría terminar
  vaciando otro en su lugar. `fn_lotes_dar_de_baja` ataca puntualmente el
  lote que el usuario eligió.
- Verificado con `BEGIN`/`ROLLBACK` (sin dejar datos de prueba): stock
  50 → 30 al dar de baja un lote de 20 unidades, movimiento registrado
  correctamente.

### Backend (`lib/handlers/stock.js`, dentro de `handleLotes`)

- Nueva rama `PATCH /api/lotes?accion=dar_de_baja` con body `{ id }`:
  valida permisos (mismos roles que el resto de Lotes: `dueno`, `admin`,
  `depositero`), confirma que el lote pertenece a la empresa del usuario,
  y llama a `fn_lotes_dar_de_baja` vía RPC.

### Frontend (`frontend/admin/js/lotes.js`)

- Nuevo botón **"Dar de baja"** en cada fila con `cantidad > 0` (antes solo
  había "Editar", y "Eliminar" recién aparecía cuando la cantidad ya era 0).
- `darDeBajaLote(id)`: pide confirmación explícita (mostrando cuántas
  unidades se van a descontar), llama al nuevo endpoint, y muestra el
  resultado real (`stock_anterior → stock_nuevo`) en el toast.

## Nota / deuda pendiente (no incluida en este fix)

El `PATCH` genérico de "Editar" (cambiar la cantidad a mano desde el
modal) sigue sin sincronizar `cantidad_disponible` — solo lo hace
`fn_lotes_dar_de_baja` y `fn_lotes_consumir_fefo`. No lo tocamos acá para
no meter cambios de comportamiento fuera del pedido puntual, pero si se
edita la cantidad de un lote a mano (sin usar "Dar de baja"), puede quedar
desfasado el `cantidad_disponible` respecto a `cantidad`. Si eventualmente
importa (por ejemplo, para que ese caso también entre en el cálculo FEFO),
se puede sincronizar ambas columnas en esa misma rama del handler.
