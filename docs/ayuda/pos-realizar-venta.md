---
slug: pos-realizar-venta
categoria: pos
roles: [admin, cliente, proveedor]
---

# Cómo realizar una venta en el POS

Para vender necesitás tener un **turno de caja abierto** (ver artículo de apertura y cierre de caja).

## Pasos básicos

1. Buscá el producto por nombre, código o desde tus **favoritos** (productos marcados con etiqueta y color para encontrarlos rápido).
2. Ajustá la cantidad. El precio unitario se toma de la lista de precios vigente, salvo que el cliente tenga un precio especial cargado.
3. Si aplica una promoción activa sobre ese producto, el sistema la aplica automáticamente y queda registrada la descripción de la promoción en el ítem.
4. Podés aplicar un **descuento por ítem** (porcentaje) o un **descuento global** sobre toda la venta.
5. Elegí el cliente (opcional según tu operatoria — una venta puede quedar sin cliente asociado, como venta mostrador).

## Medios de pago

Una venta puede pagarse con **más de un medio de pago combinado** (por ejemplo, parte efectivo y parte tarjeta). Por cada medio usado se registra:
- El medio (efectivo, tarjeta, transferencia, etc.).
- El monto correspondiente a ese medio.
- Una referencia (por ejemplo, número de operación de la tarjeta), si corresponde.

La suma de todos los pagos debe coincidir con el total de la venta para poder confirmarla.

## Cierre de la venta

Al confirmar, la venta queda con estado registrado y puede generar automáticamente la factura correspondiente si tu configuración de facturación electrónica está activa (ver artículo de facturación).

## Preguntas frecuentes

**¿Puedo vender sin stock disponible?**
Depende de la configuración de tu empresa. Si el control de stock está activo, el sistema va a advertir o bloquear la venta de un producto sin stock suficiente en el depósito de esa caja.

**¿Se puede anular una venta ya confirmada?**
No se anula directamente; se hace a través de una **devolución** (ver artículo de devoluciones POS), que ajusta stock y montos correctamente.
