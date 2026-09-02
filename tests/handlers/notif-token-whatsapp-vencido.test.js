// tests/handlers/notif-token-whatsapp-vencido.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🟡 #12, resuelto en v958. Los 2 puntos
// donde `whatsappHandler` detecta el error 190 de Meta (token
// vencido/inválido) llamaban a
// `alertarTokenWhatsAppVencido(...).catch(() => {})` y
// `marcarEstadoTokenWhatsapp(...).catch(() => {})` — a diferencia de
// `notifAuto()`, ninguna de las dos funciones se blinda internamente, así
// que si `listarAdminsDueno`/`ultimoEnvioPorTipo`/`registrarLog`/
// `actualizarNecesitaReconexionWhatsapp` fallan (hiccup de DB), el propio
// mecanismo de alerta "WhatsApp desconectado" se caía sin dejar ningún
// rastro — justo el escenario que la alerta existe para evitar. v958
// agregó `console.error` en los 4 call-sites.
//
// Este test cubre el call-site del endpoint de templates (whatsappHandler,
// `_svc=whatsapp`), fijando que un fallo interno de cualquiera de las dos
// funciones queda logueado y no rompe la respuesta HTTP (sigue siendo
// fire-and-forget).

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const credencialesMock = vi.hoisted(() => ({
  llamadas: [],
  resultado: { data: null, error: 'sin fila propia' }, // fuerza fallback a env vars (número compartido)
}));

const repoNotifMock = vi.hoisted(() => ({
  ultimoEnvioPorTipoImpl: vi.fn().mockResolvedValue(null),
  listarAdminsDuenoImpl: vi.fn().mockResolvedValue([{ id: 'admin-1', empresa_id: 'empresa-1' }]),
  registrarLogImpl: vi.fn().mockResolvedValue(null),
  actualizarNecesitaReconexionWhatsappImpl: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: vi.fn() }));
vi.mock('../../lib/demo-mode.js', () => ({
  esEmpresaDemo: vi.fn().mockResolvedValue(false),
  whatsappSimulado: () => ({ message_id: 'sim-123' }),
}));
// exigirLimitePlan (Etapa 8, migración 576 — tope de WhatsApp en trial)
// se mockea como no-op: este archivo prueba el logging del error 190, no
// el tope de plan (ver tests/handlers/whatsapp-tope-plan.test.js). Sin
// este mock, exigirLimitePlan intenta crear un cliente Supabase real y
// revienta con "supabaseUrl is required".
vi.mock('../../lib/plan-limits.js', async () => {
  const real = await vi.importActual('../../lib/plan-limits.js');
  return {
    ...real,
    exigirLimitePlan: vi.fn(() => Promise.resolve()),
  };
});
vi.mock('../../lib/handlers/_push.js', () => ({
  enviarPush: vi.fn().mockResolvedValue(null),
  notificarPedidoEntregado: vi.fn(),
  notificarDeudaVencida: vi.fn(),
}));

vi.mock('../../lib/repos/whatsapp-bot.js', async () => {
  const real = await vi.importActual('../../lib/repos/whatsapp-bot.js');
  return {
    ...real,
    obtenerCredencialesWhatsapp: (empresaId) => {
      credencialesMock.llamadas.push(empresaId);
      return Promise.resolve(credencialesMock.resultado);
    },
  };
});

vi.mock('../../lib/repos/notif.js', async () => {
  const real = await vi.importActual('../../lib/repos/notif.js');
  return {
    ...real,
    ultimoEnvioPorTipo: (...args) => repoNotifMock.ultimoEnvioPorTipoImpl(...args),
    listarAdminsDueno: (...args) => repoNotifMock.listarAdminsDuenoImpl(...args),
    registrarLog: (...args) => repoNotifMock.registrarLogImpl(...args),
    actualizarNecesitaReconexionWhatsapp: (...args) => repoNotifMock.actualizarNecesitaReconexionWhatsappImpl(...args),
  };
});

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

const EMPRESA = 'empresa-token-vencido-1';
const BODY_OK = { template: 'pedido_despachado', telefono: '+5493405123456', params: {} };

let consoleErrorSpy;
let fetchSpy;

beforeEach(() => {
  verificarToken.mockReset();
  verificarToken.mockResolvedValue({ id: 'u-vend', rol: 'vendedor', empresa_id: EMPRESA });
  credencialesMock.llamadas = [];
  credencialesMock.resultado = { data: null, error: 'sin fila propia' };
  repoNotifMock.ultimoEnvioPorTipoImpl.mockReset().mockResolvedValue(null);
  repoNotifMock.listarAdminsDuenoImpl.mockReset().mockResolvedValue([{ id: 'admin-1', empresa_id: EMPRESA }]);
  repoNotifMock.registrarLogImpl.mockReset().mockResolvedValue(null);
  repoNotifMock.actualizarNecesitaReconexionWhatsappImpl.mockReset().mockResolvedValue(null);

  process.env.WA_NOTIF_SALIENTES_HABILITADAS = 'true';
  process.env.WA_PHONE_NUMBER_ID = 'pnid-test';
  process.env.WA_ACCESS_TOKEN = 'token-test';

  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  // Meta responde error 190 (token vencido) en el envío del template.
  fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
    ok: false,
    status: 401,
    json: () => Promise.resolve({ error: { code: 190, message: 'Error validating access token' } }),
  });
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  fetchSpy.mockRestore();
  delete process.env.WA_NOTIF_SALIENTES_HABILITADAS;
});

describe('whatsappHandler — regresión hallazgo #12 (alerta de token vencido no debe fallar en silencio)', () => {
  it('si listarAdminsDueno (dependencia de alertarTokenWhatsAppVencido) falla, queda logueado con console.error y la respuesta HTTP no se rompe', async () => {
    repoNotifMock.listarAdminsDuenoImpl.mockRejectedValue(new Error('DB hiccup en listarAdminsDueno'));

    const res = mockRes();
    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    // La respuesta al 502 (error de Meta) no se ve afectada por el fallo
    // de la alerta interna, que es fire-and-forget.
    expect(res.statusCode).toBe(502);
    expect(consoleErrorSpy).toHaveBeenCalled();
    const mensajes = consoleErrorSpy.mock.calls.map(c => c.join(' '));
    expect(mensajes.some(m => m.includes('Error alertando token WhatsApp vencido'))).toBe(true);
  });

  it('si registrarLog (dependencia de alertarTokenWhatsAppVencido) falla, también queda logueado', async () => {
    repoNotifMock.registrarLogImpl.mockRejectedValue(new Error('DB hiccup en registrarLog'));

    const res = mockRes();
    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(502);
    expect(consoleErrorSpy).toHaveBeenCalled();
    const mensajes = consoleErrorSpy.mock.calls.map(c => c.join(' '));
    expect(mensajes.some(m => m.includes('Error alertando token WhatsApp vencido'))).toBe(true);
  });

  it('camino feliz (sin código 190): no llama a alertarTokenWhatsAppVencido y no hay console.error espurio', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ messages: [{ id: 'wamid-1' }] }),
    });

    const res = mockRes();
    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(200);
    expect(repoNotifMock.listarAdminsDuenoImpl).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
