---
slug: stock-y-depositos
categoria: stock
roles: [dueno, admin, depositero]
---

# Stock y depósitos

## Depósitos

Una empresa puede tener uno o varios depósitos (por ejemplo, depósito principal y un depósito secundario). El stock se maneja siempre por depósito — el mismo producto puede tener cantidades distintas en cada uno.

## Cómo se compone el stock de un producto

Para cada producto y depósito, el sistema distingue:
- **Cantidad total**: lo que físicamente hay en el depósito.
- **Cantidad reservada**: la parte de ese stock ya comprometida en pedidos confirmados pero todavía no despachados.
- **Cantidad disponible**: lo que realmente se puede seguir vendiendo (total menos reservado).

## Movimientos de stock

Todo cambio de stock queda registrado como un movimiento, con su tipo:
- **ingreso**: entrada de mercadería (por ejemplo, por una compra).
- **egreso**: salida (por ejemplo, por una venta o despacho).
- **reserva** / **liberación**: cuando un pedido reserva stock, o lo libera si se cancela.
- **ajuste**: correcciones manuales (por ejemplo, tras un conteo físico que no coincide).
- **transferencia**: movimiento de un depósito a otro.
- **entrada_compra**: ingreso específico proveniente de una orden de compra recibida.

Cada movimiento queda con el usuario que lo hizo y una referencia a qué operación lo originó, para poder rastrear cualquier diferencia de stock.

## Preguntas frecuentes

**¿Por qué la cantidad disponible es menor a la cantidad total?**
Porque hay pedidos confirmados que ya reservaron parte de ese stock, aunque todavía no se despacharon.

**¿Se puede vender con stock negativo?**
Depende de la configuración de cada producto — algunos productos pueden estar habilitados para permitir stock negativo (por ejemplo, productos de reposición constante), y otros no.

**¿Cómo corrijo un stock que no coincide con lo que hay físicamente?**
Con un movimiento de tipo ajuste, indicando la diferencia y, si corresponde, el motivo.
