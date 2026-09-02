---
slug: portal-de-proveedores
categoria: compras
roles: [dueno, admin, proveedor]
---

# Portal de autogestión de proveedores

Los proveedores pueden tener acceso a un portal propio, sin necesidad de un usuario completo del sistema, mediante un link con token de acceso.

## Cómo se genera el acceso

El admin genera un link de acceso para el proveedor. Ese link tiene una fecha de expiración y puede revocarse en cualquier momento. Por seguridad, el token real solo se muestra una vez al generarlo — el sistema guarda internamente una versión encriptada, no el token original.

## Qué puede hacer un proveedor desde el portal

- Ver sus órdenes de compra pendientes.
- Confirmar la fecha de entrega esperada de una orden.
- Cargar sus propias facturas (quedan pendientes de aprobación del admin).

## Preguntas frecuentes

**¿Qué pasa si el link del proveedor se filtra o se pierde?**
El admin puede revocarlo en cualquier momento y generar uno nuevo.

**¿El proveedor ve información de otros proveedores o de la empresa en general?**
No, el acceso del portal está limitado únicamente a los datos de ese proveedor puntual.

**¿El link vence solo?**
Sí, tiene una fecha de expiración configurada al generarlo.
