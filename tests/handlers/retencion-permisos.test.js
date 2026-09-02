// tests/handlers/retencion-permisos.test.js
//
// Etapa 2 del PLAN_ROBUSTEZ_ESCALABILIDAD_PROFESIONAL_2026.md. Cubre el
// guard de lib/handlers/retencion.js: solo CRON_SECRET real o
// dueno/admin autenticados pueden disparar el archivado/purga. La RPC en
// sí (archivar_y_purgar_retencion, incl. la ampliación 2026-08-29 con
// security_audit_historial/whatsapp/asistente) ya se verificó en vivo
// contra Supabase con ROLLBACK — acá solo se cubre el contrato HTTP del
// handler, incluyendo que propaga TODAS las claves que devuelva el RPC
// (no solo las 3 originales), para no acoplar el handler a una lista fija
// de tablas si el RPC suma o saca alguna más adelante.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

const verificarTokenMock = vi.hoisted(() => ({ perfil: null }));
vi.mock('../../lib/auth-helpers.js', () => ({
  verificarToken: vi.fn(() => Promise.resolve(verificarTokenMock.perfil)),
}));

const rpcMock = vi.hoisted(() => ({ resultado: { data: { notif_log: 0, eventos_negocio: 0, audit_log: 0 }, error: null } }));
vi.mock('../../lib/repos/retencion.js', () => ({
  archivarYPurgarRetencion: vi.fn(() => Promise.resolve(rpcMock.resultado)),
}));

const { default: handler } = await import('../../lib/handlers/retencion.js');

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() { return this; },
    removeHeader() { return this; },
    end() { return this; },
  };
  return res;
}

function fakeReq({ headers = {}, method = 'GET' } = {}) {
  return { method, query: {}, body: {}, headers };
}

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  verificarTokenMock.perfil = null;
  rpcMock.resultado = { data: { notif_log: 3, eventos_negocio: 1, audit_log: 0 }, error: null };
});

afterEach(() => {
  process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

describe('retencion.js — guard de autenticación', () => {
  it('rechaza sin CRON_SECRET configurada y sin sesión (401)', async () => {
    delete process.env.CRON_SECRET;
    verificarTokenMock.perfil = null;

    const res = fakeRes();
    await handler(fakeReq(), res);

    expect(res.statusCode).toBe(401);
  });

  it('rechaza un usuario autenticado que no es dueno/admin (ej. vendedor)', async () => {
    process.env.CRON_SECRET = 'secreto-test';
    verificarTokenMock.perfil = { rol: 'vendedor', empresa_id: 'e1' };

    const res = fakeRes();
    await handler(fakeReq({ headers: {} }), res);

    expect(res.statusCode).toBe(401);
  });

  it('acepta el cron real con el Bearer correcto, sin necesitar sesión', async () => {
    process.env.CRON_SECRET = 'secreto-test';

    const res = fakeRes();
    await handler(fakeReq({ headers: { authorization: 'Bearer secreto-test' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, notif_log: 3, eventos_negocio: 1, audit_log: 0 });
  });

  it('rechaza un Bearer con secreto incorrecto', async () => {
    process.env.CRON_SECRET = 'secreto-test';
    verificarTokenMock.perfil = null;

    const res = fakeRes();
    await handler(fakeReq({ headers: { authorization: 'Bearer otro-valor' } }), res);

    expect(res.statusCode).toBe(401);
  });

  it('acepta dueno/admin logueado sin CRON_SECRET en el request (trigger manual)', async () => {
    process.env.CRON_SECRET = 'secreto-test';
    verificarTokenMock.perfil = { rol: 'dueno', empresa_id: 'e1' };

    const res = fakeRes();
    await handler(fakeReq({ headers: {} }), res);

    expect(res.statusCode).toBe(200);
  });

  it('propaga todas las claves del RPC ampliado, no solo las 3 originales', async () => {
    process.env.CRON_SECRET = 'secreto-test';
    rpcMock.resultado = {
      data: {
        notif_log: 3,
        eventos_negocio: 1,
        audit_log: 0,
        security_audit_historial: 5,
        asistente_mensajes: 12,
        asistente_conversaciones: 4,
        whatsapp_mensajes: 7,
        whatsapp_conversaciones: 2,
        dias_retencion: 180,
      },
      error: null,
    };

    const res = fakeRes();
    await handler(fakeReq({ headers: { authorization: 'Bearer secreto-test' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      security_audit_historial: 5,
      asistente_mensajes: 12,
      asistente_conversaciones: 4,
      whatsapp_mensajes: 7,
      whatsapp_conversaciones: 2,
    });
  });

  it('devuelve 405 para métodos no soportados', async () => {
    process.env.CRON_SECRET = 'secreto-test';

    const res = fakeRes();
    await handler(fakeReq({ method: 'DELETE', headers: { authorization: 'Bearer secreto-test' } }), res);

    expect(res.statusCode).toBe(405);
  });
});
