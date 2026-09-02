---
slug: cobros-y-cuenta-corriente
categoria: cobranzas
roles: [dueno, admin, vendedor, contador]
---

# Cobros y cuenta corriente de clientes

## Registrar un cobro

1. Elegí el cliente y el medio de pago (efectivo, transferencia, cheque, etc.).
2. Ingresá el monto y, si corresponde, una referencia (número de operación, por ejemplo).
3. Confirmá — el cobro impacta automáticamente el saldo de cuenta corriente del cliente.

Cada cobro tiene una clave de idempotencia interna para evitar que quede duplicado si por algún motivo se reintenta la operación (por ejemplo, un doble clic o un reintento de red).

## Cheques

Los cheques recibidos como forma de pago se registran con banco, número, monto y fecha de vencimiento. Un cheque puede estar en distintos estados a medida que avanza (recibido, depositado, rechazado, etc.). Cuando el cheque se cobra efectivamente, queda vinculado al cobro correspondiente.

## Cuenta corriente

Cada cliente tiene un saldo de cuenta corriente que se actualiza con cada factura (suma deuda) y cada cobro (resta deuda). También se ve ahí:
- El **límite de crédito** habilitado para el cliente.
- Los días de crédito que tiene otorgados.

Si el saldo de un cliente supera su límite de crédito, el sistema puede bloquear nuevos pedidos hasta que regularice la deuda (ver artículo de bloqueo de clientes).

## Preguntas frecuentes

**¿Qué pasa si registro un cobro por un monto mayor a la deuda del cliente?**
El cliente queda con saldo a favor, que se puede descontar de una futura factura.

**¿Se puede anular un cobro ya cargado?**
Depende de los permisos de tu rol. Como regla general, ante un error conviene registrar un movimiento de ajuste en vez de eliminar el cobro, para no perder el rastro contable.

**¿Cómo sé si un cheque todavía no se depositó?**
Podés revisar el estado del cheque — mientras no esté marcado como cobrado, no impacta el saldo real de caja.
