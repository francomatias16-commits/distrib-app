---
slug: pos-devoluciones
categoria: pos
roles: [admin, cliente, proveedor]
---

# Cómo hacer una devolución en el POS

Las devoluciones se hacen sobre una venta POS ya confirmada, no directamente sobre el stock.

## Pasos

1. Buscá la venta original (por número o por cliente).
2. Seleccioná qué ítems se devuelven y en qué cantidad — una devolución puede ser **parcial** (no hace falta devolver toda la venta).
3. Indicá el motivo de la devolución.
4. Confirmá. El sistema calcula el monto total a devolver según los ítems y cantidades elegidos.

## Qué actualiza el sistema automáticamente

- El stock del producto devuelto vuelve a sumarse al depósito correspondiente.
- Queda un registro histórico de la devolución, vinculado a la venta original y al usuario que la procesó.

## Preguntas frecuentes

**¿Se puede devolver un ítem que ya fue devuelto antes?**
No debería duplicarse — cada devolución queda asociada al ítem específico de la venta, así que el sistema lleva el control de cuánto de ese ítem ya fue devuelto.

**¿La devolución afecta la factura ya emitida?**
La devolución en sí no modifica la factura original. Si necesitás un comprobante fiscal por la devolución, se maneja con una nota de crédito (ver artículo de notas de crédito).
