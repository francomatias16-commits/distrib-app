// tests/repos/stock-auto.test.js
//
// Fase 7 — `stock-auto.js` (REQ-4: Stock Vivo con Reposición Autónoma) no
// tenía tests de repo. Foco en aislamiento por empresa_id donde aplica, en
// la idempotencia de la generación automática de órdenes (chequeo de orden
// reciente, upsert de alertas con onConflict), y en la política de error
// silenciosa vs. throw/propagada de cada función.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  listarEmpresasActivas,
  analizarStockAutonomoRpc,
  listarAlertasStockActivas,
  resolverAlertaStock,
  buscarOrdenRecienteProveedor,
  insertarOrdenCompraAuto,
  insertarItemsOrdenCompra,
  upsertAlertasStock,
  obtenerOrdenParaEnviar,
  listarItemsOrdenCompra,
  marcarOrdenEnviada,
  marcarAlertasResueltasPorOrden,
} = await import('../../lib/repos/stock-auto.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    in:          vi.fn(() => obj),
    gte:         vi.fn(() => obj),
    order:       vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    upsert:      vi.fn(() => obj),
    single:      vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then:        (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('listarEmpresasActivas', () => {
  it('filtra por activa=true — silenciosa, default []', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    const data = await listarEmpresasActivas();
    expect(dbMock.from).toHaveBeenCalledWith('empresas');
    expect(data).toEqual([]);
  });

  it('devuelve la lista de empresas si hay data', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: [{ id: 'e1' }, { id: 'e2' }], error: null }));
    const data = await listarEmpresasActivas();
    expect(data).toHaveLength(2);
  });
});

describe('analizarStockAutonomoRpc', () => {
  it('envuelve la RPC con p_empresa_id y devuelve { data, error } tal cual', async () => {
    dbMock.rpc.mockResolvedValue({ data: [{ producto_id: 'p1', necesita_reponer: true }], error: null });
    const { data, error } = await analizarStockAutonomoRpc('e1');
    expect(dbMock.rpc).toHaveBeenCalledWith('analizar_stock_autonomo', { p_empresa_id: 'e1' });
    expect(error).toBeNull();
    expect(data[0].producto_id).toBe('p1');
  });

  it('propaga un error de la RPC tal cual para que el caller decida', async () => {
    dbMock.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { error } = await analizarStockAutonomoRpc('e1');
    expect(error.message).toBe('boom');
  });
});

describe('listarAlertasStockActivas', () => {
  it('filtra por empresa_id Y resuelta=false, ordena por dias_restantes — propaga el error (throw)', async () => {
    const query = fakeQuery({ data: null, error: { message: 'boom' } });
    dbMock.from.mockReturnValue(query);
    await expect(listarAlertasStockActivas('e1')).rejects.toBeTruthy();
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('resuelta', false);
    expect(query.order).toHaveBeenCalledWith('dias_restantes', { ascending: true });
  });
});

describe('resolverAlertaStock', () => {
  it('filtra por id Y empresa_id — silenciosa (fire-and-forget)', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);
    await resolverAlertaStock('alerta-1', 'e1');
    expect(query.eq).toHaveBeenCalledWith('id', 'alerta-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
  });
});

describe('buscarOrdenRecienteProveedor', () => {
  it('filtra por empresa_id, proveedor_id, estado in [...] y created_at >= desde — silenciosa', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    const exist = await buscarOrdenRecienteProveedor('e1', 'p1', '2026-07-26T00:00:00.000Z');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('proveedor_id', 'p1');
    expect(query.in).toHaveBeenCalledWith('estado', ['borrador', 'pendiente_aprobacion', 'enviada']);
    expect(query.gte).toHaveBeenCalledWith('created_at', '2026-07-26T00:00:00.000Z');
    expect(exist).toBeNull();
  });
});

describe('insertarOrdenCompraAuto', () => {
  it('inserta y devuelve { data, error } — el handler chequea errOC || !orden', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'boom' } }));
    const { data, error } = await insertarOrdenCompraAuto({ empresa_id: 'e1', proveedor_id: 'p1' });
    expect(error).toBeTruthy();
    expect(data).toBeNull();
  });

  it('devuelve la orden creada si no hay error', async () => {
    const row = { id: 'oc1', numero: 'AUTO-X' };
    dbMock.from.mockReturnValue(fakeQuery({ data: row, error: null }));
    const { data } = await insertarOrdenCompraAuto({ empresa_id: 'e1' });
    expect(data).toEqual(row);
  });
});

describe('insertarItemsOrdenCompra', () => {
  it('inserta los ítems — silenciosa (fire-and-forget)', async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    dbMock.from.mockReturnValue({ insert });
    await insertarItemsOrdenCompra([{ orden_id: 'oc1', cantidad: 1 }]);
    expect(dbMock.from).toHaveBeenCalledWith('ordenes_compra_items');
    expect(insert).toHaveBeenCalledWith([{ orden_id: 'oc1', cantidad: 1 }]);
  });
});

describe('upsertAlertasStock', () => {
  it('upsert con onConflict producto_id,tipo,resuelta e ignoreDuplicates — silenciosa', async () => {
    const upsert = vi.fn(() => Promise.resolve({ error: null }));
    dbMock.from.mockReturnValue({ upsert });
    const filas = [{ empresa_id: 'e1', producto_id: 'p1', tipo: 'critico' }];
    await upsertAlertasStock(filas);
    expect(dbMock.from).toHaveBeenCalledWith('alertas_stock');
    expect(upsert).toHaveBeenCalledWith(filas, { onConflict: 'producto_id,tipo,resuelta', ignoreDuplicates: true });
  });
});

describe('obtenerOrdenParaEnviar', () => {
  it('filtra por id Y empresa_id, trae joins de empresa/proveedor — silenciosa (puede ser null)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    const orden = await obtenerOrdenParaEnviar('oc1', 'e1');
    expect(query.eq).toHaveBeenCalledWith('id', 'oc1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(orden).toBeNull();
  });
});

describe('listarItemsOrdenCompra', () => {
  it('filtra por orden_id (columna con FK real, no orden_compra_id) — silenciosa', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    await listarItemsOrdenCompra('oc1');
    expect(query.eq).toHaveBeenCalledWith('orden_id', 'oc1');
  });
});

describe('marcarOrdenEnviada / marcarAlertasResueltasPorOrden', () => {
  it('marcarOrdenEnviada filtra por id — silenciosa', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);
    await marcarOrdenEnviada('oc1');
    expect(dbMock.from).toHaveBeenCalledWith('ordenes_compra');
    expect(query.eq).toHaveBeenCalledWith('id', 'oc1');
  });

  it('marcarAlertasResueltasPorOrden filtra por orden_compra_id (columna real de alertas_stock) — silenciosa', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);
    await marcarAlertasResueltasPorOrden('oc1');
    expect(dbMock.from).toHaveBeenCalledWith('alertas_stock');
    expect(query.eq).toHaveBeenCalledWith('orden_compra_id', 'oc1');
  });
});
