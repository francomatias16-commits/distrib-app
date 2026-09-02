---
slug: devoluciones-de-pedidos
categoria: logistica
roles: [dueno, admin, chofer, depositero]
---

# Devoluciones de pedidos (reparto)

Distinto de una devolución en el POS, esta es la devolución que se genera durante el reparto — por ejemplo, cuando el chofer trae de vuelta mercadería que el cliente rechazó o que estaba en mal estado.

## Cómo se registra

1. Se asocia la devolución al pedido y cliente correspondiente, y al chofer que la trae.
2. Se cargan los ítems devueltos con su cantidad.
3. Se indica el motivo (producto dañado, rechazo del cliente, error de pedido, etc.) y, opcionalmente, una foto como respaldo.
4. Queda con un estado que avanza a medida que se procesa (por ejemplo, pendiente de revisión → aceptada).

## Qué se actualiza

Una vez confirmada, el stock del depósito correspondiente se ajusta según los ítems devueltos. Si el motivo indica que el producto está en mal estado por responsabilidad del proveedor, se puede generar una nota de débito al proveedor (ver artículo de notas de crédito y débito).

## Preguntas frecuentes

**¿Toda devolución de reparto genera una nota de crédito al cliente automáticamente?**
No es automático — depende de si esa mercadería devuelta ya estaba facturada. Si corresponde, la nota de crédito se genera como un paso aparte.

**¿Quién puede registrar una devolución de reparto?**
Normalmente el chofer al momento de la entrega, aunque el admin también puede cargarla o corregirla después.
