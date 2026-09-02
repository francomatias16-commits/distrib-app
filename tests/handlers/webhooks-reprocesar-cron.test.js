// tests/handlers/webhooks-reprocesar-cron.test.js
//
// Motor de Integraciones (577_webhooks_recibidos.sql): handleWebhooksReprocesarCron
// (lib/handlers/notif.js, _svc=webhooks-reprocesar-cron) reprocesa los eventos
// que quedaron en estado 'error' para las dos integraciones con webhook
// entrante (WhatsApp y Mercado Pago). No tenía cobertura propia — este test
// cubre el auth del cron, el reproceso exitoso y con error de cada
// integración por separado, y el caso puntual de MP donde procesarEventoMP
// no lanza excepción pero devuelve un status >= 500 (no debe marcarse
// 'procesado' — ver comentario en el propio handler).
//
// Mismo criterio de mocking que whatsapp-desconectar.test.js: se mockea
// lib/repos/_db.js para no pegarle a Supabase real. lib/repos/webhooks.js y
// lib/handlers/pagos.js se mockean enteros (son los dos módulos que el cron
// importa dinámicamente); lib/repos/whatsapp-bot.js se mockea parcialmente
// vía importOriginal, para forzar un error puntual en el branch
// 'account_update' sin perder el resto de sus exports reales.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ updates: [] }));

vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    from: (tabla) => ({
      update: (cambios) => ({
        eq: (col, val) => {
          dbMock.updates.push({ tabla, cambios, col, val });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  },
}));

const webhooksRepoMock = vi.hoisted(() => ({
  pendientesPorIntegracion: { whatsapp: [], mercadopago: [] },
  errores: [],
}));

vi.mock('../../lib/repos/webhooks.js', () => ({
  registrarWebhookEntrante: vi.fn(async () => ({ id: null, yaProcesado: false })),
  marcarWebhookError: vi.fn(async (id, mensaje) => {
    webhooksRepoMock.errores.push({ id, mensaje });
  }),
  listarWebhooksParaReintentar: vi.fn(async ({ integracion }) => {
    return webhooksRepoMock.pendientesPorIntegracion[integracion] || [];
  }),
}));

const pagosMock = vi.hoisted(() => ({ procesarEventoMP: vi.fn() }));

vi.mock('../../lib/handlers/pagos.js', () => ({
  procesarEventoMP: pagosMock.procesarEventoMP,
}));

// obtenerEmpresaPorWabaId es lo único que forzamos a fallar (branch
// 'account_update'); el resto del módulo queda real por si algo más de
// notif.js lo necesita al importarse.
vi.mock('../../lib/repos/whatsapp-bot.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    obtenerEmpresaPorWabaId: vi.fn(async () => {
      throw new Error('boom-empresa-waba');
    }),
  };
});

const { registrarWebhookEntrante, marcarWebhookError, listarWebhooksParaReintentar } =
  await import('../../lib/repos/webhooks.js');
const notifModule = await import('../../lib/handlers/notif.js');
const handler = notifModule.default;

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function mockReq({ metodo = 'POST', secret = 'cron-secret-test' } = {}) {
  return {
    method: metodo,
    query: { _svc: 'webhooks-reprocesar-cron' },
    headers: { authorization: `Bearer ${secret}` },
    body: {},
  };
}

describe('handleWebhooksReprocesarCron (_svc=webhooks-reprocesar-cron)', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret-test';
    webhooksRepoMock.pendientesPorIntegracion = { whatsapp: [], mercadopago: [] };
    webhooksRepoMock.errores = [];
    dbMock.updates = [];
    pagosMock.procesarEventoMP.mockReset();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it('rechaza sin CRON_SECRET configurado en el entorno', async () => {
    delete process.env.CRON_SECRET;
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(503);
  });

  it('rechaza con un secreto incorrecto', async () => {
    const res = mockRes();
    await handler(mockReq({ secret: 'no-es-el-secreto' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rechaza métodos distintos de GET/POST', async () => {
    const res = mockRes();
    await handler(mockReq({ metodo: 'DELETE' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('reprocesa un webhook de WhatsApp pendiente y lo marca procesado', async () => {
    // field='smb_app_state_sync': la única rama de procesarCambioWebhookWhatsapp
    // que no depende de ningún repo (solo loguea) — sirve para probar el
    // camino feliz del reproceso sin tener que simular todo el bot conversacional.
    webhooksRepoMock.pendientesPorIntegracion.whatsapp = [
      {
        id: 'wh-1',
        integracion: 'whatsapp',
        payload: { entry: [{ id: 'waba-1', changes: [{ field: 'smb_app_state_sync', value: { state_sync: [] } }] }] },
      },
    ];

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.whatsapp).toEqual({ evaluados: 1, reprocesados: 1, con_error: 0 });
    expect(dbMock.updates).toEqual([
      { tabla: 'webhooks_recibidos', cambios: expect.objectContaining({ estado: 'procesado' }), col: 'id', val: 'wh-1' },
    ]);
    expect(marcarWebhookError).not.toHaveBeenCalled();
  });

  it('si el reproceso de WhatsApp falla, marca error y no lo da por procesado', async () => {
    // field='account_update' → llama a obtenerEmpresaPorWabaId, mockeada para tirar.
    webhooksRepoMock.pendientesPorIntegracion.whatsapp = [
      {
        id: 'wh-2',
        integracion: 'whatsapp',
        payload: { entry: [{ id: 'waba-2', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }] },
      },
    ];

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.whatsapp).toEqual({ evaluados: 1, reprocesados: 0, con_error: 1 });
    expect(marcarWebhookError).toHaveBeenCalledWith('wh-2', expect.stringContaining('boom-empresa-waba'));
    expect(dbMock.updates).toEqual([]); // nunca se marcó 'procesado'
  });

  it('reprocesa un webhook de Mercado Pago pendiente vía procesarEventoMP', async () => {
    webhooksRepoMock.pendientesPorIntegracion.mercadopago = [
      { id: 'mp-1', integracion: 'mercadopago', payload: { type: 'payment', data: { id: '999' } } },
    ];
    pagosMock.procesarEventoMP.mockResolvedValue({ status: 200, body: { received: true } });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.mercadopago).toEqual({ evaluados: 1, reprocesados: 1, con_error: 0 });
    expect(pagosMock.procesarEventoMP).toHaveBeenCalledWith({ type: 'payment', data: { id: '999' } });
    expect(dbMock.updates).toEqual([
      { tabla: 'webhooks_recibidos', cambios: expect.objectContaining({ estado: 'procesado' }), col: 'id', val: 'mp-1' },
    ]);
  });

  it('un status >= 500 de procesarEventoMP cuenta como error aunque no haya excepción (no se marca procesado)', async () => {
    webhooksRepoMock.pendientesPorIntegracion.mercadopago = [
      { id: 'mp-2', integracion: 'mercadopago', payload: { type: 'payment', data: { id: '1000' } } },
    ];
    pagosMock.procesarEventoMP.mockResolvedValue({ status: 502, body: { error: 'No se pudo verificar el pago' } });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.mercadopago).toEqual({ evaluados: 1, reprocesados: 0, con_error: 1 });
    expect(marcarWebhookError).toHaveBeenCalledWith('mp-2', expect.stringContaining('502'));
    expect(dbMock.updates).toEqual([]);
  });

  it('si procesarEventoMP lanza una excepción, se marca error igual que un status >= 500', async () => {
    webhooksRepoMock.pendientesPorIntegracion.mercadopago = [
      { id: 'mp-3', integracion: 'mercadopago', payload: { type: 'payment', data: { id: '1001' } } },
    ];
    pagosMock.procesarEventoMP.mockRejectedValue(new Error('timeout consultando MP'));

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.mercadopago).toEqual({ evaluados: 1, reprocesados: 0, con_error: 1 });
    expect(marcarWebhookError).toHaveBeenCalledWith('mp-3', expect.stringContaining('timeout consultando MP'));
  });

  it('reprocesa ambas integraciones en la misma corrida, cada una con su propio detalle', async () => {
    webhooksRepoMock.pendientesPorIntegracion.whatsapp = [
      { id: 'wh-3', integracion: 'whatsapp', payload: { entry: [{ id: 'waba-3', changes: [{ field: 'smb_app_state_sync', value: {} }] }] } },
    ];
    webhooksRepoMock.pendientesPorIntegracion.mercadopago = [
      { id: 'mp-4', integracion: 'mercadopago', payload: { type: 'payment', data: { id: '2000' } } },
    ];
    pagosMock.procesarEventoMP.mockResolvedValue({ status: 200, body: { received: true } });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body).toEqual({
      ok: true,
      whatsapp: { evaluados: 1, reprocesados: 1, con_error: 0 },
      mercadopago: { evaluados: 1, reprocesados: 1, con_error: 0 },
    });
    // Cada integración se consulta con su propio filtro — no se mezclan.
    expect(listarWebhooksParaReintentar).toHaveBeenCalledWith(expect.objectContaining({ integracion: 'whatsapp' }));
    expect(listarWebhooksParaReintentar).toHaveBeenCalledWith(expect.objectContaining({ integracion: 'mercadopago' }));
  });

  it('sin webhooks pendientes en ninguna integración, responde 0/0/0 para ambas', async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      whatsapp: { evaluados: 0, reprocesados: 0, con_error: 0 },
      mercadopago: { evaluados: 0, reprocesados: 0, con_error: 0 },
    });
    expect(pagosMock.procesarEventoMP).not.toHaveBeenCalled();
  });
});
