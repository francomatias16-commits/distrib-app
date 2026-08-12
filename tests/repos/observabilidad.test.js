// tests/repos/observabilidad.test.js
//
// PLAN_ERP_SINCRONIZACION_2026.md — Fase 8 (observabilidad continua).
// Foco: cada query filtra por empresa_id (el mismo tipo de bug que ya
// auditó AUDITORIA_2026 — una fuga cross-tenant acá mostraría a un dueño
// eventos de otra empresa) y usa las columnas correctas de eventos_negocio
// (creado_en para la ventana de resumen, procesado_en para "en error
// prolongado" — no son intercambiables, ver comentario en el repo).
//
// Mismo query builder falso que tests/repos/stock.js.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  obtenerEventosParaResumen,
  obtenerEventosEnErrorProlongado,
  obtenerEventosPedidoParaMetricas,
} = await import('../../lib/repos/observabilidad.js');

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq:     vi.fn(() => obj),
    in:     vi.fn(() => obj),
    gte:    vi.fn(() => obj),
    lt:     vi.fn(() => obj),
    order:  vi.fn(() => obj),
    limit:  vi.fn(() => Promise.resolve(result)),
    then:   (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
});

describe('obtenerEventosParaResumen', () => {
  it('filtra por empresa_id y por creado_en >= desde, ordenado desc', async () => {
    const query = fakeQuery({ data: [{ tipo_evento: 'pedido_creado', estado: 'procesado' }], error: null });
    dbMock.from.mockReturnValue(query);

    const { data, error } = await obtenerEventosParaResumen('empresa-1', '2026-08-01T00:00:00.000Z');

    expect(dbMock.from).toHaveBeenCalledWith('eventos_negocio');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.gte).toHaveBeenCalledWith('creado_en', '2026-08-01T00:00:00.000Z');
    expect(query.order).toHaveBeenCalledWith('creado_en', { ascending: false });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});

describe('obtenerEventosEnErrorProlongado', () => {
  it('filtra por empresa_id, estado=error y procesado_en < umbral (no creado_en)', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerEventosEnErrorProlongado('empresa-1', '2026-08-02T12:00:00.000Z', 20);

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.eq).toHaveBeenCalledWith('estado', 'error');
    expect(query.lt).toHaveBeenCalledWith('procesado_en', '2026-08-02T12:00:00.000Z');
    expect(query.order).toHaveBeenCalledWith('procesado_en', { ascending: true });
  });

  it('no filtra por empresa de otra compañía — cada llamada es por una sola empresa_id', async () => {
    const query = fakeQuery({ data: [{ id: 'ev-1' }], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerEventosEnErrorProlongado('empresa-2', '2026-08-02T12:00:00.000Z', 20);

    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-2');
    expect(query.eq).not.toHaveBeenCalledWith('empresa_id', 'empresa-1');
  });
});

describe('obtenerEventosPedidoParaMetricas', () => {
  it('sólo pide pedido_creado y pedido_facturado, filtrado por empresa y ventana', async () => {
    const query = fakeQuery({ data: [], error: null });
    dbMock.from.mockReturnValue(query);

    await obtenerEventosPedidoParaMetricas('empresa-1', '2026-08-01T00:00:00.000Z');

    expect(query.in).toHaveBeenCalledWith('tipo_evento', ['pedido_creado', 'pedido_facturado']);
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'empresa-1');
    expect(query.gte).toHaveBeenCalledWith('creado_en', '2026-08-01T00:00:00.000Z');
    expect(query.order).toHaveBeenCalledWith('creado_en', { ascending: true });
  });
});
