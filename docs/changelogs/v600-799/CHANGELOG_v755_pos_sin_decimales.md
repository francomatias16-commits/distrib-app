# v755 — POS: eliminación de decimales/centavos en caja

## Motivo
El billete/moneda más chico en circulación hoy es de $10 — arrastrar
centavos en totales, vueltos y arqueo de caja ya no tiene sentido y
generaba diferencias artificiales (ej. la tolerancia de $1 del cobro
por Enter, resuelta en v754, era en parte un parche para esto).

## Cambios

**Frontend (`pos.js`, `pos.html`)**
- `calcularTotales()` y `calcularTotalesDe()`: el total de la venta ahora
  se redondea a peso entero (`Math.round(x)`), no a centavos.
- Se eliminó `TOLERANCIA_REDONDEO_PAGO` ($1): con totales enteros ya no
  hace falta tolerar diferencias de centavos. La validación de cobro y
  el color de "diferencia" en el modal ahora comparan montos exactos.
- Vuelto (modal de cobro y ticket) redondeado a peso entero.
- El "estado de caja" (previo a registrar sangría/retiro/refuerzo) dejó
  de forzar 2 decimales fijos; ahora sigue el mismo formato sin
  centavos que el resto del POS.
- Input de monto en movimientos de caja: `min="0.01"` → `min="1"`
  (resabio de cuando se permitían centavos).

**Backend (`lib/handlers/pos.js`)**
- El total recalculado server-side (fuente de verdad que se guarda en
  la venta) ahora redondea a peso entero, igual que el frontend, para
  que no haya diferencia entre lo que se cobra en el POS y lo que
  queda registrado.
- `total_ventas` y `efectivo_esperado` del reporte Z / arqueo de caja
  también redondeados a peso entero.
- Subtotal e IVA por ítem se mantienen con 2 decimales de precisión
  interna (necesario para la facturación ARCA), solo el total final
  que se cobra se redondea.
