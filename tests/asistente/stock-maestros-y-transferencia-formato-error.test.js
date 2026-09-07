// tests/asistente/stock-maestros-y-transferencia-formato-error.test.js
//
// Fase 3 (continuacion) -- primera migracion real de tools concretas al
// contrato de _respuestas.js (faltaDato/bloqueado), sobre
// lib/asistente-tools/stock.js:
//   - crear_categoria / crear_deposito / crear_zona: el chequeo de
//     "falta el nombre" paso a faltaDato(), y el de "ya existe" paso a
//     bloqueado(motivo, salida) en vez de un string armado a mano.
//   - transferir_stock_asistente: el chequeo de stock insuficiente paso
//     a bloqueado() (no tenia test propio hasta ahora).
//   - ajustar_stock_asistente (egreso): mismo chequeo migrado a
//     bloqueado(), preservando la redaccion exacta que ya cubria
//     tests/asistente/ajustar-stock-y-conteo.test.js (ese archivo no se
//     toco y sigue en verde); aca se agrega la prueba de que el error
//     tiene forma real de bloqueado() (sin `.opciones`, a diferencia de
//     ambiguo()).
//
// Mismo patron de mock que ajustar-stock-y-conteo.test.js: se mockea
// solo lib/repos/_db.js (from + rpc), dejando correr los resolvers
// reales de _helpers.js.
//
// No se tocaron crear_producto/editar_producto en esta pasada -- quedan
// para una migracion posterior (ver CHANGELOG).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_STOCK } = await import('../../lib/asistente-tools/stock.js');

const crearCategoria = TOOLS_STOCK.find((t) => t.name === 'crear_categoria');
const crearDeposito = TOOLS_STOCK.find((t) => t.name === 'crear_deposito');
const crearZona = TOOLS_STOCK.find((t) => t.name === 'crear_zona');
const transferirStock = TOOLS_STOCK.find((t) => t.name === 'transferir_stock_asistente');
const ajustarStock = TOOLS_STOCK.find((t) => t.name === 'ajustar_stock_asistente');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    ilike: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

function mockDbMaestro(tabla, existente) {
  dbMock.from.mockImplementation((t) => {
    if (t === tabla) return fakeQuery({ data: existente, error: null });
    throw new Error(`tabla inesperada en este test: ${t}`);
  });
}

describe.each([
  ['crear_categoria', () => crearCategoria, 'categorias', 'una categoría'],
  ['crear_deposito', () => crearDeposito, 'depositos', 'un depósito'],
  ['crear_zona', () => crearZona, 'zonas', 'una zona'],
])('%s — formato de error migrado', (_nombre, getTool, tabla, articuloIndefinido) => {
  it('sin nombre: tira faltaDato (mensaje "Me falta ... para seguir.", sin `.opciones`)', async () => {
    const tool = getTool();
    const err = await tool.resumen({ empresaId: EMPRESA_ID, args: {} }).catch((e) => e);
    expect(err.message).toMatch(/^Me falta .+ para seguir\.$/);
    expect(err.opciones).toBeUndefined();
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('ya existe: tira bloqueado citando el nombre y explicando que no hace falta crearlo de nuevo, sin `.opciones`', async () => {
    mockDbMaestro(tabla, { id: 'x1', nombre: 'Ya Existente' });
    const tool = getTool();
    const err = await tool.resumen({ empresaId: EMPRESA_ID, args: { nombre: 'Ya Existente' } }).catch((e) => e);
    expect(err.message).toContain(`Ya existe ${articuloIndefinido} llamad`);
    expect(err.message).toContain('"Ya Existente"');
    expect(err.message).toContain('No hace falta crear');
    expect(err.opciones).toBeUndefined();
  });
});

describe('transferir_stock_asistente — stock insuficiente migrado a bloqueado()', () => {
  const DEPOSITOS = [
    { id: 'd1', nombre: 'Depósito Central' },
    { id: 'd2', nombre: 'Depósito Norte' },
  ];

  function mockDb({ stockRow = { data: { cantidad: 0 }, error: null } } = {}) {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'depositos') {
        const obj = {
          select: vi.fn(() => obj),
          eq: vi.fn(() => obj),
          ilike: vi.fn((_col, val) => { obj.__buscado = val; return obj; }),
          then: (resolve, reject) => {
            const buscado = String(obj.__buscado || '').replace(/%/g, '').trim().toLowerCase();
            const data = DEPOSITOS.filter((d) => d.nombre.toLowerCase().includes(buscado));
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return obj;
      }
      if (tabla === 'stock') return fakeQuery(stockRow);
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    dbMock.rpc.mockImplementation((rpc) => {
      if (rpc === 'buscar_productos_asistente') {
        return Promise.resolve({ data: [{ id: 'p1', nombre: 'Fideos', similitud: 1 }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  }

  it('cantidad pedida mayor a la disponible: tira bloqueado citando disponible y pedido, sin `.opciones`', async () => {
    mockDb({ stockRow: { data: { cantidad: 3 }, error: null } });
    const err = await transferirStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito_origen: 'Central', deposito_destino: 'Norte', cantidad: 5 },
    }).catch((e) => e);
    expect(err.message).toContain('No hay suficiente stock en "Depósito Central"');
    expect(err.message).toContain('Disponible 3, se pidió transferir 5.');
    expect(err.opciones).toBeUndefined();
  });
});

describe('ajustar_stock_asistente — stock insuficiente en egreso: mismo mensaje de siempre, ahora vía bloqueado()', () => {
  const DEPOSITOS = [{ id: 'd1', nombre: 'Depósito Central' }];

  function mockDb({ stockRow = { data: { cantidad: 0 }, error: null } } = {}) {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'depositos') {
        const obj = {
          select: vi.fn(() => obj),
          eq: vi.fn(() => obj),
          ilike: vi.fn((_col, val) => { obj.__buscado = val; return obj; }),
          then: (resolve, reject) => {
            const buscado = String(obj.__buscado || '').replace(/%/g, '').trim().toLowerCase();
            const data = DEPOSITOS.filter((d) => d.nombre.toLowerCase().includes(buscado));
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return obj;
      }
      if (tabla === 'stock') return fakeQuery(stockRow);
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    dbMock.rpc.mockImplementation((rpc) => {
      if (rpc === 'buscar_productos_asistente') {
        return Promise.resolve({ data: [{ id: 'p1', nombre: 'Fideos', similitud: 1 }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  }

  it('preserva la redacción exacta ya cubierta en ajustar-stock-y-conteo.test.js, y no tiene `.opciones`', async () => {
    mockDb({ stockRow: { data: { cantidad: 3 }, error: null } });
    const err = await ajustarStock.resumen({
      empresaId: EMPRESA_ID,
      args: { producto: 'Fideos', deposito: 'Central', tipo: 'egreso', cantidad: 5 },
    }).catch((e) => e);
    expect(err.message).toBe('No hay suficiente stock de "Fideos" en "Depósito Central": disponible 3, se pidió restar 5.');
    expect(err.opciones).toBeUndefined();
  });
});
