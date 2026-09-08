// tests/asistente/facturacion-resumen-ambiguedad.test.js
//
// Encontrado en la auditoría de Capa 4 (PLAN_QA_ASISTENTE.md): a diferencia
// de execute() (ver facturacion-ambiguedad-execute.test.js, que ya cubre el
// mismo bug del lado de la confirmación), el resumen() de anular_factura y
// emitir_factura hacía `if (factura.ambiguo) return factura;` — devolvía el
// objeto ambiguo crudo en vez de tirar un error. ejecutarTool()
// (lib/asistente-tools/index.js) inserta lo que sea que devuelva resumen()
// tal cual en la columna `resumen TEXT NOT NULL` de
// asistente_acciones_pendientes (migración 419) — un objeto ahí rompe el
// insert, en el PRIMER llamado a la tool (antes de que exista siquiera una
// propuesta pendiente), en vez de pedirle al usuario que elija un
// candidato como sí pasa en el resto del catálogo.
//
// Mismo criterio y mismo harness que facturacion-ambiguedad-execute.test.js
// (mockClienteUnico + fakeQuery ruteada por tabla) — la diferencia es que
// acá se llama tool.resumen(), no tool.execute().

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const facturasLibMock = vi.hoisted(() => ({
  anularFactura: vi.fn(),
  emitirFactura: vi.fn(),
}));
vi.mock('../../lib/facturas.js', () => facturasLibMock);

const { TOOLS_FACTURACION } = await import('../../lib/asistente-tools/facturacion.js');

const anularFacturaTool = TOOLS_FACTURACION.find((t) => t.name === 'anular_factura');
const emitirFacturaTool = TOOLS_FACTURACION.find((t) => t.name === 'emitir_factura');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    order: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

function mockClienteUnico() {
  dbMock.rpc.mockResolvedValue({
    data: [{ id: 'cli1', razon_social: 'Cliente X', activo: true }],
    error: null,
  });
}

describe('anular_factura — resumen() con ambigüedad real: tira ambiguo(), no devuelve el objeto crudo', () => {
  it('el cliente tiene 2+ facturas recientes: tira ambiguo() con .opciones, nunca un objeto como "resumen"', async () => {
    mockClienteUnico();
    dbMock.from.mockImplementation((tabla) => {
      if (tabla !== 'facturas') throw new Error(`tabla no mockeada en este test: ${tabla}`);
      return fakeQuery({
        data: [
          { id: 'AAAAAA111111', fecha_emision: '2026-08-20', total: 500 },
          { id: 'BBBBBB222222', fecha_emision: '2026-08-15', total: 300 },
        ],
        error: null,
      });
    });

    const resultado = await anularFacturaTool.resumen({
      empresaId: EMPRESA_ID, args: { cliente: 'Cliente X', motivo: 'error de carga' },
    }).catch((e) => e);

    // Tiene que ser un Error real (lanzado), no el objeto ambiguo devuelto
    // como si fuera el string de resumen.
    expect(resultado).toBeInstanceOf(Error);
    expect(typeof resultado).not.toBe('string');
    expect(resultado.opciones).toHaveLength(2);
    expect(resultado.opciones.map((o) => o.id)).toEqual(['AAAAAA111111', 'BBBBBB222222']);
    expect(resultado.message).toContain('111111');
    expect(resultado.message).toContain('222222');
  });
});

describe('emitir_factura — resumen() con ambigüedad real: tira ambiguo(), no devuelve el objeto crudo', () => {
  it('el cliente tiene 2+ pedidos recientes: tira ambiguo() con .opciones, nunca un objeto como "resumen"', async () => {
    mockClienteUnico();
    dbMock.from.mockImplementation((tabla) => {
      if (tabla !== 'pedidos') throw new Error(`tabla no mockeada en este test: ${tabla}`);
      return fakeQuery({
        data: [
          { id: 'CCCCCC333333', fecha_pedido: '2026-08-20', total: 1000 },
          { id: 'DDDDDD444444', fecha_pedido: '2026-08-18', total: 750 },
        ],
        error: null,
      });
    });

    const resultado = await emitirFacturaTool.resumen({
      empresaId: EMPRESA_ID, args: { cliente: 'Cliente X' },
    }).catch((e) => e);

    expect(resultado).toBeInstanceOf(Error);
    expect(typeof resultado).not.toBe('string');
    expect(resultado.opciones).toHaveLength(2);
    expect(resultado.opciones.map((o) => o.id)).toEqual(['CCCCCC333333', 'DDDDDD444444']);
    expect(resultado.message).toContain('333333');
    expect(resultado.message).toContain('444444');
  });
});
