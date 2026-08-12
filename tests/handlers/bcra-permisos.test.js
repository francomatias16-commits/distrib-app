// tests/handlers/bcra-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta migración
// a PermisosService. Foco: mismo comportamiento observable que el
// ROLES_PERMITIDOS original — un único gate ('consultar') para todo el
// handler, sin distinguir acción (entidades/denunciado/situacion/
// cheques-rechazados/verificar-cliente).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: {} }));

const { default: handler } = await import('../../lib/handlers/bcra.js');

// El foco de este archivo es el gate de permisos, no la integración real
// con BCRA (ver bcra.js — no probado en vivo, según su propio comentario
// de cabecera). Se mockea fetch para que el test no dependa de la red ni
// de que api.bcra.gob.ar esté en el allowlist de egress del entorno.
global.fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ results: [] }),
}));

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  res.removeHeader = vi.fn(() => res);
  return res;
}

function reqCon({ method = 'GET', query = {} } = {}) {
  return { method, query, headers: { authorization: 'Bearer token-valido' } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gate único de consulta (ROLES_PERMITIDOS original)', () => {
  it.each(['dueno', 'admin', 'contador'])('%s puede consultar (sin 403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const res = mockRes();

    await handler(reqCon({ query: { accion: 'entidades' } }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it.each(['vendedor', 'depositero', 'chofer'])('%s NO puede consultar (403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const res = mockRes();

    await handler(reqCon({ query: { accion: 'entidades' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sin permiso' });
  });

  it('el gate es el mismo sin importar la acción pedida (situacion)', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol: 'vendedor' });
    const res = mockRes();

    await handler(reqCon({ query: { accion: 'situacion', cuit: '20111111112' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler(reqCon({ query: { accion: 'entidades' } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
