// lib/calc/iva-desglose.js
//
// Códigos de alícuota de IVA y cálculo del desglose por alícuota a partir
// de ítems reales de un pedido/venta. Compartido entre:
//   - lib/arca/wsfev1.js:        arma el bloque <Iva> que exige ARCA para
//                                 Factura A/B (cada <AlicIva> con Id/BaseImp/Importe).
//   - lib/arca/comprobante-pdf.js: necesita el mismo desglose para mostrar
//                                 el IVA correcto en el PDF cuando hay más
//                                 de una alícuota (antes tenía "IVA (21%)"
//                                 hardcodeado en el label).
//
// Se extrae a un módulo aparte para que ARCA y el PDF nunca puedan mostrar
// un desglose distinto del mismo comprobante — mismo patrón que
// lib/calc/pedido-totales.js para subtotal/iva_total de un pedido.
//
// IMPORTANTE: `subtotal` de cada ítem debe ser el neto por ítem (precio ×
// cantidad con descuento aplicado, SIN IVA) — así es como lo persisten
// pedido_items/venta_pos_items (ver lib/calc/pedido-totales.js).

/** Códigos de alícuota de IVA que expone ARCA vía FEParamGetTiposIva. */
export const ALICUOTA_IVA_ID = {
  '0':    3,
  '2.5':  9,
  '5':    8,
  '10.5': 4,
  '21':   5,
  '27':   6,
};

/** Redondea a 2 decimales con toFixed-seguro (evita errores de punto flotante). */
export function redondear2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Normaliza una alícuota (puede llegar como "21.00" numeric de Postgres,
 * 21, "10.5", etc.) a la key que usa ALICUOTA_IVA_ID ("21", "10.5"...).
 */
export function normalizarAlicuota(valor) {
  return String(Number(valor));
}

/**
 * Agrupa ítems por alícuota de IVA y calcula BaseImp/Importe por grupo,
 * más ImpNeto/ImpIVA totales.
 *
 * @param {Array<{subtotal: number, iva: number|string}>} items
 * @returns {{
 *   impNeto: number,
 *   impIVA: number,
 *   alicuotas: Array<{ id: number, alicuota: number, baseImp: number, importe: number }>
 * }}
 */
export function calcularDesgloseIva(items) {
  const grupos = new Map(); // alicuota normalizada → { id, alicuota, baseImp, importe }

  for (const item of items) {
    const alicuotaKey = normalizarAlicuota(item.iva);
    const id = ALICUOTA_IVA_ID[alicuotaKey];
    if (id === undefined) {
      throw new Error(
        `[iva-desglose] Alícuota de IVA "${item.iva}" no está mapeada en ALICUOTA_IVA_ID. ` +
        'No se puede facturar/mostrar Factura A/B con una tasa que ARCA no reconoce en este mapa.'
      );
    }

    const baseImp = redondear2(Number(item.subtotal));
    const importe = redondear2(baseImp * (Number(alicuotaKey) / 100));

    const acc = grupos.get(alicuotaKey) || { id, alicuota: Number(alicuotaKey), baseImp: 0, importe: 0 };
    acc.baseImp = redondear2(acc.baseImp + baseImp);
    acc.importe = redondear2(acc.importe + importe);
    grupos.set(alicuotaKey, acc);
  }

  const alicuotas = [...grupos.values()].sort((a, b) => a.alicuota - b.alicuota);
  const impNeto = redondear2(alicuotas.reduce((s, a) => s + a.baseImp, 0));
  const impIVA  = redondear2(alicuotas.reduce((s, a) => s + a.importe, 0));

  return { impNeto, impIVA, alicuotas };
}
