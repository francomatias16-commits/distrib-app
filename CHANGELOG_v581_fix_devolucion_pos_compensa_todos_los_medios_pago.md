# v581 — Fix: devoluciones POS no revertían la plata para efectivo/tarjeta/QR/transferencia

## Pendiente #4 de la auditoría funcional (Etapa 1 — POS)

## Problema
`rpc_registrar_devolucion_pos` siempre reponía stock correctamente, pero
solo revertía dinero cuando la venta se había pagado en `cuenta_corriente`.
Para `efectivo`, `tarjeta`, `qr` y `transferencia` no generaba ningún
movimiento compensatorio:

- **Efectivo**: `cerrar_turno_caja` seguía contando el efectivo original
  como si siguiera en la caja (nunca se insertaba nada en
  `movimientos_caja`). El cajero cerraba turno con un "sobrante calculado"
  que en realidad era la plata ya devuelta, y la diferencia contra el
  conteo físico se veía como un faltante que no existía.
- **Tarjeta / QR / transferencia**: no quedaba ningún registro de que esa
  plata había salido de algún lado.

## Decisión de negocio (Cristian)
- **Efectivo** → sangría automática en `movimientos_caja` al registrar la
  devolución.
- **Tarjeta / QR / transferencia** → se acreditan como crédito en cuenta
  corriente del cliente, igual que ya hacía `cuenta_corriente` (mientras no
  exista reversa real contra Mercado Pago).

## Fix — migración 581
`rpc_registrar_devolucion_pos` reescrita:

- El crédito de cta-cte ahora se calcula sobre `cuenta_corriente` **+**
  `tarjeta` **+** `qr` **+** `transferencia` (antes solo `cuenta_corriente`),
  con la misma fórmula proporcional que ya existía.
- Para la porción pagada en **efectivo**, se calcula el monto proporcional
  a devolver y se inserta un movimiento `sangria` en `movimientos_caja`,
  usando el turno de caja abierto (preferentemente el mismo turno de la
  venta original si sigue abierto; si no, cualquier turno abierto de esa
  caja). `cerrar_turno_caja` ya restaba los `sangria` del cálculo — no hizo
  falta tocar esa función.

### Casos borde detectados y cubiertos
No todos los casos tienen una compensación automática posible. Para esos,
en vez de fallar en silencio, la devolución se registra igual (el stock
siempre vuelve) y queda marcada con una nota visible en el panel de POS:

- **Venta sin cliente asociado** (mostrador anónimo) pagada con
  tarjeta/QR/transferencia → no hay cta-cte a la cual acreditar. Se guarda
  el aviso "No se pudo acreditar cta-cte: la venta no tiene cliente
  asociado. Compensar manualmente."
- **Devolución en efectivo sin ningún turno abierto en esa caja** → no se
  puede insertar el movimiento de caja (`turno_id` es obligatorio). Se
  guarda el aviso "No hay turno de caja abierto: no se generó la sangría
  de $X en efectivo. Ajustar manualmente al abrir turno."

Estos avisos se guardan en la nueva columna `devoluciones_pos.aviso_compensacion`
y se muestran en el historial de devoluciones del panel POS con un cartel
de advertencia.

## Verificación
Migración aplicada directamente en Supabase (proyecto `jgiquzjwoedmzwqgzubr`).
Antes de aplicarla se probaron los 4 escenarios contra datos reales de
producción, dentro de transacciones con `ROLLBACK` (nada quedó persistido
por las pruebas):

| Caso | Resultado |
|---|---|
| Efectivo, turno abierto | Insertó `sangria` en `movimientos_caja` (4→5 movimientos), sin aviso |
| Tarjeta, venta sin cliente | Sin crédito cta-cte, `aviso_compensacion` seteado |
| Cuenta corriente, con cliente (caso ya existente) | Crédito cta-cte correcto ($4.850), sin regresión |
| Efectivo, sin turno abierto (turno cerrado a propósito dentro de la transacción de prueba) | Sin insert en `movimientos_caja`, `aviso_compensacion` seteado |

## Archivos
- `supabase/migrations/581_fix_devolucion_pos_compensa_todos_los_medios_pago.sql`
  (ya aplicada en producción)
- `lib/repos/pos.js` — `listarDevolucionesDeVenta` ahora trae `aviso_compensacion`
  y `monto_acreditado_cta_cte`
- `frontend/admin/js/pos/devoluciones-promos.js` — el historial de
  devoluciones muestra el aviso cuando existe

## Pendiente (fuera de este alcance)
La reversa real contra la API de Mercado Pago para tarjeta/QR (en vez del
crédito en cta-cte como paliativo) sigue sin implementarse — coincide con
lo ya documentado en la investigación de Lapos/Prisma: por ahora no hay
integración que permita anular un cobro ya acreditado.
