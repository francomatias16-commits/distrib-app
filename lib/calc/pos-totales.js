// lib/calc/pos-totales.js
//
// Auditoría 2026-09 (continuación Etapa 2/3): cálculo de subtotal, IVA y
// total de una venta de mostrador a partir de sus ítems, con el descuento
// global (`descuento_global_pct`) prorrateado proporcionalmente en cada
// línea — no restado una sola vez al final del total combinado.
//
// Por qué importa: `venta_pos_id` puede facturarse (Factura A/B) vía
// emitirFactura() → wsfev1.js, que reconstruye el desglose de IVA por
// alícuota leyendo `venta_pos_items.subtotal` (ver calcularDesgloseIva en
// iva-desglose.js) y lo valida contra `facturas.total`. Antes de este fix,
// el descuento global se aplicaba solo al total ya sumado, así que
// `sum(item.subtotal) + sum(item.iva)` (reconstruido desde los ítems)
// nunca coincidía con `factura.total` en cuanto `descuento_global_pct > 0`
// — wsfev1.js corta la emisión con "El desglose de IVA reconstruido... no
// coincide con facturas.total". Esto se disparaba, entre otros casos, en
// toda venta con pago a cuenta corriente (facturación automática
// inmediata, ver pos.js) que además tuviera descuento global.
//
// Extraída como función pura (mismo patrón que pedido-totales.js) para
// poder testearla sin mockear Supabase ni Express.
//
// Decisión 2.2 (DECISIONES_OPERATIVAS_2026-09.md, confirmada por CLAY):
// el peso entero se mantiene en caja/vuelto/arqueo (v755 sigue vigente ahí
// sin tocar nada — ver frontend/admin/js/pos/carrito.js y
// ticket-facturacion.js, y el Reporte Z, que ya sumaba
// venta_pos_pagos.monto en vez de ventas_pos.total). Lo que se resuelve
// ACÁ es exclusivamente el total que se persiste en `ventas_pos.total` y
// que después usa wsfev1.js para facturar: ya NO se redondea a peso
// entero, solo a centavos (mismo patrón que pedido-totales.js). Así
// `total` es SIEMPRE exactamente `subtotal + iva_total`, y el desglose de
// IVA reconstruido por calcularDesgloseIva() cierra exacto contra
// `facturas.total` sin necesidad de tocar la tolerancia de 0.05 de
// wsfev1.js — el problema se elimina de raíz en vez de tolerarse.
//
// Consecuencia aceptada: los pagos que llegan desde el POS (armados por el
// cajero contra el total en pesos enteros que muestra la pantalla) van a
// diferir del `total` con centavos que persiste este cálculo — hasta
// $0.99, el mismo margen que ya contemplaba `registrar_venta_pos` (ver
// migración 496_fix_registrar_venta_pos_vuelto_efectivo.sql, tolerancia de
// ±1) para el vuelto en efectivo. Ver el ajuste correspondiente en
// lib/handlers/pos.js (el chequeo `sumaPagos`/`sumaNoEfectivo` a nivel
// Node tenía una tolerancia de 0.01, más estricta que la del RPC, y
// hubiera rechazado ventas válidas si no se alineaba con esa misma
// tolerancia).

/**
 * @param {Array<{producto_id: string, cantidad: number, descuento_pct?: number, promocion_id?: string, promocion_descripcion?: string}>} items
 * @param {{ precioMap: Record<string, number>, ivaMap: Record<string, number>, descuentoGlobalPct?: number }} opciones
 *   `precioMap` y `ivaMap` resuelven precio_unitario e IVA por producto_id.
 * @returns {{ subtotal: number, iva_total: number, total: number, itemsParaRpc: Array }}
 */
export function calcularTotalesPos(items, { precioMap, ivaMap, descuentoGlobalPct = 0 }) {
  const descGlobalPct = Math.max(0, Math.min(100, parseFloat(descuentoGlobalPct) || 0));
  const factorGlobal = 1 - descGlobalPct / 100;

  let subtotal = 0;
  let iva_total = 0;

  const itemsParaRpc = items.map(item => {
    const precioUnitario = precioMap[item.producto_id];
    const ivaPct = ivaMap[item.producto_id] ?? 21;
    const descuentoPct = Math.max(0, Math.min(100, parseFloat(item.descuento_pct) || 0));

    // Descuento por línea primero, descuento global prorrateado después —
    // mismo orden que ya usaba pos.js, solo que ahora el global entra acá
    // en vez de descontarse una sola vez del total combinado.
    const subBruto = precioUnitario * item.cantidad * (1 - descuentoPct / 100);
    const sub = subBruto * factorGlobal;
    const iva = sub * (ivaPct / 100);

    subtotal += sub;
    iva_total += iva;

    return {
      producto_id: item.producto_id,
      cantidad: item.cantidad,
      precio_unitario: precioUnitario,
      descuento_pct: descuentoPct,
      subtotal: Math.round(sub * 100) / 100,
      promocion_id: item.promocion_id || null,
      promocion_descripcion: item.promocion_descripcion || null,
    };
  });

  // Decisión 2.2: total = subtotal + iva_total, redondeado solo a
  // centavos — NO a peso entero. El peso entero sigue vigente en
  // caja/vuelto/arqueo (capa frontend/Reporte Z), pero el total que se
  // persiste y se factura debe cerrar exacto contra subtotal+iva_total.
  const total = Math.round((subtotal + iva_total) * 100) / 100;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    iva_total: Math.round(iva_total * 100) / 100,
    total,
    itemsParaRpc,
  };
}
