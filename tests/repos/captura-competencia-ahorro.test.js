// tests/repos/captura-competencia-ahorro.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, Fase 2 (Capa 3 — retención). Complementa
// tests/repos/captura-competencia.test.js (Fase 1) cubriendo las 4
// funciones nuevas del repo: obtenerPreciosReferenciaCompetencia,
// registrarAhorroCompetenciaRpc, obtenerAhorroAcumuladoCliente y
// listarAhorroAcumuladoEmpresa.
//
// Foco particular en obtenerPreciosReferenciaCompetencia: tiene que tomar
// la captura CONVERTIDA más antigua del cliente (no la última), ignorar
// items descartados o sin producto_id matcheado, y no pisar un producto ya
// visto si aparece repetido en la misma captura.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  obtenerPreciosReferenciaCompetencia,
  registrarAhorroCompetenciaRpc,
  obtenerAhorroAcumuladoCliente,
  listarAhorroAcumuladoEmpresa,
} = await import('../../lib/repos/captura-competencia.js');

/** Mismo query builder encadenable que tests/repos/captura-competencia.test.js. */
function fakeQuery(result, { terminal = null } = {}) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    order: vi.fn(() => obj),
    limit: vi.fn(() => obj),
  };
  if (terminal) obj[terminal] = vi.fn(() => Promise.resolve(result));
  obj.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return obj;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('obtenerPreciosReferenciaCompetencia', () => {
  it('toma la captura convertida más antigua (order ascending + limit 1)', async () => {
    const query = fakeQuery({
      data: [{ id: 'cap-1', fecha_captura: '2026-01-01', captura_competencia_items: [
        { producto_id: 'p1', precio_unitario_competencia: 100, descartado: false },
      ] }],
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await obtenerPreciosReferenciaCompetencia('c1', 'e1');

    expect(dbMock.from).toHaveBeenCalledWith('captura_competencia');
    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'c1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('estado', 'convertido_pedido');
    expect(query.order).toHaveBeenCalledWith('fecha_captura', { ascending: true });
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(error).toBeNull();
    expect(data.get('p1')).toBe(100);
  });

  it('ignora items descartados y sin producto_id matcheado', async () => {
    const query = fakeQuery({
      data: [{ id: 'cap-1', captura_competencia_items: [
        { producto_id: 'p1', precio_unitario_competencia: 100, descartado: true },
        { producto_id: null, precio_unitario_competencia: 50, descartado: false },
        { producto_id: 'p2', precio_unitario_competencia: null, descartado: false },
        { producto_id: 'p3', precio_unitario_competencia: 80, descartado: false },
      ] }],
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPreciosReferenciaCompetencia('c1', 'e1');

    expect(data.size).toBe(1);
    expect(data.get('p3')).toBe(80);
  });

  it('no pisa un producto ya visto si aparece repetido en la misma captura', async () => {
    const query = fakeQuery({
      data: [{ id: 'cap-1', captura_competencia_items: [
        { producto_id: 'p1', precio_unitario_competencia: 100, descartado: false },
        { producto_id: 'p1', precio_unitario_competencia: 999, descartado: false },
      ] }],
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPreciosReferenciaCompetencia('c1', 'e1');

    expect(data.get('p1')).toBe(100);
  });

  it('devuelve un Map vacío si el cliente no tiene ninguna captura convertida', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await obtenerPreciosReferenciaCompetencia('c1', 'e1');

    expect(error).toBeNull();
    expect(data.size).toBe(0);
  });

  it('propaga el error de la query sin lanzar', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await obtenerPreciosReferenciaCompetencia('c1', 'e1');

    expect(data).toBeNull();
    expect(error.message).toBe('boom');
  });
});

describe('registrarAhorroCompetenciaRpc', () => {
  it('llama a fn_registrar_ahorro_competencia con los parámetros tal cual', async () => {
    dbMock.rpc.mockResolvedValue({ error: null });

    const params = {
      p_pedido_id: 'ped-1',
      p_cliente_id: 'c1',
      p_empresa_id: 'e1',
      p_ahorro_pedido: 123.45,
      p_detalle: [{ producto_id: 'p1', ahorro: 123.45 }],
    };
    const { error } = await registrarAhorroCompetenciaRpc(params);

    expect(dbMock.rpc).toHaveBeenCalledWith('fn_registrar_ahorro_competencia', params);
    expect(error).toBeNull();
  });

  it('propaga el error del RPC sin lanzar', async () => {
    dbMock.rpc.mockResolvedValue({ error: { message: 'no autorizado' } });

    const { error } = await registrarAhorroCompetenciaRpc({
      p_pedido_id: 'ped-1', p_cliente_id: 'c1', p_empresa_id: 'e1', p_ahorro_pedido: 10,
    });

    expect(error.message).toBe('no autorizado');
  });
});

describe('obtenerAhorroAcumuladoCliente', () => {
  it('consulta cliente_ahorro_acumulado por cliente_id con maybeSingle', async () => {
    const query = fakeQuery({ data: { ahorro_acumulado: 500, pedidos_con_ahorro: 3 }, error: null }, { terminal: 'maybeSingle' });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerAhorroAcumuladoCliente('c1');

    expect(dbMock.from).toHaveBeenCalledWith('cliente_ahorro_acumulado');
    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'c1');
    expect(data.ahorro_acumulado).toBe(500);
  });
});

describe('listarAhorroAcumuladoEmpresa', () => {
  it('filtra por empresa_id y ordena de mayor a menor ahorro', async () => {
    const query = fakeQuery({
      data: [
        { ahorro_acumulado: 900, pedidos_con_ahorro: 5, clientes: { razon_social: 'Cliente A' } },
        { ahorro_acumulado: 100, pedidos_con_ahorro: 1, clientes: { razon_social: 'Cliente B' } },
      ],
      error: null,
    });
    dbMock.from.mockReturnValue(query);

    const { data } = await listarAhorroAcumuladoEmpresa('e1');

    expect(dbMock.from).toHaveBeenCalledWith('cliente_ahorro_acumulado');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.order).toHaveBeenCalledWith('ahorro_acumulado', { ascending: false });
    expect(data).toHaveLength(2);
  });
});
