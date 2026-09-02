// tests/handlers/pagos-tope-plan.test.js
//
// Hallazgo (auditoría plan trial vs. recursos pagos, 2026-09): MercadoPago
// no tenía NINGÚN corte por plan trial — el único bloqueo existente
// (esEmpresaDemo) protege la cuenta demo pública, no el plan contratado.
// Se agregó permite_mercadopago en planes_limites (trial: false) + el
// recurso 'mercadopago' en chequear_limite_plan + bloqueadoPorPlanMercadoPago()
// en lib/handlers/pagos.js, aplicado en los 4 puntos de entrada que tocan
// MercadoPago (config, OAuth iniciar/callback, QR setup) y, en profundidad,
// en _generarPreferenciaPago — el punto real donde se dispara el cobro,
// para que ni una integración ya conectada (de antes de bajar el plan, por
// ejemplo) pueda cobrar en trial.
//
// Este archivo cubre el punto de _generarPreferenciaPago (vía el endpoint
// público `_svc=publico`, que no requiere mockear autenticarAdmin) — mismo
// esqueleto que pagos-guard-publico.test.js, que cubre el guard de piloto
// de WhatsApp y mockea exigirLimitePlan como no-op a propósito para no
// pisarse con este archivo.

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

const pedidoPublicoMock = vi.hoisted(() => ({
  resultado: {
    data: { id: 'ped1', empresa_id: 'empresa-trial-1', cliente_id: 'c1', total: 1000, estado: 'confirmado', generado_automatico: true },
    error: null,
  },
}));

vi.mock('../../lib/repos/pedidos.js', () => ({
  obtenerPedidoParaPagoPublico: vi.fn(() => Promise.resolve(pedidoPublicoMock.resultado)),
}));

vi.mock('../../lib/repos/pagos.js', async () => {
  const real = await vi.importActual('../../lib/repos/pagos.js');
  return {
    esPedidoPilotoWhatsApp: real.esPedidoPilotoWhatsApp,
    obtenerTransaccionPendientePorPedido: vi.fn(() => Promise.resolve(null)),
    obtenerItemsPedido: vi.fn(() => Promise.resolve([])),
    // Integración "activa" a propósito: el punto bajo prueba es defensa en
    // profundidad — debe cortar por plan aunque exista una integración de
    // MP ya conectada (ej. empresa que bajó de plan con MP ya configurado).
    obtenerIntegracionMPActiva: vi.fn(() => Promise.resolve({
      data: { access_token: 'token-real-cifrado', user_id_mp: 'mp-123' },
      error: null,
    })),
  };
});

vi.mock('node-fetch', () => ({ default: vi.fn() }));

const limiteMock = vi.hoisted(() => ({ permiteMP: true, llamadas: [] }));

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
    if (recurso === 'mercadopago' && !limiteMock.permiteMP) {
      return Promise.reject(new LimitePlanErrorMock({ recurso: 'mercadopago', actual: 1, limite: 0, tier: 'trial' }));
    }
    return Promise.resolve();
  }),
  LimitePlanError: LimitePlanErrorMock,
}));

vi.mock('../../lib/demo-mode.js', () => ({
  esEmpresaDemo: vi.fn().mockResolvedValue(false),
}));

const { default: handler } = await import('../../lib/handlers/pagos.js');

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function fakeReq(pedido_id) {
  return {
    method: 'POST',
    query: { _svc: 'publico' },
    body: { pedido_id },
    headers: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  limiteMock.permiteMP = true;
  limiteMock.llamadas = [];
});

describe('_generarPreferenciaPago — MercadoPago bloqueado en plan trial', () => {
  it('bloquea con 403 y no llega a construir la preferencia cuando el plan no permite MercadoPago (trial)', async () => {
    limiteMock.permiteMP = false;
    const res = fakeRes();

    await handler(fakeReq('ped1'), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/no está disponible en el plan Trial/i);
  });

  it('consulta el tope con el recurso "mercadopago" para la empresa del pedido', async () => {
    limiteMock.permiteMP = false;
    const res = fakeRes();

    await handler(fakeReq('ped1'), res);

    expect(limiteMock.llamadas).toContainEqual({ empresaId: 'empresa-trial-1', recurso: 'mercadopago' });
  });

  it('no bloquea (sigue de largo al flujo real de MP) cuando el plan sí permite MercadoPago', async () => {
    limiteMock.permiteMP = true;
    const res = fakeRes();

    await handler(fakeReq('ped1'), res);

    expect(res.statusCode).not.toBe(403);
  });

  it('el corte por plan es defensa en profundidad: bloquea aunque la empresa ya tenga una integración de MP activa', async () => {
    limiteMock.permiteMP = false;
    const { obtenerIntegracionMPActiva } = await import('../../lib/repos/pagos.js');
    const res = fakeRes();

    await handler(fakeReq('ped1'), res);

    expect(res.statusCode).toBe(403);
    // Ni siquiera debería haber llegado a consultar la integración: el
    // corte de plan está antes en _generarPreferenciaPago.
    expect(obtenerIntegracionMPActiva).not.toHaveBeenCalled();
  });
});
