---
slug: lotes-vencimientos-y-liquidacion
categoria: stock
roles: [dueno, admin, depositero]
---

# Lotes, vencimientos y ofertas de liquidación

## Lotes

Para productos que se manejan por lote (con fecha de fabricación y/o vencimiento), el sistema permite cargar cada lote por separado, con su propia cantidad, costo unitario y fechas. Esto permite saber exactamente qué lote se está vendiendo primero y cuál está por vencer.

## Alertas de stock

El sistema genera alertas automáticas cuando detecta situaciones que requieren atención, por ejemplo productos con pocos días restantes antes de agotarse o de vencer. Cada alerta puede marcarse como resuelta una vez atendida.

## Ofertas de liquidación automáticas

Cuando un lote se acerca a su fecha de vencimiento, el sistema puede generar automáticamente una oferta de liquidación:
1. Calcula un precio de oferta con un descuento sobre el precio normal.
2. La oferta queda activa por los días restantes hasta el vencimiento.
3. Se puede notificar automáticamente a clientes o mostrarse destacada en el catálogo.
4. Si el lote se vende o vence sin liquidarse, la oferta se desactiva automáticamente, quedando registrado el motivo.

## Preguntas frecuentes

**¿Qué pasa si un producto tiene varios lotes con distinta fecha de vencimiento?**
El sistema puede generar una oferta de liquidación por cada lote próximo a vencer de forma independiente.

**¿Las ofertas de liquidación se aplican solas en el POS o en pedidos?**
Sí, si la oferta está activa, el precio con descuento se aplica automáticamente al vender ese producto, hasta que se desactive.
