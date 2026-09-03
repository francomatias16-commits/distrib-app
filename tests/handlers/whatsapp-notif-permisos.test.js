// tests/handlers/whatsapp-notif-permisos.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🔴 Crítico #14, resuelto en v960 pero sin
// ningún test de regresión hasta ahora. `whatsappHandler` (_svc=whatsapp,
// envío de templates aprobados — pedido_despachado, ruta_asignada, etc.)
// era el único _svc de este archivo sin verificarToken()+puede(): cualquiera
// con la URL, sin login, podía disparar mensajes reales contra el número
// compartido de la plataforma (con costo real por Meta), y con un
// empresa_id explícito en el body podía además elegir de qué empresa con
// número propio se descontaba el envío. El fix agregó el guard de auth +
// forzó que empresa_id salga siempre de la sesión (perfil), nunca del body.
//
// Se exportó `whatsappHandler` (antes interna) para poder testearlo
// directo, mismo criterio que `whatsappEmbeddedSignupHandler`.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const credencialesMock = vi.hoisted(() => ({
  llamadas: [],       // empresaId con el que se llamó obtenerCredencialesWhatsapp
  resultado: { data: null, error: 'sin fila propia' }, // fuerza fallback a env vars
}));

vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(),
}));

vi.mock('../../lib/demo-mode.js', () => ({
  esEmpresaDemo: vi.fn().mockResolvedValue(false),
  whatsappSimulado: () => ({ message_id: 'sim-123' }),
}));

// exigirLimitePlan (Etapa 8, migración 576 — tope de 10 mensajes de
// WhatsApp en trial) se mockea como no-op a propósito: este archivo prueba
// el guard de auth de whatsappHandler, no el tope de plan (eso lo cubre
// tests/handlers/whatsapp-tope-plan.test.js). Sin este mock,
// exigirLimitePlan intenta crear un cliente Supabase real dentro del test
// y revienta con "supabaseUrl is required" — mismo problema que ya se vio
// acá antes de mockear demo-mode.js.
vi.mock('../../lib/plan-limits.js', async () => {
  const real = await vi.importActual('../../lib/plan-limits.js');
  return {
    ...real,
    exigirLimitePlan: vi.fn(() => Promise.resolve()),
  };
});

// Mockeamos SOLO obtenerCredencialesWhatsapp (repos/whatsapp-bot.js exporta
// muchas otras funciones que notif.js importa — hay que preservarlas para
// no romper el resto del módulo al cargarlo).
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

const { verificarToken } = await import('../../lib/auth-helpers.js');
const { whatsappHandler } = await import('../../lib/handlers/notif.js');

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    end() { return this; },
  };
  return res;
}

const EMPRESA_PROPIA = 'empresa-legitima-1';
const EMPRESA_AJENA  = 'empresa-ajena-2';
// resolverCredencialesWhatsapp cachea por empresa_id (TTL 60s, Map a nivel
// de módulo) — cada test que verifica con qué empresa_id se llamó
// obtenerCredencialesWhatsapp necesita su propio id para no pegarle a un
// resultado cacheado de un test anterior en el mismo archivo.
const EMPRESA_PROPIA_2 = 'empresa-legitima-3';
// Idem EMPRESA_PROPIA_2: el último test del describe de FIX
// AUTOMATIZACION-003 reusaba EMPRESA_PROPIA, que ya había sido resuelta
// (y cacheada 60s) por el test "permite a un rol autorizado (vendedor)
// enviar" más arriba en el mismo archivo — resolverCredencialesWhatsapp
// devolvía el valor cacheado sin llamar a obtenerCredencialesWhatsapp de
// nuevo, así que credencialesMock.llamadas quedaba vacío y la aserción
// fallaba (no por un bug de whatsappHandler, sino por colisión de cache
// entre tests). Se le da su propio empresa_id, igual que ya se hizo para
// EMPRESA_PROPIA_2.
const EMPRESA_PROPIA_3 = 'empresa-legitima-4';
const BODY_OK = { template: 'pedido_despachado', telefono: '+5493405123456', params: {} };

beforeEach(() => {
  verificarToken.mockReset();
  credencialesMock.llamadas = [];
  credencialesMock.resultado = { data: null, error: 'sin fila propia' };
  delete process.env.WA_NOTIF_SALIENTES_HABILITADAS;
  // Credenciales de fallback (número compartido) configuradas para poder
  // llegar al chequeo de auth/enviosHabilitados sin cortar antes con 500
  // "WhatsApp no configurado" — no es lo que se testea acá.
  process.env.WA_PHONE_NUMBER_ID = 'pnid-test';
  process.env.WA_ACCESS_TOKEN = 'token-test';
});

describe('whatsappHandler — control de acceso (regresión hallazgo Crítico #14, v960)', () => {
  it('rechaza con 401 si no hay token / usuario no autenticado — antes no había NINGÚN chequeo', async () => {
    verificarToken.mockResolvedValue(null);
    const res = mockRes();

    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(401);
    // Ni siquiera debería haber intentado resolver credenciales.
    expect(credencialesMock.llamadas).toHaveLength(0);
  });

  it('rechaza con 403 para un rol sin permiso de enviar (ej. chofer)', async () => {
    verificarToken.mockResolvedValue({ id: 'u-chofer', rol: 'chofer', empresa_id: EMPRESA_PROPIA });
    const res = mockRes();

    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(403);
    expect(credencialesMock.llamadas).toHaveLength(0);
  });

  it('permite a un rol autorizado (vendedor) enviar', async () => {
    verificarToken.mockResolvedValue({ id: 'u-vend', rol: 'vendedor', empresa_id: EMPRESA_PROPIA });
    const res = mockRes();

    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    // No 401/403 — pasó el guard de auth (puede terminar en 200/bloqueado
    // según WA_NOTIF_SALIENTES_HABILITADAS, eso no es lo que se testea acá).
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
    expect(credencialesMock.llamadas).toEqual([EMPRESA_PROPIA]);
  });

  it('ignora un empresa_id ajeno mandado en el body — SIEMPRE resuelve credenciales con perfil.empresa_id (regresión del bug de suplantación de tenant)', async () => {
    verificarToken.mockResolvedValue({ id: 'u-dueno', rol: 'dueno', empresa_id: EMPRESA_PROPIA_2 });
    const res = mockRes();

    await whatsappHandler({
      method: 'POST',
      body: { ...BODY_OK, empresa_id: EMPRESA_AJENA }, // intento de suplantación
    }, res);

    expect(credencialesMock.llamadas).toEqual([EMPRESA_PROPIA_2]);
    expect(credencialesMock.llamadas).not.toContain(EMPRESA_AJENA);
  });

  it('sin empresa_id propia conectada y envíos globales deshabilitados, no manda nada real (fail-safe)', async () => {
    verificarToken.mockResolvedValue({ id: 'u-admin', rol: 'admin', empresa_id: EMPRESA_PROPIA });
    // WA_NOTIF_SALIENTES_HABILITADAS no seteada → enviosHabilitados=false por defecto.
    const res = mockRes();

    await whatsappHandler({ method: 'POST', body: BODY_OK }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, bloqueado: true });
  });

  it('responde 400 si faltan template/telefono (validación existente, no regresión pero cierra el flujo)', async () => {
    verificarToken.mockResolvedValue({ id: 'u-admin', rol: 'admin', empresa_id: EMPRESA_PROPIA });
    const res = mockRes();

    await whatsappHandler({ method: 'POST', body: { template: 'pedido_despachado' } }, res);

    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FIX AUTOMATIZACION-003 (auditoría etapa 6): el guard de v960 de arriba
// era correcto contra un cliente HTTP externo, pero dejó sin forma de
// pasar a los 6 callers server-to-server del propio repo (notificarEstado/
// notificarPedidoConfirmado en pedidos/notificaciones.js, el recordatorio
// de cierre.js, el reset de contraseña de auth.js, la oferta de plan de
// pago de score.js, y la acción 'enviar_whatsapp' de
// reglas-automatizacion.js) — ninguno manda Authorization porque corren en
// background sin sesión de usuario. Se agrega un segundo camino de auth
// (CRON_SECRET, mismo secreto que ya usan los demás crons de este mismo
// archivo), fail-closed si no está configurada. Estos tests cubren ese
// camino nuevo — no reemplazan a los de arriba, que siguen cubriendo el
// camino de usuario logueado.
// ─────────────────────────────────────────────────────────────────────────
describe('whatsappHandler — auth interna server-to-server (FIX AUTOMATIZACION-003)', () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('sin CRON_SECRET configurado, un Bearer cualquiera NO bypassea — cae al chequeo normal de usuario y rechaza (fail-closed)', async () => {
    verificarToken.mockResolvedValue(null); // sin sesión real
    const res = mockRes();

    await whatsappHandler({
      method: 'POST',
      headers: { authorization: 'Bearer lo-que-sea' },
      body: { ...BODY_OK, empresa_id: EMPRESA_PROPIA },
    }, res);

    expect(res.statusCode).toBe(401);
    expect(credencialesMock.llamadas).toHaveLength(0);
  });

  it('con CRON_SECRET configurado pero el header trae un secreto incorrecto, cae al chequeo normal de usuario (no bypassea)', async () => {
    process.env.CRON_SECRET = 'secreto-real';
    verificarToken.mockResolvedValue(null);
    const res = mockRes();

    await whatsappHandler({
      method: 'POST',
      headers: { authorization: 'Bearer secreto-incorrecto' },
      body: { ...BODY_OK, empresa_id: EMPRESA_PROPIA },
    }, res);

    expect(res.statusCode).toBe(401);
    expect(credencialesMock.llamadas).toHaveLength(0);
  });

  it('con CRON_SECRET correcto pero sin empresa_id en el body, responde 400 (no hay perfil del que sacarlo)', async () => {
    process.env.CRON_SECRET = 'secreto-real';
    const res = mockRes();

    await whatsappHandler({
      method: 'POST',
      headers: { authorization: 'Bearer secreto-real' },
      body: BODY_OK, // sin empresa_id
    }, res);

    expect(res.statusCode).toBe(400);
    expect(verificarToken).not.toHaveBeenCalled();
    expect(credencialesMock.llamadas).toHaveLength(0);
  });

  it('con CRON_SECRET correcto y empresa_id en el body, pasa el guard SIN pedir sesión de usuario y resuelve credenciales con ese empresa_id', async () => {
    process.env.CRON_SECRET = 'secreto-real';
    const res = mockRes();

    await whatsappHandler({
      method: 'POST',
      headers: { authorization: 'Bearer secreto-real' },
      body: { ...BODY_OK, empresa_id: EMPRESA_PROPIA_3 },
    }, res);

    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
    expect(verificarToken).not.toHaveBeenCalled(); // camino interno, no pasa por auth de usuario
    expect(credencialesMock.llamadas).toEqual([EMPRESA_PROPIA_3]);
  });
});
