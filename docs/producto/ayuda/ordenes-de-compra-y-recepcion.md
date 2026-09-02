---
slug: ordenes-de-compra-y-recepcion
categoria: compras
roles: [dueno, admin, depositero]
---

# Órdenes de compra y recepción de mercadería

## Crear una orden de compra

1. Elegí el proveedor.
2. Agregá los productos, cantidades y precios de costo esperados.
3. Confirmá la orden — queda con un número y estado, a la espera de recepción.

El sistema también puede **generar órdenes de compra automáticamente** cuando detecta que un producto se está por quedar sin stock, en base a la velocidad de venta histórica. Estas órdenes quedan marcadas como auto-generadas para diferenciarlas de las manuales.

## Recepción de mercadería

Cuando llega el pedido del proveedor:
1. Se registra la recepción asociada a la orden de compra.
2. Se puede adjuntar una foto del remito/factura del proveedor. El sistema puede leer los datos automáticamente de esa foto (OCR) para agilizar la carga.
3. Se concilian los ítems recibidos contra lo que decía la orden de compra original.
4. Si hay diferencias (cantidad recibida distinta a la pedida, precio distinto, etc.), quedan marcadas como discrepancias para que el admin las revise antes de confirmar.
5. Al confirmar, el stock se actualiza automáticamente con un movimiento de tipo entrada por compra.

## Confirmación del proveedor (portal de autogestión)

Si tu proveedor tiene acceso al portal de autogestión, puede confirmar la fecha de entrega esperada de una orden de compra directamente, sin que vos tengas que hacer ese seguimiento manual (ver artículo del portal de proveedores).

## Preguntas frecuentes

**¿Qué hago si el proveedor entregó menos cantidad de la pedida?**
Se registra la cantidad realmente recibida en la recepción — el sistema muestra la diferencia como discrepancia, y el stock solo se actualiza con lo efectivamente recibido.

**¿Se puede recibir una orden de compra en varias partes?**
Sí, una orden de compra puede recibirse de forma parcial en distintas recepciones hasta completarse.
