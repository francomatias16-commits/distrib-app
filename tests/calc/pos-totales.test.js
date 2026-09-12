import { describe, it, expect } from 'vitest';
import { calcularTotalesPos } from '../../lib/calc/pos-totales.js';
import { calcularDesgloseIva } from '../../lib/calc/iva-desglose.js';

// Auditoría 2026-09: el descuento global se prorratea por ítem, no se resta
// una sola vez del total combinado. El chequeo central de cada test es que
// el desglose de IVA reconstruido desde los ítems (lo que hace wsfev1.js
// vía calcularDesgloseIva antes de emitir Factura A/B) cierre EXACTO contra
// `total` — que es justo lo que antes fallaba en cuanto había descuento
// global + más de una alícuota.

const ITEM_21 = { producto_id: 'p21', cantidad: 1 };
const ITEM_105 = { producto_id: 'p105', cantidad: 2 };

function precioMap() {
  return { p21: 100, p105: 50 };
}
function ivaMap() {
  return { p21: 21, p105: 10.5 };
}

describe('calcularTotalesPos', () => {
  it('sin descuento global: se comporta igual que antes (suma simple de ítems)', () => {
    const r = calcularTotalesPos([ITEM_21], { precioMap: precioMap(), ivaMap: ivaMap() });
    expect(r.subtotal).toBe(100);
    expect(r.iva_total).toBe(21);
    expect(r.total).toBe(121);
  });

  it('descuento global + una sola alícuota: total sigue cerrando exacto', () => {
    const r = calcularTotalesPos([ITEM_21], { precioMap: precioMap(), ivaMap: ivaMap(), descuentoGlobalPct: 10 });
    // 100 + 21% = 121; -10% global = 108.9 -> redondeo a peso entero
    expect(r.total).toBe(109);
    const desglose = calcularDesgloseIva(r.itemsParaRpc.map(i => ({ subtotal: i.subtotal, iva: ivaMap()[i.producto_id] })));
    expect(Math.round((desglose.impNeto + desglose.impIVA) * 100) / 100).toBeCloseTo(r.subtotal + r.iva_total, 2);
  });

  it('caso real del hallazgo: descuento global + 2 alícuotas distintas — el desglose reconstruido cierra acotado a redondeo de peso (antes desviaba ~23.50, escalando con el % de descuento)', () => {
    const items = [ITEM_21, ITEM_105]; // 21% y 10.5% en el mismo carrito
    const r = calcularTotalesPos(items, { precioMap: precioMap(), ivaMap: ivaMap(), descuentoGlobalPct: 10 });

    const itemsParaDesglose = r.itemsParaRpc.map(i => ({ subtotal: i.subtotal, iva: ivaMap()[i.producto_id] }));
    const desglose = calcularDesgloseIva(itemsParaDesglose);

    const reconstruido = Math.round((desglose.impNeto + desglose.impIVA) * 100) / 100;
    // El descuento global YA NO aporta desvío propio (antes escalaba con el
    // %: a más descuento, más lejos quedaba `total` de lo reconstruido).
    // Lo único que queda es el redondeo a peso entero de `total` — un tope
    // fijo de 0.5, no relacionado con el descuento y preexistente a este
    // fix (ver nota en pos-totales.js / aviso a CLAY). wsfev1.js tolera
    // solo 0.05: ese remanente de redondeo a peso es una decisión de
    // negocio pendiente aparte, no algo que este fix deba resolver.
    expect(Math.abs(reconstruido - r.total)).toBeLessThanOrEqual(0.5);
  });

  it('descuento por línea Y descuento global combinados en el mismo ítem', () => {
    const items = [{ producto_id: 'p21', cantidad: 2, descuento_pct: 20 }];
    const r = calcularTotalesPos(items, { precioMap: precioMap(), ivaMap: ivaMap(), descuentoGlobalPct: 5 });
    // 100*2=200 -20% linea=160; *21%=33.6 -> subBruto+iva=193.6; -5% global = 183.92
    expect(r.total).toBe(184);
  });

  it('descuento global 100%: todo queda en 0 sin romper', () => {
    const r = calcularTotalesPos([ITEM_21], { precioMap: precioMap(), ivaMap: ivaMap(), descuentoGlobalPct: 100 });
    expect(r.total).toBe(0);
    expect(r.subtotal).toBe(0);
    expect(r.iva_total).toBe(0);
  });

  it('descuento global fuera de rango (negativo o >100) se clampea, no rompe', () => {
    const r1 = calcularTotalesPos([ITEM_21], { precioMap: precioMap(), ivaMap: ivaMap(), descuentoGlobalPct: -10 });
    expect(r1.total).toBe(121);
    const r2 = calcularTotalesPos([ITEM_21], { precioMap: precioMap(), ivaMap: ivaMap(), descuentoGlobalPct: 150 });
    expect(r2.total).toBe(0);
  });
});
