---
slug: rutas-y-entregas
categoria: logistica
roles: [dueno, admin, chofer, vendedor]
---

# Rutas y entregas

## Zonas de reparto

Cada empresa puede definir zonas geográficas con sus propios días de reparto asignados (por ejemplo, "Zona Norte" reparte lunes y jueves). Cada cliente pertenece a una zona.

## Armado de una ruta

1. Se crea una ruta para una fecha determinada y se le asigna un chofer.
2. Se agregan los pedidos que van a esa ruta, en el orden en que se van a entregar (paradas).
3. El chofer puede ver su posición actual reflejada en el sistema mientras recorre la ruta (ubicación en tiempo real).

## Confirmar una entrega

Al llegar a cada parada, el chofer confirma la entrega desde su dispositivo:
1. Marca el pedido como entregado (o no entregado, cargando el motivo).
2. Puede capturar una **firma digital** del receptor y una **foto** como comprobante.
3. Queda registrado quién recibió la mercadería, cuánto tardó la entrega y la distancia recorrida en esa parada.

## Si un pedido no se puede entregar

El chofer carga el motivo de no entrega (cliente ausente, dirección incorrecta, rechazo de mercadería, etc.). El pedido queda disponible para reprogramar en una próxima ruta.

## Preguntas frecuentes

**¿Se puede reordenar las paradas de una ruta ya creada?**
Sí, el orden de las paradas es editable mientras la ruta no esté finalizada.

**¿Qué pasa si el chofer pierde conexión durante el reparto?**
Puede seguir marcando entregas; la ubicación en tiempo real y la sincronización de las confirmaciones se actualizan apenas vuelve la conexión.

**¿Un pedido puede estar en dos rutas a la vez?**
No, cada pedido pertenece a una sola ruta activa por vez.
