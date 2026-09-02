// tests/handlers/chofer-clientes-huso-horario.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🟠 Alto #7. `GET /api/chofer/clientes`
// calculaba "hoy" con `new Date().toISOString().slice(0,10)`, que da la
// fecha en UTC. El server (Vercel) corre en UTC y Argentina es UTC-3, así
// que entre las 21:00 y las 23:59 hora ART esa fecha ya es el día
// siguiente — el chofer entraba a la ruta del día y no veía sus propios
// clientes (o veía los del día equivocado). El fix (mismo que ya tenía
// GET /api/chofer/remitos) sube `hoyArgentina()` a scope de módulo,
// calculando la fecha con el timezone 'America/Argentina/Buenos_Aires'.
//
// Este test fija el contrato: con la hora del sistema en UTC tal que ya
// son las 00:xx ART del día siguiente (21:00 UTC = 21:00, +3h = 00:xx ART
// del día D+1), `listarClientesConPedidosActivos` debe ser invocada con
// la fecha D+1 (ART), no con la fecha D (UTC) que devolvería
// `toISOString()`.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const repoState = vi.hoisted(() => ({
  perfilChofer: { id: 'chofer-1', empresa_id: 'empresa-1', rol: 'chofer' },
  rutasHoy: [{ id: 'ruta-1' }],
  entregas: [{ pedido_id: 'pedido-1' }],
  llamadasListarClientes: [], // [{ empresa_id, fecha, pedidoIdsPropios }]
}));

vi.mock('../../lib/repos/pedidos.js', async () => {
  const real = await vi.importActual('../../lib/repos/pedidos.js');
  return {
    ...real,
    obtenerPerfilChofer: vi.fn(() => Promise.resolve(repoState.perfilChofer)),
    listarRutasDelDia: vi.fn(() => Promise.resolve({ data: repoState.rutasHoy })),
    listarEntregasPorRutas: vi.fn(() => Promise.resolve({ data: repoState.entregas })),
    listarClientesConPedidosActivos: vi.fn((empresa_id, fecha, pedidoIdsPropios) => {
      repoState.llamadasListarClientes.push({ empresa_id, fecha, pedidoIdsPropios });
      return Promise.resolve({ data: [], error: null });
    }),
  };
});

vi.mock('../../lib/permisos-service.js', () => ({
  puede: vi.fn(() => true),
  rolesDe: vi.fn(() => []),
}));

const authState = vi.hoisted(() => ({ user: { id: 'user-1' } }));
vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: authState.user }, error: null })) },
  }),
}));

vi.mock('../../lib/security-headers.js', () => ({ applySecurityHeaders: vi.fn(), applyCorsHeaders: vi.fn() }));
vi.mock('../../lib/facturas.js', () => ({ emitirFactura: vi.fn() }));
vi.mock('../../lib/eventos.js', () => ({ emitirEvento: vi.fn(), usaDespachadorEventos: vi.fn(() => false) }));
vi.mock('../../lib/email.js', () => ({ enviarEmailConfirmacionPedido: vi.fn(), enviarEmailDespacho: vi.fn() }));
vi.mock('../../lib/rate-limit.js', () => ({ rateLimit: () => vi.fn().mockResolvedValue(false) }));
vi.mock('../../lib/plan-limits.js', () => ({ exigirLimitePlan: vi.fn(), LimitePlanError: class extends Error {} }));
vi.mock('../../lib/handlers/_push.js', () => ({
  notificarPedidoEnCamino: vi.fn(), notificarPuntosGanados: vi.fn(), enviarPush: vi.fn(),
}));
vi.mock('../../lib/handlers/_auto-push.js', () => ({ notifAuto: vi.fn().mockResolvedValue(null) }));
vi.mock('../../lib/error-response.js', () => ({ errorSeguro: vi.fn((res) => res.status(500).json({ error: 'err' })) }));
vi.mock('../../lib/repos/pagos.js', () => ({
  existeIntegracionMPActiva: vi.fn(), esPedidoPilotoWhatsApp: vi.fn(),
}));
vi.mock('../../lib/repos/combos.js', () => ({ obtenerCombosParaValidarPedido: vi.fn() }));
vi.mock('../../lib/repos/productos.js', () => ({
  obtenerNombreProducto: vi.fn(),
  obtenerProductosParaValidarPedido: vi.fn(),
  obtenerProductosParaCotizarConCosto: vi.fn(),
  buscarProductosParaRemito: vi.fn(),
  obtenerProveedorDefaultPorProductos: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../lib/repos/audit.js', () => ({ registrarAuditoria: vi.fn() }));
vi.mock('../../lib/utils/storage-urls.js', () => ({
  firmarCampoUrl: vi.fn((v) => v), firmarCampoUrlEnLista: vi.fn((v) => v),
}));

const handler = (await import('../../lib/handlers/pedidos.js')).default;

function mockReq(overrides = {}) {
  return {
    method: 'GET',
    query: { _svc: 'chofer', _ruta: 'clientes' },
    headers: { authorization: 'Bearer token-valido' },
    body: {},
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  repoState.llamadasListarClientes = [];
  repoState.perfilChofer = { id: 'chofer-1', empresa_id: 'empresa-1', rol: 'chofer' };
  repoState.rutasHoy = [{ id: 'ruta-1' }];
  repoState.entregas = [{ pedido_id: 'pedido-1' }];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/chofer/clientes — regresión hallazgo #7 (fecha en UTC en vez de ART)', () => {
  it('a la 01:00 UTC (22:00 ART del día anterior) usa la fecha ART, no la fecha UTC', async () => {
    // 01:00 UTC del 11/03 = 22:00 ART del 10/03 (ART = UTC-3): el caso que
    // el comentario del fix describe — entre 21:00 y 23:59 ART, la fecha
    // UTC ya cayó en el día siguiente.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T01:00:00.000Z'));

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(repoState.llamadasListarClientes).toHaveLength(1);
    const fechaUsada = repoState.llamadasListarClientes[0].fecha;

    // La fecha UTC (bug) hubiera sido '2026-03-11'; la fecha ART (fix) es '2026-03-10'.
    expect(fechaUsada).toBe('2026-03-10');
    expect(fechaUsada).not.toBe('2026-03-11');
  });

  it('a las 10:00 UTC (07:00 ART, mismo día) usa esa misma fecha en ambos husos', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));

    const res = mockRes();
    await handler(mockReq(), res);

    expect(repoState.llamadasListarClientes).toHaveLength(1);
    expect(repoState.llamadasListarClientes[0].fecha).toBe('2026-03-10');
  });
});
