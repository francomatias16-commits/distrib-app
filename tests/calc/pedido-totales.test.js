// tests/calc/pedido-totales.test.js
//
// Plan 3.2, punto 1: "funciones de cálculo de dinero ... son las que ya
// causaron bugs reales (CONS-01/02/03 de la auditoría anterior)".
// calcularTotalesPedido es el cálculo de subtotal/IVA/total que se usa
// tanto en el flujo de pedido del portal cliente como en el del admin.

import { describe, it, expect } from 'vitest';
import { calcularTotalesPedido } from '../../lib/calc/pedido-totales.js';

describe('calcularTotalesPedido', () => {
  it('calcula subtotal, IVA y total de un item simple sin descuento', () => {
    const items = [{ producto_id: 'p1', cantidad: 2 }];
    const r = calcularTotalesPedido(items, {
      resolverPrecio: () => 100,
      ivaMap: { p1: 21 },
    });

    expect(r.subtotal).toBe(200);
    expect(r.iva_total).toBeCloseTo(42, 5);
    expect(r.total).toBe(242);
    expect(r.itemsParaRpc).toEqual([
      { producto_id: 'p1', combo_id: null, cantidad: 2, precio_unitario: 100, descuento_pct: 0, subtotal: 200 },
    ]);
  });

  it('aplica el descuento por item antes de calcular el IVA', () => {
    const items = [{ producto_id: 'p1', cantidad: 1, descuento_pct: 50 }];
    const r = calcularTotalesPedido(items, {
      resolverPrecio: () => 200,
      ivaMap: { p1: 21 },
    });

    // 200 * (1 - 0.5) = 100 de subtotal; IVA sobre el subtotal con descuento, no sobre el precio de lista.
    expect(r.subtotal).toBe(100);
    expect(r.iva_total).toBeCloseTo(21, 5);
    expect(r.total).toBe(121);
  });

  it('usa 21% por defecto cuando el producto no tiene IVA cargado en el mapa', () => {
    const items = [{ producto_id: 'sin-iva', cantidad: 1 }];
    const r = calcularTotalesPedido(items, {
      resolverPrecio: () => 100,
      ivaMap: {},
    });

    expect(r.iva_total).toBeCloseTo(21, 5);
  });

  it('suma correctamente varios items con IVA distinto cada uno', () => {
    const items = [
      { producto_id: 'p1', cantidad: 1 },
      { producto_id: 'p2', cantidad: 3 },
    ];
    const precios = { p1: 100, p2: 50 };
    const r = calcularTotalesPedido(items, {
      resolverPrecio: item => precios[item.producto_id],
      ivaMap: { p1: 21, p2: 10.5 },
    });

    // p1: 100 sub + 21 iva | p2: 150 sub + 15.75 iva
    expect(r.subtotal).toBe(250);
    expect(r.iva_total).toBeCloseTo(36.75, 5);
    expect(r.total).toBe(286.75);
  });

  it('redondea el total a 2 decimales incluso con arrastre de coma flotante', () => {
    const items = [{ producto_id: 'p1', cantidad: 3, descuento_pct: 15 }];
    const r = calcularTotalesPedido(items, {
      resolverPrecio: () => 33.33,
      ivaMap: { p1: 21 },
    });

    // Verifica que el total tenga como máximo 2 decimales (nada de 121.00000000000001).
    expect(Number.isInteger(r.total * 100)).toBe(true);
  });

  it('un descuento del 100% deja el item en subtotal 0 sin romper el cálculo', () => {
    const items = [{ producto_id: 'p1', cantidad: 5, descuento_pct: 100 }];
    const r = calcularTotalesPedido(items, {
      resolverPrecio: () => 999,
      ivaMap: { p1: 21 },
    });

    expect(r.subtotal).toBe(0);
    expect(r.iva_total).toBe(0);
    expect(r.total).toBe(0);
  });

  it('respeta el precio que devuelve resolverPrecio aunque el item traiga otro precio_unitario', () => {
    // Refleja el caso real: nunca hay que confiar en el precio que manda el cliente/frontend.
    const items = [{ producto_id: 'p1', cantidad: 1, precio_unitario: 1 }];
    const r = calcularTotalesPedido(items, {
      resolverPrecio: () => 500, // precio resuelto server-side, ignora el del item
      ivaMap: { p1: 21 },
    });

    expect(r.itemsParaRpc[0].precio_unitario).toBe(500);
    expect(r.subtotal).toBe(500);
  });
});
