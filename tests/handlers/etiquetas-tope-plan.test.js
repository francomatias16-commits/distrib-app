// tests/handlers/etiquetas-tope-plan.test.js
//
// Etapa 8 del plan (auditoría plan trial vs. recursos con costo real,
// 2026-09): la generación de etiquetas de precio/código de barras
// (POST /api/etiquetas/productos) no tenía ningún tope por plan. Se
// agregó max_etiquetas_generaciones en planes_limites (trial: 1) + la
// tabla etiquetas_generaciones (historial, no existía) + el recurso
// 'etiquetas_generaciones' en chequear_limite_plan (migración 576) + el
// corte en el handler, que además registra cada generación exitosa.

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(),
}));

vi.mock('../../lib/permisos-service.js', () => ({
  puede: vi.fn(() => true), // el gate de rol no es lo que se testea acá
}));

const productosMock = vi.hoisted(() => ({
  resultado: [{ id: 'p1', nombre: 'Producto 1', precio: 1000 }],
}));

const registroMock = vi.hoisted(() => ({ llamadas: [] }));

vi.mock('../../lib/repos/productos.js', () => ({
  obtenerProductosParaEtiquetas: vi.fn(() => Promise.resolve(productosMock.resultado)),
}));

vi.mock('../../lib/repos/etiquetas.js', () => ({
  obtenerConfigEtiquetas: vi.fn(),
  guardarConfigEtiquetas: vi.fn(),
  registrarGeneracionEtiquetas: vi.fn((empresa_id, usuario_id, cantidad) => {
    registroMock.llamadas.push({ empresa_id, usuario_id, cantidad });
    return Promise.resolve();
  }),
}));

const limiteMock = vi.hoisted(() => ({ permite: true, llamadas: [] }));

const LimitePlanErrorMock = vi.hoisted(() => class LimitePlanErrorMock extends Error {
  constructor(info) {
    super('Límite de plan alcanzado');
    this.name = 'LimitePlanError';
    this.code = 'LIMITE_PLAN_ALCANZADO';
    this.info = info;
  }
});

vi.mock('../../lib/plan-limits.js', () => ({
  exigirLimitePlan: vi.fn((_db, empresaId, recurso) => {
    limiteMock.llamadas.push({ empresaId, recurso });
    if (recurso === 'etiquetas_generaciones' && !limiteMock.permite) {
      return Promise.reject(new LimitePlanErrorMock({ recurso: 'etiquetas_generaciones', actual: 1, limite: 1, tier: 'trial' }));
    }
    return Promise.resolve();
  }),
  LimitePlanError: LimitePlanErrorMock,
}));

const { verificarToken } = await import('../../lib/auth-helpers.js');
const { default: handler } = await import('../../lib/handlers/etiquetas.js');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  return res;
}

const EMPRESA = 'empresa-trial-etq-1';

function fakeReq(ids) {
  return { method: 'POST', query: { _svc: 'productos' }, body: { ids } };
}

beforeEach(() => {
  verificarToken.mockReset();
  verificarToken.mockResolvedValue({ id: 'u-vend', rol: 'vendedor', empresa_id: EMPRESA });
  limiteMock.permite = true;
  limiteMock.llamadas = [];
  registroMock.llamadas = [];
});

describe('POST /api/etiquetas/productos — tope de plan trial (1 generación, migración 576)', () => {
  it('bloquea con 403 y no trae productos cuando el plan ya alcanzó el tope de generaciones', async () => {
    limiteMock.permite = false;
    const res = mockRes();

    await handler(fakeReq(['p1']), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('LIMITE_PLAN_ALCANZADO');
    expect(registroMock.llamadas).toHaveLength(0);
  });

  it('consulta el tope con el recurso "etiquetas_generaciones" para la empresa de la sesión', async () => {
    limiteMock.permite = false;
    const res = mockRes();

    await handler(fakeReq(['p1']), res);

    expect(limiteMock.llamadas).toContainEqual({ empresaId: EMPRESA, recurso: 'etiquetas_generaciones' });
  });

  it('cuando el plan lo permite, responde ok y registra la generación', async () => {
    limiteMock.permite = true;
    const res = mockRes();

    await handler(fakeReq(['p1', 'p2']), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    // registrarGeneracionEtiquetas es fire-and-forget — esperar un tick
    // para que la promesa encolada se resuelva antes de verificarla.
    await new Promise((r) => setTimeout(r, 0));
    expect(registroMock.llamadas).toContainEqual({ empresa_id: EMPRESA, usuario_id: 'u-vend', cantidad: 2 });
  });
});
