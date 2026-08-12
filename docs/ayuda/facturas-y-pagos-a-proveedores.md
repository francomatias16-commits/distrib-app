---
slug: facturas-y-pagos-a-proveedores
categoria: compras
roles: [dueno, admin, contador]
---

# Facturas y pagos a proveedores

## Carga de facturas de proveedor

Una factura de proveedor puede cargarse de dos formas:
- **Manual**, por el equipo interno (admin).
- **Autocargada** por el proveedor desde su portal de autogestión — en ese caso queda con origen "proveedor" y estado pendiente hasta que el admin la revise y apruebe.

Cada factura se puede conciliar contra la orden de compra correspondiente, y el sistema marca discrepancias si los montos o cantidades no coinciden.

## Registrar un pago a proveedor

1. Elegí la factura de proveedor a pagar (total o parcialmente).
2. Cargá el medio de pago, monto y fecha.
3. El sistema actualiza el total pagado de la factura y su estado.

## Reglas de liquidación (pagos escalonados)

Podés configurar reglas para avisos automáticos según cuántos días falten para el vencimiento de una factura de proveedor, con distintos niveles de urgencia y porcentajes asociados a cada nivel — útil para priorizar qué pagar primero cuando hay varias facturas pendientes.

## Preguntas frecuentes

**¿Qué pasa si una factura autocargada por el proveedor tiene un error?**
Queda en estado pendiente hasta que el admin la revise; se puede corregir o rechazar antes de aprobarla.

**¿Se puede pagar una factura en varias cuotas?**
Sí, podés registrar varios pagos parciales contra la misma factura hasta cubrir el total.
