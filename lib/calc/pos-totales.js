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
// LIMITE CONOCIDO, no resuelto por este fix (ver tests/calc/pos-totales.test.js):
// `total` se redondea a peso entero (sin centavos, ver comentario en
// `total` más abajo) porque hoy no circulan fracciones de peso en
// efectivo. Ese redondeo puede desviar `total` hasta $0.50 de la suma
// exacta de `subtotal+iva_total` de los ítems — independiente del
// descuento global, preexistente a este fix, y suficiente por sí solo
// para violar la tolerancia de 0.05 que exige wsfev1.js al reconstruir el
// desglose de IVA para Factura A/B. Antes de este fix el descuento global
// sumaba un desvío propio que escalaba con el % (hasta $23+ en el caso
// real detectado); ese desvío queda en cero acá. El remanente de
// redondeo a peso entero es una decisión de negocio aparte pendiente para
// CLAY: si una venta se va a facturar A/B, ¿el total debería llevar
// centavos igual que la factura, o hay que reconciliar la diferencia de
// otra forma (ej. ajustar el último ítem, o tolerar el redondeo también
// del lado de facturación)?

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

  // Redondeo a peso entero: igual que antes, no circulan fracciones de
  // peso. Ahora total = subtotal + iva_total directamente (ya con el
  // global prorrateado adentro), no total_sin_desc - descGlobalMonto.
  const total = Math.round(subtotal + iva_total);

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    iva_total: Math.round(iva_total * 100) / 100,
    total,
    itemsParaRpc,
  };
}
