// tests/calc/iva-desglose.test.js
//
// Etapa 2 del plan de auditoría de integridad financiera — gap detectado el
// 12/9: iva-desglose.js no tenía ningún test, a diferencia de
// pedido-totales.js (son módulos independientes, uno no importa al otro).
// No es un módulo cosmético: alimenta el bloque <Iva> que se le manda a
// ARCA para Factura A/B (lib/arca/wsfev1.js) y el desglose que se muestra
// en el PDF del comprobante (lib/arca/comprobante-pdf.js). Un bug acá puede
// traducirse en un comprobante fiscal mal armado o rechazado por ARCA, o en
// wsfev1.js cortando la emisión por el chequeo de consistencia
// (|impNeto+impIVA - facturas.total| > 0.05) con un desglose que en
// realidad estaba bien pero mal calculado por otro motivo — hay que poder
// confiar en esta pieza a ciegas.

import { describe, it, expect } from 'vitest';
import {
  ALICUOTA_IVA_ID,
  redondear2,
  normalizarAlicuota,
  calcularDesgloseIva,
} from '../../lib/calc/iva-desglose.js';

describe('redondear2', () => {
  it('redondea a 2 decimales', () => {
    expect(redondear2(10.005)).toBeCloseTo(10.01, 2);
    expect(redondear2(10.004)).toBe(10);
    expect(redondear2(1 / 3)).toBe(0.33);
  });

  it('no introduce error de punto flotante en sumas típicas de plata', () => {
    // 0.1 + 0.2 = 0.30000000000000004 en JS puro — este es exactamente el
    // tipo de caso que redondear2 tiene que neutralizar.
    expect(redondear2(0.1 + 0.2)).toBe(0.3);
  });

  it('deja enteros y negativos sin alterar (uso defensivo, no se esperan negativos en producción)', () => {
    expect(redondear2(100)).toBe(100);
    expect(redondear2(-5.005)).toBeCloseTo(-5, 2);
  });
});

describe('normalizarAlicuota', () => {
  it('normaliza un numeric de Postgres tipo "21.00" a "21"', () => {
    expect(normalizarAlicuota('21.00')).toBe('21');
  });

  it('normaliza "10.50" a "10.5" (mismo formato que la key de ALICUOTA_IVA_ID)', () => {
    expect(normalizarAlicuota('10.50')).toBe('10.5');
  });

  it('acepta un number directo', () => {
    expect(normalizarAlicuota(21)).toBe('21');
    expect(normalizarAlicuota(0)).toBe('0');
  });

  it('acepta un string ya limpio', () => {
    expect(normalizarAlicuota('2.5')).toBe('2.5');
  });
});

describe('ALICUOTA_IVA_ID (mapa de códigos que expone ARCA vía FEParamGetTiposIva)', () => {
  it('mapea las 6 alícuotas vigentes a sus IDs correctos', () => {
    expect(ALICUOTA_IVA_ID).toEqual({
      '0': 3,
      '2.5': 9,
      '5': 8,
      '10.5': 4,
      '21': 5,
      '27': 6,
    });
  });
});

describe('calcularDesgloseIva', () => {
  it('un solo ítem a 21%: baseImp/importe/impNeto/impIVA calculados y el id correcto de ARCA', () => {
    const r = calcularDesgloseIva([{ subtotal: 100, iva: 21 }]);

    expect(r.impNeto).toBe(100);
    expect(r.impIVA).toBeCloseTo(21, 5);
    expect(r.alicuotas).toEqual([
      { id: 5, alicuota: 21, baseImp: 100, importe: 21 },
    ]);
  });

  it('agrupa y suma varios ítems de la MISMA alícuota en un solo grupo', () => {
    const items = [
      { subtotal: 100, iva: 21 },
      { subtotal: 50, iva: 21 },
      { subtotal: 25, iva: 21 },
    ];
    const r = calcularDesgloseIva(items);

    expect(r.alicuotas).toHaveLength(1);
    expect(r.alicuotas[0]).toEqual({ id: 5, alicuota: 21, baseImp: 175, importe: 36.75 });
    expect(r.impNeto).toBe(175);
    expect(r.impIVA).toBeCloseTo(36.75, 5);
  });

  it('separa ítems de DISTINTA alícuota en grupos distintos, ordenados ascendente por alícuota', () => {
    // A propósito en orden desordenado/decreciente en el input, para
    // verificar que el resultado se ordena por alícuota y no por orden de
    // aparición — así es como wsfev1.js arma el array <Iva><AlicIva> que
    // ARCA espera, y un orden inconsistente entre corridas sería un red
    // flag de por sí aunque cada número esté bien.
    const items = [
      { subtotal: 100, iva: 27 },
      { subtotal: 200, iva: 10.5 },
      { subtotal: 50, iva: 21 },
    ];
    const r = calcularDesgloseIva(items);

    expect(r.alicuotas.map(a => a.alicuota)).toEqual([10.5, 21, 27]);
    expect(r.alicuotas).toEqual([
      { id: 4, alicuota: 10.5, baseImp: 200, importe: 21 },
      { id: 5, alicuota: 21, baseImp: 50, importe: 10.5 },
      { id: 6, alicuota: 27, baseImp: 100, importe: 27 },
    ]);
    expect(r.impNeto).toBe(350);
    expect(r.impIVA).toBeCloseTo(58.5, 5);
  });

  it('alícuota 0% (exento/no gravado): queda en el desglose con importe 0, no se descarta', () => {
    const r = calcularDesgloseIva([{ subtotal: 500, iva: 0 }]);

    expect(r.alicuotas).toEqual([{ id: 3, alicuota: 0, baseImp: 500, importe: 0 }]);
    expect(r.impNeto).toBe(500);
    expect(r.impIVA).toBe(0);
  });

  it('acepta la alícuota como numeric de Postgres en formato string ("21.00", "10.50") igual que como number', () => {
    const items = [
      { subtotal: 100, iva: '21.00' },
      { subtotal: 100, iva: '10.50' },
    ];
    const r = calcularDesgloseIva(items);

    expect(r.alicuotas.map(a => a.alicuota)).toEqual([10.5, 21]);
    expect(r.alicuotas.find(a => a.alicuota === 21).importe).toBeCloseTo(21, 5);
    expect(r.alicuotas.find(a => a.alicuota === 10.5).importe).toBeCloseTo(10.5, 5);
  });

  it('rechaza una alícuota que ARCA no reconoce, con un mensaje explícito (no puede facturarse silenciosamente mal)', () => {
    expect(() => calcularDesgloseIva([{ subtotal: 100, iva: 15 }])).toThrow(
      /Alícuota de IVA "15" no está mapeada/
    );
  });

  it('lista vacía de ítems: neto/iva en 0, sin alícuotas — caso de borde que no debería explotar', () => {
    const r = calcularDesgloseIva([]);

    expect(r).toEqual({ impNeto: 0, impIVA: 0, alicuotas: [] });
  });

  it('no arrastra error de punto flotante al sumar muchos ítems de centavos (caso realista de un pedido grande)', () => {
    // 37 ítems de $10,10 c/u a 21% — un caso típico de acumulación de
    // redondeo si cada `+=` no pasara por redondear2 en cada paso.
    // La función redondea el importe de CADA ítem antes de acumular
    // (redondear2(10.1 * 0.21) = 2.12), así que el total esperado es
    // 37 * 2.12 = 78.44, no 37 * 10.1 * 0.21 = 78.477 sin redondeo intermedio.
    const items = Array.from({ length: 37 }, () => ({ subtotal: 10.1, iva: 21 }));
    const r = calcularDesgloseIva(items);

    expect(r.impNeto).toBe(373.7);
    expect(r.impIVA).toBe(78.44);
    // El propio chequeo de consistencia de wsfev1.js exige que esto cierre
    // con una tolerancia de 0.05 contra facturas.total — replicado acá.
    expect(Math.abs(redondear2(r.impNeto + r.impIVA) - 452.14)).toBeLessThanOrEqual(0.05);
  });

  it('caso realista de Factura A con 3 alícuotas mixtas: impNeto + impIVA cierra contra el total esperado (mismo chequeo que hace wsfev1.js antes de emitir)', () => {
    const items = [
      { subtotal: 1000, iva: 21 },   // 1000 + 210
      { subtotal: 300, iva: 10.5 },  // 300 + 31.5
      { subtotal: 150, iva: 0 },     // 150 + 0
    ];
    const r = calcularDesgloseIva(items);
    const totalEsperado = 1000 + 210 + 300 + 31.5 + 150;

    const diferencia = Math.abs(redondear2(r.impNeto + r.impIVA) - totalEsperado);
    expect(diferencia).toBeLessThanOrEqual(0.05);
    expect(r.alicuotas).toHaveLength(3);
  });
});
