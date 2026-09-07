// tests/asistente/consultar-stock-valorizacion-distribucion.test.js
//
// Frente 3 de PLAN_COBERTURA_TOOLS_ASISTENTE.md: fn_reportes_stock_valorizacion
// y fn_reportes_stock_distribucion no recibían p_empresa_id explícito (lo
// resolvían con get_empresa_id()/auth.uid(), NULL bajo el cliente
// service_role del asistente). Se agregó un overload nuevo de cada RPC con
// p_empresa_id explícito, revocado de anon/authenticated y otorgado solo a
// service_role (migración
// asistente_tools_reportes_stock_facturas_empresa_id_explicito) — la firma
// vieja (sin el parámetro) sigue intacta para el Panel administrativo.
//
// Mismo patrón de mock que stock-maestros-y-transferencia-formato-error.test.js:
// se mockea solo lib/repos/_db.js (from + rpc), dejando correr
// buscarDepositoPorTexto (_helpers.js) real.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_STOCK } = await import('../../lib/asistente-tools/stock.js');

const consultarStockValorizacion = TOOLS_STOCK.find((t) => t.name === 'consultar_stock_valorizacion');
const consultarStockDistribucion = TOOLS_STOCK.find((t) => t.name === 'consultar_stock_distribucion');

const EMPRESA_ID = 'e1';

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    ilike: vi.fn(() => obj),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('consultar_stock_valorizacion', () => {
  it('existe, es de solo lectura y tiene roles definidos', () => {
    expect(consultarStockValorizacion).toBeTruthy();
    expect(consultarStockValorizacion.requiereConfirmacion).toBeFalsy();
    expect(Array.isArray(consultarStockValorizacion.roles) && consultarStockValorizacion.roles.length > 0).toBe(true);
  });

  it('llama a la RPC nueva (con p_empresa_id) y devuelve los datos', async () => {
    const payload = [
      { deposito_id: 'd1', deposito_nombre: 'Depósito Central', cantidad_productos: 9, unidades: 2274, costo_total: 150000 },
    ];
    dbMock.rpc.mockResolvedValueOnce({ data: payload, error: null });

    const resultado = await consultarStockValorizacion.execute({ empresaId: EMPRESA_ID, args: {} });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_reportes_stock_valorizacion', { p_empresa_id: EMPRESA_ID });
    expect(resultado).toEqual(payload);
  });

  it('propaga el error de la RPC con el nombre de la tool en el mensaje', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db caída' } });

    await expect(consultarStockValorizacion.execute({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow('consultar_stock_valorizacion: db caída');
  });
});

describe('consultar_stock_distribucion', () => {
  it('existe, es de solo lectura y tiene roles definidos', () => {
    expect(consultarStockDistribucion).toBeTruthy();
    expect(consultarStockDistribucion.requiereConfirmacion).toBeFalsy();
    expect(Array.isArray(consultarStockDistribucion.roles) && consultarStockDistribucion.roles.length > 0).toBe(true);
  });

  it('sin depósito, llama a la RPC con p_deposito_id null', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: [{ categoria_nombre: 'Bebidas', valor_total: 5000 }], error: null });

    const resultado = await consultarStockDistribucion.execute({ empresaId: EMPRESA_ID, args: {} });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_reportes_stock_distribucion', {
      p_empresa_id: EMPRESA_ID,
      p_deposito_id: null,
    });
    expect(resultado).toEqual([{ categoria_nombre: 'Bebidas', valor_total: 5000 }]);
  });

  it('con depósito por texto, lo resuelve con buscarDepositoPorTexto (scopeado por empresa) antes de llamar la RPC', async () => {
    dbMock.from.mockImplementationOnce((tabla) => {
      expect(tabla).toBe('depositos');
      return fakeQuery({ data: [{ id: 'dep-norte', nombre: 'Depósito Norte' }], error: null });
    });
    dbMock.rpc.mockResolvedValueOnce({ data: [{ categoria_nombre: 'Limpieza', valor_total: 1200 }], error: null });

    await consultarStockDistribucion.execute({ empresaId: EMPRESA_ID, args: { deposito: 'norte' } });

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_reportes_stock_distribucion', {
      p_empresa_id: EMPRESA_ID,
      p_deposito_id: 'dep-norte',
    });
  });

  it('si no encuentra el depósito, no llega a llamar la RPC', async () => {
    dbMock.from.mockImplementationOnce(() => fakeQuery({ data: [], error: null }));

    await expect(consultarStockDistribucion.execute({ empresaId: EMPRESA_ID, args: { deposito: 'inexistente' } }))
      .rejects.toThrow('No encontré ningún depósito parecido a "inexistente"');
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });

  it('propaga el error de la RPC con el nombre de la tool en el mensaje', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db caída' } });

    await expect(consultarStockDistribucion.execute({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow('consultar_stock_distribucion: db caída');
  });
});
