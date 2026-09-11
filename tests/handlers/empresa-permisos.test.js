// tests/handlers/empresa-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta migración
// a PermisosService. Foco: mismo comportamiento observable que el
// ROLES_ADMIN original — un único gate resuelto en `requerirPerfilAdmin()`,
// compartido por logo/icon/datos/catalogo-publico.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: { storage: {} } }));

const reposMock = vi.hoisted(() => ({
  obtenerLogoUrl: vi.fn(async () => null),
  actualizarLogoUrl: vi.fn(async () => {}),
  obtenerDatosEditables: vi.fn(async () => ({ nombre: 'Empresa Test', config: {} })),
  actualizarDatosEmpresa: vi.fn(async () => ({})),
  obtenerConfig: vi.fn(async () => ({})),
  actualizarConfig: vi.fn(async () => ({})),
}));
vi.mock('../../lib/repos/empresas.js', () => reposMock);

const { default: handler } = await import('../../lib/handlers/empresa.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function reqCon() {
  return {
    method: 'GET',
    query: { _svc: 'datos' },
    headers: { authorization: 'Bearer token-valido' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gate único de configuración (ROLES_ADMIN original)', () => {
  it.each(['dueno', 'admin'])('%s puede acceder (sin 403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.obtenerDatosEditables).toHaveBeenCalledWith('e1');
  });

  it.each(['vendedor', 'depositero', 'contador', 'chofer'])('%s NO puede acceder (403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos' });
    expect(reposMock.obtenerDatosEditables).not.toHaveBeenCalled();
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
