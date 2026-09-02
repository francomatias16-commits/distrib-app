---
slug: pedidos-presupuestos-y-carrito
categoria: ventas
roles: [dueno, admin, vendedor, cliente]
---

# Pedidos, presupuestos y carrito

## Ciclo de vida de un pedido

Un pedido pasa por varios estados: **borrador** → **confirmado** → **preparando** → **despachado** → **entregado**. También puede quedar **cancelado**, **pendiente** o marcarse como **sugerido** cuando lo generó el sistema automáticamente (ver más abajo).

Al confirmar un pedido, se reserva el stock de los productos incluidos. Al despacharse, se genera el remito. Al entregarse, puede quedar registrada la firma digital, una foto y la ubicación de entrega.

## Carrito de compra

El cliente puede armar su pedido de a poco en un carrito antes de confirmarlo. Cada ítem del carrito guarda el precio vigente al momento de agregarlo (precio "congelado"), para que no cambie inesperadamente si el precio de lista se actualiza mientras el cliente todavía no confirmó el pedido.

## Presupuestos

Un presupuesto es una cotización previa al pedido: mismo formato de ítems y precios, pero sin comprometer stock. Tiene fecha de vencimiento. Si el cliente lo acepta, se puede convertir directamente en un pedido.

## Sugerencias de pedido y ciclos de compra

El sistema puede detectar patrones de recompra de cada cliente (por ejemplo, "este cliente compra este producto cada 15 días en promedio") y generar sugerencias automáticas de qué y cuándo pedir, con un puntaje de confianza sobre la sugerencia. Si el cliente confirma la sugerencia, se convierte en un pedido real.

## Preguntas frecuentes

**¿Qué diferencia hay entre un presupuesto y un pedido en borrador?**
El presupuesto es una cotización que no reserva stock ni compromete nada; el pedido en borrador ya es un pedido real en proceso de armado.

**¿Las sugerencias de pedido se generan solas?**
Sí, en base al historial de compra de cada cliente, sin necesidad de que alguien las cargue manualmente. El cliente o vendedor decide si las confirma o las descarta.

**¿El precio del carrito puede cambiar entre que lo agrego y confirmo el pedido?**
No, el precio queda fijado al momento de agregarlo al carrito.
