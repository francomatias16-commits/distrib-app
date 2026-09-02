---
slug: productos-categorias-y-promociones
categoria: catalogo
roles: [dueno, admin, vendedor]
---

# Productos, categorías y promociones

## Productos

Cada producto tiene código, nombre, unidad de medida, costo, precio base e IVA. Además se puede configurar:
- Si se vende por peso (en vez de por unidad).
- Si tiene código de barras.
- Stock mínimo y stock objetivo, usados para generar alertas y órdenes de compra automáticas.
- Un proveedor por defecto, usado para agrupar compras automáticas y para saber a quién reclamarle en caso de un producto defectuoso.
- Si permite venderse con stock negativo.

## Categorías

Los productos se agrupan en categorías definidas por cada empresa, con un orden de visualización configurable, útil para organizar el catálogo y el menú del POS.

## Promociones

Se pueden configurar promociones del tipo "llevá N, pagá M" o descuento por porcentaje, aplicadas a un producto puntual o a toda una categoría, con vigencia entre dos fechas. Mientras la promoción está activa y dentro de su vigencia, se aplica automáticamente al vender ese producto (tanto en pedidos como en el POS).

## Preguntas frecuentes

**¿Puedo tener dos promociones activas sobre el mismo producto?**
No es recomendable, ya que puede generar ambigüedad sobre cuál se aplica. Lo ideal es que cada producto tenga una sola promoción vigente por vez.

**¿Qué pasa cuando vence una promoción?**
Deja de aplicarse automáticamente a partir de la fecha de fin configurada, sin necesidad de desactivarla a mano.
