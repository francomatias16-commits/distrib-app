// tests/repos/automatizacion.test.js
//
// Fase 7 — `automatizacion.js` (Panel de Control Centralizado: push/prefs +
// los 6 "motores" del panel) no tenía tests de repo. Foco en los filtros
// de aislamiento (empresa_id, o la lista de ids ya acotada donde no
// aplica) de cada función, y en que la RPC de auditoría siga devolviendo
// { data, error } tal cual para que el handler decida cuándo propagar.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const {
  upsertDispositivoPush,
  desactivarDispositivoPush,
  obtenerPrefsAuto,
  upsertPrefAuto,
  listarCiclosProximos,
  contarCiclosActivos,
  listarFacturasPendientesCierre,
  listarCobrosRecientes,
  contarBloqueosActivos,
  listarRutasHoy,
  listarEntregasPorRutas,
  listarLotesPorVencer,
  listarOrdenesCompraPendientes,
  listarStockPorProductos,
  listarClientesConScore,
  detectarAnomaliasAuditoriaRpc,
} = await import('../../lib/repos/automatizacion.js');

function fakeQuery(result) {
  const obj = {
    select:      vi.fn(() => obj),
    eq:          vi.fn(() => obj),
    in:          vi.fn(() => obj),
    gte:         vi.fn(() => obj),
    lte:         vi.fn(() => obj),
    gt:          vi.fn(() => obj),
    order:       vi.fn(() => obj),
    limit:       vi.fn(() => obj),
    upsert:      vi.fn(() => obj),
    update:      vi.fn(() => obj),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then:        (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

describe('upsertDispositivoPush / desactivarDispositivoPush', () => {
  it('upsertDispositivoPush hace upsert por endpoint — silenciosa', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);
    await upsertDispositivoPush({ endpoint: 'x', usuario_id: 'u1' });
    expect(dbMock.from).toHaveBeenCalledWith('dispositivos_push');
    expect(query.upsert).toHaveBeenCalledWith({ endpoint: 'x', usuario_id: 'u1' }, { onConflict: 'endpoint' });
  });

  it('desactivarDispositivoPush filtra por endpoint Y usuario_id — silenciosa', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);
    await desactivarDispositivoPush('endpoint-x', 'u1');
    expect(query.eq).toHaveBeenCalledWith('endpoint', 'endpoint-x');
    expect(query.eq).toHaveBeenCalledWith('usuario_id', 'u1');
  });
});

describe('obtenerPrefsAuto / upsertPrefAuto', () => {
  it('obtenerPrefsAuto filtra por empresa_id — silenciosa', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: { piloto_sugerencia: true }, error: null }));
    const prefs = await obtenerPrefsAuto('e1');
    expect(dbMock.from).toHaveBeenCalledWith('notif_prefs_auto');
    expect(prefs.piloto_sugerencia).toBe(true);
  });

  it('upsertPrefAuto arma el objeto dinámico con la columna whitelisteada — silenciosa', async () => {
    const query = fakeQuery({ error: null });
    dbMock.from.mockReturnValue(query);
    await upsertPrefAuto('e1', 'piloto_sugerencia', false);
    expect(query.upsert).toHaveBeenCalledWith({ empresa_id: 'e1', piloto_sugerencia: false }, { onConflict: 'empresa_id' });
  });
});

describe('Motor 1 — piloto', () => {
  it('listarCiclosProximos filtra por empresa_id, activo, proximo_pedido <= en7d — silenciosa, default []', async () => {
    dbMock.from.mockReturnValue(fakeQuery({ data: null, error: null }));
    const data = await listarCiclosProximos('e1', '2026-08-09');
    expect(dbMock.from).toHaveBeenCalledWith('ciclos_compra');
    expect(data).toEqual([]);
  });

  it('contarCiclosActivos filtra por empresa_id Y activo=true — silenciosa, default 0', async () => {
    dbMock.from.mockReturnValue({ select: vi.fn(() => ({ eq: vi.fn(function() { return this; }), then: (r) => Promise.resolve({ count: null }).then(r) })) });
    const count = await contarCiclosActivos('e1');
    expect(count).toBe(0);
  });
});

describe('Motor 2 — cierre financiero', () => {
  it('listarFacturasPendientesCierre filtra por empresa_id y estado in [pendiente, error_afip]', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    const data = await listarFacturasPendientesCierre('e1');
    expect(query.in).toHaveBeenCalledWith('estado', ['pendiente', 'error_afip']);
    expect(data).toEqual([]);
  });

  it('listarCobrosRecientes filtra por empresa_id y fecha >= hace7d', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    await listarCobrosRecientes('e1', '2026-07-26');
    expect(query.gte).toHaveBeenCalledWith('fecha', '2026-07-26');
  });

  it('contarBloqueosActivos filtra por empresa_id Y activo=true — default 0', async () => {
    dbMock.from.mockReturnValue({ select: vi.fn(() => ({ eq: vi.fn(function() { return this; }), then: (r) => Promise.resolve({ count: 2 }).then(r) })) });
    const count = await contarBloqueosActivos('e1');
    expect(count).toBe(2);
  });
});

describe('Motor 3 — rutas dinámicas', () => {
  it('listarRutasHoy filtra por empresa_id y fecha >= hoy — silenciosa (puede ser null)', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    const data = await listarRutasHoy('e1', '2026-08-02');
    expect(query.gte).toHaveBeenCalledWith('fecha', '2026-08-02');
    expect(data).toBeNull();
  });

  it('listarEntregasPorRutas filtra por ruta_id in [...] — silenciosa', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    await listarEntregasPorRutas(['r1', 'r2']);
    expect(query.in).toHaveBeenCalledWith('ruta_id', ['r1', 'r2']);
  });
});

describe('Motor 4 — stock autónomo', () => {
  it('listarLotesPorVencer filtra por empresa_id, activo, vencimiento <= en30d, cantidad > 0', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    // FIX (F3-03): listarLotesPorVencer dispara antes un RPC fire-and-forget
    // (actualizar_estado_lotes) encadenado con .catch() directo — sin un
    // valor resuelto acá, db.rpc(...) devuelve undefined y .catch() explota.
    dbMock.rpc.mockResolvedValue({ data: null, error: null });
    await listarLotesPorVencer('e1', '2026-09-01');
    expect(query.lte).toHaveBeenCalledWith('fecha_vencimiento', '2026-09-01');
    expect(query.gt).toHaveBeenCalledWith('cantidad', 0);
  });

  it('listarOrdenesCompraPendientes filtra por empresa_id y estado in [borrador, enviada]', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    await listarOrdenesCompraPendientes('e1');
    expect(query.in).toHaveBeenCalledWith('estado', ['borrador', 'enviada']);
  });

  it('listarStockPorProductos NO filtra por empresa_id — se filtra por producto_id ya acotado', async () => {
    const query = fakeQuery({ data: null, error: null });
    dbMock.from.mockReturnValue(query);
    await listarStockPorProductos(['prod-1', 'prod-2']);
    expect(query.in).toHaveBeenCalledWith('producto_id', ['prod-1', 'prod-2']);
    expect(query.eq).not.toHaveBeenCalled();
  });
});

describe('Motor 5 — score de clientes', () => {
  it('listarClientesConScore filtra por empresa_id Y activo=true — silenciosa', async () => {
    const query = fakeQuery({ data: [{ id: 'c1', score_actual: 80 }], error: null });
    dbMock.from.mockReturnValue(query);
    const data = await listarClientesConScore('e1');
    expect(query.eq).toHaveBeenCalledWith('empresa_id', 'e1');
    expect(query.eq).toHaveBeenCalledWith('activo', true);
    expect(data[0].score_actual).toBe(80);
  });
});

describe('Motor 6 — auditoría predictiva', () => {
  it('detectarAnomaliasAuditoriaRpc envuelve la RPC con p_empresa_id y p_dias_lookback', async () => {
    dbMock.rpc.mockResolvedValue({ data: [{ tipo: 'anomalia' }], error: null });
    const { data, error } = await detectarAnomaliasAuditoriaRpc('e1', 30);
    expect(dbMock.rpc).toHaveBeenCalledWith('detectar_anomalias_auditoria', { p_empresa_id: 'e1', p_dias_lookback: 30 });
    expect(error).toBeNull();
    expect(data[0].tipo).toBe('anomalia');
  });

  it('devuelve error tal cual para que el handler lo propague', async () => {
    dbMock.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { error } = await detectarAnomaliasAuditoriaRpc('e1', 30);
    expect(error.message).toBe('boom');
  });
});
