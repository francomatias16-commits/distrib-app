// tests/repos/scores.test.js
//
// Plan 3.2, punto 1: calcular_score_cliente es una función SQL (RPC), así
// que la aritmética del score en sí vive en Postgres y no se testea acá con
// Vitest (eso es trabajo de test de integración contra la base real, ver
// scripts/test-integration.js). Lo que SÍ se puede — y conviene — testear
// como unit test es la capa JS que arma la llamada: que se invoque la RPC
// correcta con los parámetros correctos, que los errores de Supabase se
// propaguen con mensaje claro, y que la lógica de "recalcular todos" cuente
// bien éxitos/errores por cliente sin cortar el batch ante el primer fallo.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { calcularScore, guardarReglas, resolverAlerta, recalcularTodos } =
  await import('../../lib/repos/scores.js');

// Query builder falso: todos los métodos de encadenado devuelven `this`;
// los métodos terminales (single/maybeSingle) y el propio objeto (vía
// `then`) resuelven con el resultado configurado — igual que hace el
// builder real de supabase-js al ser awaited en cualquier punto de la cadena.
function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    order: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    upsert: vi.fn(() => obj),
    update: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('calcularScore', () => {
  it('llama a la RPC calcular_score_cliente con los parámetros correctos', async () => {
    dbMock.rpc.mockResolvedValue({ data: { score: 87 }, error: null });

    const resultado = await calcularScore('empresa-1', 'cliente-1', 'motivo-x');

    expect(dbMock.rpc).toHaveBeenCalledWith('calcular_score_cliente', {
      p_cliente_id: 'cliente-1',
      p_empresa_id: 'empresa-1',
      p_motivo:     'motivo-x',
    });
    expect(resultado).toEqual({ score: 87 });
  });

  it('usa "recalculo" como motivo por defecto', async () => {
    dbMock.rpc.mockResolvedValue({ data: {}, error: null });

    await calcularScore('empresa-1', 'cliente-1');

    expect(dbMock.rpc).toHaveBeenCalledWith('calcular_score_cliente', expect.objectContaining({
      p_motivo: 'recalculo',
    }));
  });

  it('propaga el error de la RPC con un mensaje identificable', async () => {
    dbMock.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(calcularScore('empresa-1', 'cliente-1')).rejects.toThrow('[ScoreRepo.calcular] boom');
  });
});

describe('guardarReglas', () => {
  it('hace upsert con onConflict empresa_id y mergea el empresa_id en el payload', async () => {
    const query = fakeQuery({ data: { empresa_id: 'empresa-1', umbral: 50 }, error: null });
    dbMock.from.mockReturnValue(query);

    const resultado = await guardarReglas('empresa-1', { umbral: 50 });

    expect(dbMock.from).toHaveBeenCalledWith('reglas_score');
    expect(query.upsert).toHaveBeenCalledWith(
      { empresa_id: 'empresa-1', umbral: 50 },
      { onConflict: 'empresa_id' },
    );
    expect(resultado).toEqual({ empresa_id: 'empresa-1', umbral: 50 });
  });

  it('propaga el error del upsert', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'constraint violada' } }));

    await expect(guardarReglas('empresa-1', {})).rejects.toThrow('[ScoreRepo.guardarReglas] constraint violada');
  });
});

describe('resolverAlerta', () => {
  it('filtra por id de alerta Y empresa_id antes de marcar resuelta (aislamiento multi-tenant)', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await resolverAlerta('empresa-1', 'alerta-9');

    expect(query.update).toHaveBeenCalledWith({ resuelta: true });
    expect(query.eq).toHaveBeenNthCalledWith(1, 'id', 'alerta-9');
    expect(query.eq).toHaveBeenNthCalledWith(2, 'empresa_id', 'empresa-1');
  });

  it('propaga el error si el update falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'no encontrada' } }));

    await expect(resolverAlerta('empresa-1', 'alerta-9')).rejects.toThrow('[ScoreRepo.resolverAlerta] no encontrada');
  });
});

describe('recalcularTodos', () => {
  it('cuenta éxitos y errores por cliente sin cortar el batch ante un fallo', async () => {
    dbMock.from.mockReturnValue(fakeQuery({
      data: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      error: null,
    }));

    // c1 y c3 se recalculan bien, c2 falla — el batch debe seguir igual.
    dbMock.rpc.mockImplementation((_fn, params) => {
      if (params.p_cliente_id === 'c2') {
        return Promise.resolve({ data: null, error: { message: 'falló c2' } });
      }
      return Promise.resolve({ data: { score: 1 }, error: null });
    });

    const resultado = await recalcularTodos('empresa-1');

    expect(resultado).toEqual({ actualizados: 2, errores: 1 });
    expect(dbMock.rpc).toHaveBeenCalledTimes(3);
  });

  it('no llama a la RPC si la empresa no tiene clientes activos', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: [], error: null }));

    const resultado = await recalcularTodos('empresa-vacia');

    expect(resultado).toEqual({ actualizados: 0, errores: 0 });
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });
});
