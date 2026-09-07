// tests/asistente/consultar-stock-por-texto.test.js
//
// consultar_stock_por_texto_asistente (lib/asistente-tools/stock.js) —
// tool de lectura agregada al detectar en uso real que el asistente no
// tenía forma de responder "qué aceites tengo" / "y de los X estamos
// hablando": las tools existentes (consultar_stock_critico, buscarProductoPorTexto
// vía las tools de escritura) resuelven a UN producto o dan un conteo, pero
// ninguna lista todos los productos que matchean un texto con su stock.
//
// Mismo patrón que ajustar-stock-y-conteo.test.js: se mockea solo
// lib/repos/_db.js, con un router por nombre de tabla.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_STOCK } = await import('../../lib/asistente-tools/stock.js');

const tool = TOOLS_STOCK.find((t) => t.name === 'consultar_stock_por_texto_asistente');

const EMPRESA_ID = 'e1';

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    or: vi.fn(() => obj),
    in: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

function mockDb({ productos, stock }) {
  dbMock.from.mockImplementation((tabla) => {
    if (tabla === 'productos') return fakeQuery(productos);
    if (tabla === 'stock') return fakeQuery(stock);
    throw new Error(`tabla no mockeada en este test: ${tabla}`);
  });
}

describe('consultar_stock_por_texto_asistente', () => {
  beforeEach(() => {
    dbMock.from.mockReset();
    dbMock.rpc.mockReset();
  });

  it('existe y es de solo lectura (sin requiereConfirmacion)', () => {
    expect(tool).toBeTruthy();
    expect(tool.requiereConfirmacion).toBeFalsy();
    expect(tool.roles).toEqual(expect.arrayContaining(['dueno', 'admin', 'vendedor', 'depositero']));
  });

  it('lista varios productos que matchean el texto, con stock total y por depósito', async () => {
    mockDb({
      productos: {
        data: [
          { id: 'p1', nombre: 'Aceite en caja 12x900cc', codigo: 'AC-900' },
          { id: 'p2', nombre: 'Aceite oliva 500cc', codigo: 'AC-OL-500' },
        ],
        error: null,
      },
      stock: {
        data: [
          { producto_id: 'p1', cantidad: 10, cantidad_reservada: 2, cantidad_disponible: 8, depositos: { nombre: 'Depósito Central' } },
          { producto_id: 'p1', cantidad: 5, cantidad_reservada: 0, cantidad_disponible: 5, depositos: { nombre: 'Depósito Norte' } },
          { producto_id: 'p2', cantidad: 0, cantidad_reservada: 0, cantidad_disponible: 0, depositos: { nombre: 'Depósito Central' } },
        ],
        error: null,
      },
    });

    const resultado = await tool.execute({ empresaId: EMPRESA_ID, args: { texto: 'aceite' } });

    expect(resultado).toHaveLength(2);
    const p1 = resultado.find((r) => r.codigo === 'AC-900');
    expect(p1.total_disponible).toBe(13);
    expect(p1.por_deposito).toEqual(expect.arrayContaining([
      { deposito: 'Depósito Central', disponible: 8 },
      { deposito: 'Depósito Norte', disponible: 5 },
    ]));
    const p2 = resultado.find((r) => r.codigo === 'AC-OL-500');
    expect(p2.total_disponible).toBe(0);
  });

  it('un producto sin ninguna fila de stock devuelve total_disponible 0 y por_deposito vacío', async () => {
    mockDb({
      productos: { data: [{ id: 'p3', nombre: 'Producto sin stock cargado', codigo: 'X' }], error: null },
      stock: { data: [], error: null },
    });

    const resultado = await tool.execute({ empresaId: EMPRESA_ID, args: { texto: 'sin stock' } });

    expect(resultado).toEqual([{ producto: 'Producto sin stock cargado', codigo: 'X', total_disponible: 0, por_deposito: [] }]);
  });

  it('sin coincidencias, tira un error claro (no una lista vacía silenciosa)', async () => {
    mockDb({ productos: { data: [], error: null }, stock: { data: [], error: null } });

    await expect(tool.execute({ empresaId: EMPRESA_ID, args: { texto: 'inexistente-xyz' } }))
      .rejects.toThrow(/No encontré ningún producto parecido/);
  });

  it('sin texto, tira error antes de tocar la base', async () => {
    await expect(tool.execute({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow(/Falta el texto/);
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('respeta el límite pasado, tope 50', async () => {
    mockDb({ productos: { data: [], error: null }, stock: { data: [], error: null } });
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query), or: vi.fn(() => query), limit: vi.fn(() => query), then: (r) => r({ data: [], error: null }) };
    dbMock.from.mockReturnValueOnce(query);

    await expect(tool.execute({ empresaId: EMPRESA_ID, args: { texto: 'x', limite: 500 } }))
      .rejects.toThrow(/No encontré/);
    expect(query.limit).toHaveBeenCalledWith(50);
  });

  it('propaga el error si falla la búsqueda de productos', async () => {
    mockDb({ productos: { data: null, error: { message: 'db caída' } }, stock: { data: [], error: null } });

    await expect(tool.execute({ empresaId: EMPRESA_ID, args: { texto: 'aceite' } }))
      .rejects.toThrow(/db caída/);
  });
});
