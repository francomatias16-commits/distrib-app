---
slug: gestion-de-clientes
categoria: clientes
roles: [dueno, admin, vendedor]
---

# Gestión de clientes

## Datos del cliente

Cada cliente tiene su información fiscal (razón social, CUIT, condición de IVA), de contacto, zona de reparto asignada, y puede tener **múltiples direcciones de entrega** además de la principal.

## Listas y precios especiales

- Cada cliente pertenece a una **lista de precios** (por ejemplo, minorista o mayorista).
- Además, se le puede asignar un **precio especial por producto** a un cliente puntual, que tiene prioridad sobre el precio de su lista.

## Ubicación

Los clientes pueden tener coordenadas geográficas cargadas, usadas para optimizar rutas de reparto y calcular distancias de entrega.

## Vendedor asignado

Un cliente puede tener un vendedor asignado por defecto, que queda preseleccionado al generar pedidos o presupuestos para ese cliente.

## Preguntas frecuentes

**¿Cómo se calcula el precio final que ve un cliente?**
Primero se busca si tiene un precio especial cargado para ese producto puntual. Si no lo tiene, se usa el precio de la lista de precios asignada a ese cliente.

**¿Un cliente puede tener más de una dirección de entrega?**
Sí, podés cargar varias y marcar cuál es la principal; cada pedido puede entregarse en la dirección que corresponda.

**¿Se puede desactivar un cliente sin borrarlo?**
Sí, marcándolo como inactivo se lo saca de circulación sin perder su historial.
