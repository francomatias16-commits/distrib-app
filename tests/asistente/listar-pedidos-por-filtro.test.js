// tests/asistente/listar-pedidos-por-filtro.test.js
//
// Frente 5 de PLAN_COBERTURA_TOOLS_ASISTENTE.md: listar_pedidos_pendientes
// está hardcodeada a excluir solo entregado/cancelado, sin filtro de
// estado puntual, cliente o rango de fechas. Se agregó una tool nueva
// (listar_pedidos_por_filtro, opción (a) del plan) en vez de ampliar el
// contrato de la existente. No hizo falta ninguna RPC nueva — mismo
// `.from('pedidos')` de siempre, cliente resuelto con
// buscarClienteParaCobroPorTexto (ya usado por otras tools de este mismo
// archivo).
//
// Mismo patrón de mock que pedidos-formato-error.test.js: se mockea solo
// lib/repos/_db.js (from + rpc), dejando correr los resolvers reales de
// _helpers.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_PEDIDOS } = await import('../../lib/asistente-tools/pedidos.js');

const listarPedidosPorFiltro = TOOLS_PEDIDOS.find((t) => t.name === 'listar_pedidos_por_filtro');

const EMPRESA_ID = 'e1';

// Query builder encadenable: cada método de filtro devuelve el mismo
// objeto (para poder encadenar cualquier combinación, como hace
// execute()), y solo se resuelve como promesa al final (then).
function fakePedidosQuery(resultado) {
  const llamadas = { eq: [], gte: [], lt: [] };
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn((col, val) => { llamadas.eq.push([col, val]); return obj; }),
    gte: vi.fn((col, val) => { llamadas.gte.push([col, val]); return obj; }),
    lt: vi.fn((col, val) => { llamadas.lt.push([col, val]); return obj; }),
    order: vi.fn(() => obj),
    limit: vi.fn(() => obj),
    then: (resolve, reject) => Promise.resolve(resultado).then(resolve, reject),
    _llamadas: llamadas,
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('listar_pedidos_por_filtro', () => {
  it('existe, es de solo lectura y tiene roles definidos', () => {
    expect(listarPedidosPorFiltro).toBeTruthy();
    expect(listarPedidosPorFiltro.requiereConfirmacion).toBeFalsy();
    expect(Array.isArray(listarPedidosPorFiltro.roles) && listarPedidosPorFiltro.roles.length > 0).toBe(true);
  });

  it('sin filtros, trae hasta el límite default (15) sin ningún .eq/.gte/.lt de filtro', async () => {
    const query = fakePedidosQuery({ data: [], error: null });
    dbMock.from.mockImplementationOnce((tabla) => {
      expect(tabla).toBe('pedidos');
      return query;
    });

    await listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: {} });

    // El único .eq esperado es el de empresa_id (siempre presente).
    expect(query._llamadas.eq).toEqual([['empresa_id', EMPRESA_ID]]);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(15);
  });

  it('filtra por estado exacto', async () => {
    const query = fakePedidosQuery({ data: [], error: null });
    dbMock.from.mockImplementationOnce(() => query);

    await listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: { estado: 'entregado' } });

    expect(query._llamadas.eq).toEqual([
      ['empresa_id', EMPRESA_ID],
      ['estado', 'entregado'],
    ]);
  });

  it('filtra por cliente: lo resuelve por texto antes de armar la query', async () => {
    dbMock.rpc.mockResolvedValueOnce({
      data: [{ id: 'cli-1', razon_social: 'Distribuidora Sur', activo: true }],
      error: null,
    });
    const query = fakePedidosQuery({ data: [], error: null });
    dbMock.from.mockImplementationOnce(() => query);

    await listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: { cliente: 'sur' } });

    expect(dbMock.rpc).toHaveBeenCalledWith('buscar_clientes_asistente', {
      p_empresa_id: EMPRESA_ID,
      p_texto: 'sur',
      p_limite: 6,
    });
    expect(query._llamadas.eq).toEqual([
      ['empresa_id', EMPRESA_ID],
      ['cliente_id', 'cli-1'],
    ]);
  });

  it('resuelve el cliente aunque esté inactivo (historial válido para clientes dados de baja)', async () => {
    dbMock.rpc.mockResolvedValueOnce({
      data: [{ id: 'cli-2', razon_social: 'Cliente Viejo', activo: false }],
      error: null,
    });
    const query = fakePedidosQuery({ data: [], error: null });
    dbMock.from.mockImplementationOnce(() => query);

    await expect(
      listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: { cliente: 'viejo' } })
    ).resolves.not.toThrow();
    expect(query._llamadas.eq).toContainEqual(['cliente_id', 'cli-2']);
  });

  it('si el cliente no matchea a nadie, no llega a armar la query de pedidos', async () => {
    dbMock.rpc.mockResolvedValueOnce({ data: [], error: null });

    await expect(
      listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: { cliente: 'inexistente' } })
    ).rejects.toThrow('No encontré ningún cliente parecido a "inexistente"');
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('filtra por rango de fechas: desde inclusive (gte) y hasta inclusive (lt del día siguiente)', async () => {
    const query = fakePedidosQuery({ data: [], error: null });
    dbMock.from.mockImplementationOnce(() => query);

    await listarPedidosPorFiltro.execute({
      empresaId: EMPRESA_ID,
      args: { desde: '2026-08-01', hasta: '2026-08-31' },
    });

    expect(query._llamadas.gte).toEqual([['created_at', '2026-08-01']]);
    expect(query._llamadas.lt).toEqual([['created_at', '2026-09-01T00:00:00.000Z']]);
  });

  it('un límite por encima del tope (50) se recorta', async () => {
    const query = fakePedidosQuery({ data: [], error: null });
    dbMock.from.mockImplementationOnce(() => query);

    await listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: { limite: 500 } });

    expect(query.limit).toHaveBeenCalledWith(50);
  });

  it('un límite inválido (0, negativo o no numérico) cae al default de 15', async () => {
    const query = fakePedidosQuery({ data: [], error: null });
    dbMock.from.mockImplementationOnce(() => query);

    await listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: { limite: -3 } });

    expect(query.limit).toHaveBeenCalledWith(15);
  });

  it('mapea el resultado a referencia_corta/cliente/estado/total/cantidad_items/creado', async () => {
    const query = fakePedidosQuery({
      data: [
        {
          id: 'abcdef123456',
          estado: 'entregado',
          total: 5000,
          created_at: '2026-08-15T12:00:00Z',
          clientes: { razon_social: 'Distribuidora Sur' },
          pedido_items: [{ cantidad: 2 }, { cantidad: 1 }],
        },
      ],
      error: null,
    });
    dbMock.from.mockImplementationOnce(() => query);

    const resultado = await listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: {} });

    expect(resultado).toEqual([
      {
        referencia_corta: '123456',
        cliente: 'Distribuidora Sur',
        estado: 'entregado',
        total: 5000,
        cantidad_items: 2,
        creado: '2026-08-15T12:00:00Z',
      },
    ]);
  });

  it('propaga el error de la consulta con el nombre de la tool en el mensaje', async () => {
    const query = fakePedidosQuery({ data: null, error: { message: 'db caída' } });
    dbMock.from.mockImplementationOnce(() => query);

    await expect(listarPedidosPorFiltro.execute({ empresaId: EMPRESA_ID, args: {} }))
      .rejects.toThrow('listar_pedidos_por_filtro: db caída');
  });
});
