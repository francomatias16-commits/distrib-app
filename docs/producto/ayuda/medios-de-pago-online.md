---
slug: medios-de-pago-online
categoria: cobranzas
roles: [dueno, admin, contador]
---

# Medios de pago online (integraciones)

El sistema soporta cobrar pedidos o facturas a través de pasarelas de pago online (por ejemplo, Mercado Pago).

## Configuración

El admin carga las credenciales de la pasarela (clave pública, clave de acceso, secreto de webhook) desde la configuración de integraciones de pago. Estas credenciales se guardan cifradas — nadie puede verlas en texto plano desde la interfaz, ni siquiera el equipo interno.

## Cómo funciona una transacción online

1. El cliente elige pagar online desde su pedido o factura.
2. Se genera una transacción de pago vinculada a ese pedido/factura, con un estado inicial (pendiente).
3. La pasarela de pago notifica al sistema (vía webhook) cuando el pago se aprueba, rechaza o queda pendiente de acreditación.
4. El estado de la transacción se actualiza automáticamente y, si fue aprobado, se refleja como cobro en la cuenta del cliente.

## Preguntas frecuentes

**¿Qué pasa si el webhook de la pasarela no llega?**
La transacción puede quedar en estado pendiente más tiempo del esperado. El admin puede revisar el estado directamente en el panel de la pasarela de pago para confirmar si se acreditó.

**¿Puedo tener más de una integración de pago activa?**
Depende de tu configuración — cada integración se identifica por proveedor, así que técnicamente se pueden tener varias, aunque lo más común es tener una activa por vez.

**¿Los datos de la tarjeta del cliente pasan por nuestro sistema?**
No. El cobro con tarjeta se procesa siempre del lado de la pasarela de pago (Mercado Pago u otra); nuestro sistema solo recibe la confirmación del resultado.
