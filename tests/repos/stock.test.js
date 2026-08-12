// tests/repos/stock.test.js
//
// Fase 7, paso 5 — `stock.js` no tenía tests de repo (checklist punto 5).
// Igual que en productos.test.js/cta-cte.test.js, cada test documenta en su
// descripción la política de error de la función que cubre (silenciosa vs.
// propagada) porque en este repo conviven ambas a propósito, replicando el
// comportamiento del handler original (ver comentarios en
// lib/repos/stock.js). Foco en filtro por `empresa_id`/pertenencia a la
// empresa en cada función que lo recibe — la clase de bug ya auditada en
// AUDITORIA_2026 que una capa de repos mal migrada podría reintroducir.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  listarDepositosIds, existeDepositoEnEmpresa,
  obtenerCantidadStock, listarStockPorProducto, buscarStockPaginado,
  listarMovimientos,
  obtenerLotePorId, listarLotes, crearLote, obtenerLoteParaBaja, obtenerLoteCantidad,
  actualizarLote, eliminarLote, listarLotesFefo,
  obtenerPedidoEstado, listarItemsPedido, listarPedidosHistoricoCliente,
  limpiarSugerenciasExpiradas, guardarSugerencias,
  listarCategoriasConProductos,
  listarOfertasParaProductos, listarOfertasPorLotes, listarOfertasActivas,
  obtenerReglas, guardarReglas,
} = await import('../../lib/repos/stock.js');

// Mismo query builder falso que tests/repos/productos.test.js y
// tests/repos/cta-cte.test.js — encadena cualquier método y resuelve al
// `result` pasado, ya sea vía `.single()`/`.maybeSingle()` o directamente
// como thenable (`await query`) cuando la cadena termina en `.range()`/
// `.order()`/etc. sin un terminal explícito.
function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    insert:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    upsert:      vi.fn(() => obj),
    delete:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    in:          vi.fn(() => obj),
    not:         vi.fn(() => obj),
    is:          vi.fn(() => obj),
    gt:          vi.fn(() => obj),
    gte:         vi.fn(() => obj),
    lt:          vi.fn(() => obj),
    lte:         vi.fn(() => obj),
    limit:       vi.fn(() => obj),
    order:       vi.fn(() => obj),
    range:       vi.fn(() => obj),
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

// ── Depósitos ─────────────────────────────────────────────────────────────

describe('listarDepositosIds', () => {
  it('filtra por empresa_id y devuelve solo los ids', async () => {
    const query = fakeQuery({ data: [{ id: 'd1' }, { id: 'd2' }], error: null });
    dbMock.from.mockReturnValue(query);

    const ids = await listarDepositosIds('empresa-1');

    expect(dbMock.from).toHaveBeenCalledWith('depositos');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(ids).toEqual(['d1', 'd2']);
  });

  it('devuelve [] (no lanza) si la query falla — mismo comportamiento silencioso que el original', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await listarDepositosIds('empresa-1')).toEqual([]);
  });
});

describe('existeDepositoEnEmpresa', () => {
  it('filtra por id Y empresa_id (Etapa 2, Hallazgo 2)', async () => {
    const query = fakeQuery({ data: { id: 'd1' }, error: null });
    dbMock.from.mockReturnValue(query);

    const existe = await existeDepositoEnEmpresa('d1', 'empresa-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'd1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(existe).toBe(true);
  });

  it('devuelve false si el depósito es de otra empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));

    expect(await existeDepositoEnEmpresa('d1', 'empresa-ajena')).toBe(false);
  });
});

// ── Stock ─────────────────────────────────────────────────────────────────

describe('obtenerCantidadStock', () => {
  it('filtra por producto_id y deposito_id, devuelve la cantidad', async () => {
    const query = fakeQuery({ data: { cantidad: 42 }, error: null });
    dbMock.from.mockReturnValue(query);

    const cantidad = await obtenerCantidadStock('p1', 'd1');

    expect(query.eq).toHaveBeenCalledWith('producto_id', 'p1');
    expect(query.eq).toHaveBeenCalledWith('deposito_id', 'd1');
    expect(cantidad).toBe(42);
  });

  it('devuelve null (no lanza) si no hay fila o la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    expect(await obtenerCantidadStock('p1', 'd1')).toBeNull();
  });
});

describe('listarStockPorProducto', () => {
  it('lista todas las filas de stock del producto (sin filtro de empresa — el producto ya viene validado por el caller)', async () => {
    const filas = [{ cantidad: 10, cantidad_reservada: 2, cantidad_disponible: 8 }];
    const query = fakeQuery({ data: filas, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarStockPorProducto('p1');

    expect(query.eq).toHaveBeenCalledWith('producto_id', 'p1');
    expect(data).toEqual(filas);
  });

  it('devuelve [] (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await listarStockPorProducto('p1')).toEqual([]);
  });
});

describe('buscarStockPaginado', () => {
  it('scopea siempre por depIds (los depósitos de la empresa) y pagina con count', async () => {
    const query = fakeQuery({ data: [{ id: 's1' }], error: null, count: 1 });
    dbMock.from.mockReturnValue(query);

    const { data, count } = await buscarStockPaginado({
      depIds: ['d1', 'd2'], producto_id: null, deposito_id: null,
      categoria_id: null, ids: null, estado: null, offset: 0, limitNum: 50,
    });

    expect(dbMock.from).toHaveBeenCalledWith('stock');
    expect(query.in).toHaveBeenCalledWith('deposito_id', ['d1', 'd2']);
    expect(query.eq).toHaveBeenCalledWith('productos.activo', true);
    expect(query.range).toHaveBeenCalledWith(0, 49);
    expect(data).toEqual([{ id: 's1' }]);
    expect(count).toBe(1);
  });

  it('aplica el filtro de ids resueltos por búsqueda cuando se pasan', async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    dbMock.from.mockReturnValue(query);

    await buscarStockPaginado({
      depIds: ['d1'], ids: ['p1', 'p2'], offset: 0, limitNum: 50,
    });

    expect(query.in).toHaveBeenCalledWith('producto_id', ['p1', 'p2']);
  });

  it("estado 'critico' filtra cantidad_disponible <= 0", async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    dbMock.from.mockReturnValue(query);

    await buscarStockPaginado({ depIds: ['d1'], estado: 'critico', offset: 0, limitNum: 50 });

    expect(query.lte).toHaveBeenCalledWith('cantidad_disponible', 0);
  });

  it('propaga error (el handler lo maneja con errorSeguro)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' }, count: null }));

    const { error } = await buscarStockPaginado({ depIds: ['d1'], offset: 0, limitNum: 50 });

    expect(error).toEqual({ message: 'timeout' });
  });
});

// ── Movimientos de stock ─────────────────────────────────────────────────

describe('listarMovimientos', () => {
  it('scopea por depIds y pagina con count', async () => {
    const query = fakeQuery({ data: [{ id: 'm1' }], error: null, count: 1 });
    dbMock.from.mockReturnValue(query);

    const { data, count } = await listarMovimientos({ depIds: ['d1'], producto_id: null, offset: 0, limitNum: 100 });

    expect(dbMock.from).toHaveBeenCalledWith('movimientos_stock');
    expect(query.in).toHaveBeenCalledWith('deposito_id', ['d1']);
    expect(data).toEqual([{ id: 'm1' }]);
    expect(count).toBe(1);
  });

  it('filtra por producto_id cuando se pasa', async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    dbMock.from.mockReturnValue(query);

    await listarMovimientos({ depIds: ['d1'], producto_id: 'p1', offset: 0, limitNum: 100 });

    expect(query.eq).toHaveBeenCalledWith('producto_id', 'p1');
  });
});

// ── Lotes ─────────────────────────────────────────────────────────────────

describe('obtenerLotePorId', () => {
  it('filtra por id Y empresa_id, devuelve null si no matchea (sin distinguir motivo, igual que el original)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));

    expect(await obtenerLotePorId('lote-1', 'empresa-ajena')).toBeNull();
  });

  it('devuelve el lote si pertenece a la empresa', async () => {
    const lote = { id: 'lote-1', numero_lote: 'L001' };
    const query = fakeQuery({ data: lote, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerLotePorId('lote-1', 'empresa-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'lote-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual(lote);
  });
});

describe('listarLotes', () => {
  beforeEach(() => {
    // FIX (mismo motivo que en repos/automatizacion.js): listarLotes dispara
    // antes un RPC fire-and-forget (actualizar_estado_lotes) encadenado con
    // .catch() directo — sin un valor resuelto acá, db.rpc(...) devuelve
    // undefined y .catch() explota.
    dbMock.rpc.mockResolvedValue({ data: null, error: null });
  });

  it('siempre filtra por empresa_id y pagina con count', async () => {
    const query = fakeQuery({ data: [{ id: 'l1' }], error: null, count: 1 });
    dbMock.from.mockReturnValue(query);

    const { data, count } = await listarLotes({ empresa_id: 'empresa-1', offset: 0, limitNum: 100 });

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual([{ id: 'l1' }]);
    expect(count).toBe(1);
  });

  it("estado 'vencido' filtra fecha_vencimiento < hoy y cantidad > 0", async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    dbMock.from.mockReturnValue(query);

    await listarLotes({ empresa_id: 'empresa-1', estado: 'vencido', offset: 0, limitNum: 100 });

    expect(query.lt).toHaveBeenCalled();
    expect(query.gt).toHaveBeenCalledWith('cantidad', 0);
  });

  it("estado 'agotado' filtra cantidad = 0", async () => {
    const query = fakeQuery({ data: [], error: null, count: 0 });
    dbMock.from.mockReturnValue(query);

    await listarLotes({ empresa_id: 'empresa-1', estado: 'agotado', offset: 0, limitNum: 100 });

    expect(query.eq).toHaveBeenCalledWith('cantidad', 0);
  });
});

describe('crearLote', () => {
  it('inserta el payload tal cual y devuelve el lote creado', async () => {
    const query = fakeQuery({ data: { id: 'lote-nuevo' }, error: null });
    dbMock.from.mockReturnValue(query);

    const payload = { empresa_id: 'empresa-1', producto_id: 'p1', cantidad: 10 };
    const { data, error } = await crearLote(payload);

    expect(query.insert).toHaveBeenCalledWith(payload);
    expect(data).toEqual({ id: 'lote-nuevo' });
    expect(error).toBeNull();
  });

  it('propaga error (el handler lo maneja con errorSeguro)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'producto_id inválido' } }));

    const { error } = await crearLote({});

    expect(error).toEqual({ message: 'producto_id inválido' });
  });
});

describe('obtenerLoteParaBaja', () => {
  it('filtra por id Y empresa_id, trae solo id/numero_lote', async () => {
    const query = fakeQuery({ data: { id: 'l1', numero_lote: 'L001' }, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerLoteParaBaja('l1', 'empresa-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'l1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual({ id: 'l1', numero_lote: 'L001' });
  });

  it('devuelve null si el lote es de otra empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));

    expect(await obtenerLoteParaBaja('l1', 'empresa-ajena')).toBeNull();
  });
});

describe('obtenerLoteCantidad', () => {
  it('filtra por id Y empresa_id, trae solo id/cantidad (reusado por PATCH y DELETE)', async () => {
    const query = fakeQuery({ data: { id: 'l1', cantidad: 0 }, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerLoteCantidad('l1', 'empresa-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'l1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual({ id: 'l1', cantidad: 0 });
  });

  it('devuelve null si el lote no pertenece a la empresa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'no rows' } }));

    expect(await obtenerLoteCantidad('l1', 'empresa-ajena')).toBeNull();
  });
});

describe('actualizarLote', () => {
  it('actualiza por id y propaga error', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    const { error } = await actualizarLote('l1', { cantidad: 5 });

    expect(query.update).toHaveBeenCalledWith({ cantidad: 5 });
    expect(query.eq).toHaveBeenCalledWith('id', 'l1');
    expect(error).toBeNull();
  });
});

describe('eliminarLote', () => {
  it('elimina por id y propaga error', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    const { error } = await eliminarLote('l1');

    expect(query.delete).toHaveBeenCalled();
    expect(query.eq).toHaveBeenCalledWith('id', 'l1');
    expect(error).toBeNull();
  });
});

describe('listarLotesFefo', () => {
  it('filtra por empresa_id Y producto_id, ordena FEFO (vencimiento asc), excluye agotados/sin vencer', async () => {
    const lotes = [{ id: 'l1', fecha_vencimiento: '2026-09-01' }];
    const query = fakeQuery({ data: lotes, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarLotesFefo('empresa-1', 'p1', '2026-08-01');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('producto_id', 'p1');
    expect(query.order).toHaveBeenCalledWith('fecha_vencimiento', { ascending: true });
    expect(data).toEqual(lotes);
  });

  it('devuelve [] (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await listarLotesFefo('empresa-1', 'p1', '2026-08-01')).toEqual([]);
  });
});

// ── Pedidos / pedido_items ────────────────────────────────────────────────

describe('obtenerPedidoEstado', () => {
  it('filtra por id Y empresa_id', async () => {
    const query = fakeQuery({ data: { id: 'pe1', estado: 'confirmado' }, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await obtenerPedidoEstado('pe1', 'empresa-1');

    expect(query.eq).toHaveBeenCalledWith('id', 'pe1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual({ id: 'pe1', estado: 'confirmado' });
  });
});

describe('listarItemsPedido', () => {
  it('trae los items con nombre/código de producto', async () => {
    const items = [{ producto_id: 'p1', cantidad: 3 }];
    const query = fakeQuery({ data: items, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await listarItemsPedido('pe1');

    expect(query.eq).toHaveBeenCalledWith('pedido_id', 'pe1');
    expect(data).toEqual(items);
  });
});

describe('listarPedidosHistoricoCliente', () => {
  it('filtra por cliente_id Y empresa_id, desde la fecha dada, solo entregados', async () => {
    const pedidos = [{ id: 'pe1', pedido_items: [] }];
    const query = fakeQuery({ data: pedidos, error: null });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await listarPedidosHistoricoCliente('empresa-1', 'cliente-1', '2026-05-01');

    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'cliente-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('estado', 'entregado');
    expect(query.gte).toHaveBeenCalledWith('created_at', '2026-05-01');
    expect(data).toEqual(pedidos);
    expect(error).toBeNull();
  });

  it('propaga error tal cual (el handler tiene su propio mensaje, no errorSeguro genérico)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    const { error } = await listarPedidosHistoricoCliente('empresa-1', 'cliente-1', '2026-05-01');

    expect(error).toEqual({ message: 'timeout' });
  });
});

// ── Sugerencias de pedido ────────────────────────────────────────────────

describe('limpiarSugerenciasExpiradas', () => {
  it('filtra por cliente_id Y empresa_id y por expira_at vencido', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    await limpiarSugerenciasExpiradas('empresa-1', 'cliente-1');

    expect(query.eq).toHaveBeenCalledWith('cliente_id', 'cliente-1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.lt).toHaveBeenCalledWith('expira_at', expect.any(String));
  });
});

describe('guardarSugerencias', () => {
  it('inserta las filas tal cual', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);

    const rows = [{ cliente_id: 'c1', producto_id: 'p1' }];
    const { error } = await guardarSugerencias(rows);

    expect(query.insert).toHaveBeenCalledWith(rows);
    expect(error).toBeNull();
  });

  it('propaga error (el handler tiene su propio mensaje)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ error: { message: 'constraint violada' } }));

    const { error } = await guardarSugerencias([]);

    expect(error).toEqual({ message: 'constraint violada' });
  });
});

// ── Categorías ────────────────────────────────────────────────────────────

describe('listarCategoriasConProductos', () => {
  it('filtra por empresa_id, solo activas con al menos un producto activo', async () => {
    const categorias = [{ id: 'cat1', nombre: 'Bebidas' }];
    const query = fakeQuery({ data: categorias, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await listarCategoriasConProductos('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activa', true);
    expect(query.eq).toHaveBeenCalledWith('productos.activo', true);
    expect(data).toEqual(categorias);
  });
});

// ── Ofertas de liquidación ────────────────────────────────────────────────

describe('listarOfertasParaProductos', () => {
  it('filtra por empresa_id, activas, no vencidas, y por el lote de ids', async () => {
    const ofertas = [{ producto_id: 'p1', descuento_pct: 10 }];
    const query = fakeQuery({ data: ofertas, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarOfertasParaProductos('empresa-1', ['p1', 'p2']);

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activa', true);
    expect(query.in).toHaveBeenCalledWith('producto_id', ['p1', 'p2']);
    expect(data).toEqual(ofertas);
  });

  it('devuelve [] (no lanza) si la query falla', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'timeout' } }));

    expect(await listarOfertasParaProductos('empresa-1', ['p1'])).toEqual([]);
  });
});

describe('listarOfertasPorLotes', () => {
  it('filtra por lote_id Y empresa_id, activas', async () => {
    const ofertas = [{ producto_id: 'p1' }];
    const query = fakeQuery({ data: ofertas, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await listarOfertasPorLotes('empresa-1', ['lote-1']);

    expect(query.in).toHaveBeenCalledWith('lote_id', ['lote-1']);
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual(ofertas);
  });
});

describe('listarOfertasActivas', () => {
  it('filtra por empresa_id y activas, ordena por vencimiento asc', async () => {
    const ofertas = [{ id: 'of1' }];
    const query = fakeQuery({ data: ofertas, error: null });
    dbMock.from.mockReturnValue(query);

    const { data } = await listarOfertasActivas('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('activa', true);
    expect(query.order).toHaveBeenCalledWith('vence_oferta_at', { ascending: true });
    expect(data).toEqual(ofertas);
  });
});

// ── Reglas de liquidación ─────────────────────────────────────────────────

describe('obtenerReglas', () => {
  it('filtra por empresa_id, devuelve null si nunca configuró', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));

    expect(await obtenerReglas('empresa-1')).toBeNull();
  });

  it('devuelve las reglas de la empresa', async () => {
    const reglas = { empresa_id: 'empresa-1', dias_alerta: 7 };
    const query = fakeQuery({ data: reglas, error: null });
    dbMock.from.mockReturnValue(query);

    const data = await obtenerReglas('empresa-1');

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(data).toEqual(reglas);
  });
});

describe('guardarReglas', () => {
  it('hace upsert por empresa_id (onConflict) y devuelve la fila guardada', async () => {
    const reglas = { empresa_id: 'empresa-1', dias_alerta: 5 };
    const query = fakeQuery({ data: reglas, error: null });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await guardarReglas(reglas);

    expect(query.upsert).toHaveBeenCalledWith(reglas, { onConflict: 'empresa_id' });
    expect(data).toEqual(reglas);
    expect(error).toBeNull();
  });

  it('propaga error (el handler lo maneja con errorSeguro)', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: { message: 'dias_alerta inválido' } }));

    const { error } = await guardarReglas({});

    expect(error).toEqual({ message: 'dias_alerta inválido' });
  });
});
