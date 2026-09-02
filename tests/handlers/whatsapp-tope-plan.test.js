// tests/handlers/whatsapp-tope-plan.test.js
//
// Etapa 8 del plan (auditoría plan trial vs. recursos con costo real,
// 2026-09): trial no tenía ningún tope de mensajes de WhatsApp salientes,
// más allá del interruptor global WA_NOTIF_SALIENTES_HABILITADAS (que es
// on/off para TODA empresa en el número compartido, no un tope por plan).
// Se agregó max_whatsapp_mensajes en planes_limites (trial: 10) + el
// recurso 'whatsapp_mensajes' en chequear_limite_plan (migración 576) +
// el corte en los dos puntos reales de envío: whatsappHandler (templates)
// y enviarTextoWhatsApp (texto libre del bot).
//
// Este archivo prueba el tope en sí (con exigirLimitePlan mockeado para
// simular "ya alcanzó el límite"). El guard de auth de whatsappHandler
// tiene su propia suite en whatsapp-notif-permisos.test.js, que mockea
// plan-limits.js como no-op a propósito para no pisarse con este archivo.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(),
}));

vi.mock('../../lib/demo-mode.js', () => ({
  esEmpresaDemo: vi.fn().mockResolvedValue(false),
  whatsappSimulado: () => ({ message_id: 'sim-bloqueado' }),
}));

// Credenciales de fallback (número compartido): con esto alcanza para
// pasar el chequeo de "WhatsApp configurado" y llegar al tope de plan.
vi.mock('../../lib/repos/whatsapp-bot.js', async () => {
  const real = await vi.importActual('../../lib/repos/whatsapp-bot.js');
  return {
    ...real,
    obtenerCredencialesWhatsapp: vi.fn(() => Promise.resolve({ data: null, error: 'sin fila propia' })),
  };
});

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
    if (recurso === 'whatsapp_mensajes' && !limiteMock.permite) {
      return Promise.reject(new LimitePlanErrorMock({ recurso: 'whatsapp_mensajes', actual: 26, limite: 10, tier: 'trial' }));
    }
    return Promise.resolve();
  }),
  LimitePlanError: LimitePlanErrorMock,
}));

const { verificarToken } = await import('../../lib/auth-helpers.js');
const { whatsappHandler } = await import('../../lib/handlers/notif.js');

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

const EMPRESA = 'empresa-trial-wa-1';
const BODY_OK = { template: 'pedido_despachado', telefono: '+5493405123456', params: {} };

let fetchOriginal;
beforeEach(() => {
  verificarToken.mockReset();
  verificarToken.mockResolvedValue({ id: 'u-vend', rol: 'vendedor', empresa_id: EMPRESA });
  limiteMock.permite = true;
  limiteMock.llamadas = [];
  process.env.WA_PHONE_NUMBER_ID = 'pnid-test';
  process.env.WA_ACCESS_TOKEN = 'token-test';
  process.env.WA_NOTIF_SALIENTES_HABILITADAS = 'true'; // para no confundir este bloqueo con el de enviosHabilitados
  fetchOriginal = global.fetch;
  global.fetch = vi.fn(() => { throw new Error('No debería llegar a pegarle a la API de Meta'); });
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

describe('whatsappHandler — tope de plan trial (10 mensajes, migración 576)', () => {
  it('bloquea (200, bloqueado:true) sin pegarle a Meta cuando el plan ya alcanzó el tope de WhatsApp', async () => {
    limiteMock.permite = false;
    const res = mockRes();

    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, bloqueado: true, limite_plan: true });
    expect(global.fetch).not.toHaveBeenCalled();
    global.fetch = fetchOriginal;
  });

  it('consulta el tope con el recurso "whatsapp_mensajes" para la empresa de la sesión', async () => {
    limiteMock.permite = false;
    const res = mockRes();

    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    expect(limiteMock.llamadas).toContainEqual({ empresaId: EMPRESA, recurso: 'whatsapp_mensajes' });
    global.fetch = fetchOriginal;
  });

  it('no bloquea por plan (puede seguir de largo) cuando el plan sí permite más mensajes', async () => {
    limiteMock.permite = true;
    const res = mockRes();

    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    // No debería haber sido bloqueado específicamente POR PLAN (puede fallar
    // más adelante por el fetch mockeado para tirar error — eso no es lo
    // que se testea acá, solo que el corte de plan no fue el motivo).
    expect(res.body?.limite_plan).not.toBe(true);
    global.fetch = fetchOriginal;
  });
});
