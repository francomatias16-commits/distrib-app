// tests/repos/cta-cte.test.js
//
// Fase 7, paso 4 — `cta_cte` no tenía tests de repo. Igual que en
// productos.test.js, cada test documenta en su descripción la política de
// error de la función que cubre (silenciosa vs. throw) porque acá la
// diferencia importa especialmente: `insertarMovimiento` SÍ debe propagar
// el error (un insert de deuda fallido en silencio es plata perdida),
// mientras que las lecturas de `obtenerUltimoSaldo` y
// `listarMovimientosPorCliente` se mantienen silenciosas a propósito (ver
// comentarios en lib/repos/cta-cte.js sobre por qué no se corrigió eso en
// este paso).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  obtenerUltimoSaldo,
  insertarMovimiento,
  listarMovimientosPorCliente,
  listarUltimosMovimientos,
} = await import('../../lib/repos/cta-cte.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    order:       vi.fn(() => obj),
    limit:       vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then:        (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
});

describe('obtenerUltimoSaldo', () => {
  it('filtra por empresa_id Y cliente_id, ordena por fecha desc, trae solo el último', async () => {
    const query = fakeQuery({ data: { saldo: 1500 }, error: null });
    dbMock.from.mockReturnValue(query);

    const saldo = await obtenerUltimoSaldo('empresa-1', 'cliente-1');

    expect(dbMock.from).toHaveBeenCalledWith('cta_cte');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'cliente-1');
    expect(query.order).toHaveBeenCalledWith('fecha', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(saldo).toBe(1500);
  });

  it('devuelve 0 si el cliente no tiene movimientos todavía', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    expect(await obtenerUltimoSaldo('empresa-1', 'cliente-nuevo')).toBe(0);
  });

  it('devuelve 0 (no lanza) si la query falla — comportamiento silencioso replicado tal cual del original, ver nota en el repo', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await obtenerUltimoSaldo('empresa-1', 'cliente-1')).toBe(0);
  });
});

describe('insertarMovimiento', () => {
  it('inserta con todos los campos tal cual se le pasan', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await insertarMovimiento({
      empresa_id: 'empresa-1',
      cliente_id: 'cliente-1',
      tipo: 'debito',
      monto: 200,
      factura_id: 'factura-1',
      saldo: 200,
      fecha: '2026-08-01',
    });

    expect(query.insert).toHaveBeenCalledWith({
      empresa_id: 'empresa-1',
      cliente_id: 'cliente-1',
      tipo: 'debito',
      monto: 200,
      factura_id: 'factura-1',
      saldo: 200,
      fecha: '2026-08-01',
    });
  });

  it('lanza si el insert falla — acá SÍ importa, es plata: un insert perdido en silencio desincroniza el saldo real', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'empresa_id no puede ser null' } }));

    await expect(insertarMovimiento({ empresa_id: null, cliente_id: 'c1', tipo: 'debito', monto: 1, saldo: 1, fecha: 'x' }))
      .rejects.toThrow('[CtaCteRepo.insertarMovimiento] empresa_id no puede ser null');
  });
});

describe('listarMovimientosPorCliente', () => {
  it('filtra por empresa_id Y cliente_id (hallazgo: el query original solo filtraba por cliente_id)', async () => {
    const fila = { monto: 100, tipo: 'debito' };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarMovimientosPorCliente('empresa-1', 'cliente-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'cliente-1');
    expect(data).toEqual([fila]);
  });

  it('devuelve [] (no lanza) si la query falla — se llama dentro de un for sin try/catch por iteración en el cron, no debe cortar el batch', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await listarMovimientosPorCliente('empresa-1', 'cliente-1')).toEqual([]);
  });
});

describe('listarUltimosMovimientos', () => {
  it('filtra por empresa_id y cliente_id, ordena desc y limita', async () => {
    const fila = { fecha: '2026-08-01', monto: 100, tipo: 'debito' };
    const query = fakeQuery({ data: [fila], error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarUltimosMovimientos('empresa-1', 'cliente-1', { limit: 10 });

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'cliente-1');
    expect(query.order).toHaveBeenCalledWith('fecha', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(10);
    expect(data).toEqual([fila]);
  });

  it('usa 10 como límite por defecto si no se especifica', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await listarUltimosMovimientos('empresa-1', 'cliente-1');

    expect(query.limit).toHaveBeenCalledWith(10);
  });

  it('devuelve [] (no lanza) si la query falla — el estado de cuenta se manda igual, sin el detalle de movimientos', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await listarUltimosMovimientos('empresa-1', 'cliente-1')).toEqual([]);
  });
});
