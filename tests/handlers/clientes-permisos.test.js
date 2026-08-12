// tests/handlers/clientes-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta migración
// a PermisosService. Foco: mismo comportamiento observable que el
// ROLES_ADMIN original — un único gate ('acceder') para todo el handler
// de gestión de clientes (no confundir con el gate más restrictivo
// hardcodeado ['dueno','admin'] de POST /acceso, que sigue igual — fuera
// de alcance de esta migración, no era un ROLES_* con nombre propio).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/_db.js', () => ({ db: {} }));

const reposMock = vi.hoisted(() => ({
  listarClientes: vi.fn(async () => []),
  obtenerCliente: vi.fn(async () => null),
  crearCliente: vi.fn(async () => ({ id: 'c1' })),
  actualizarCliente: vi.fn(async () => ({ id: 'c1' })),
  desactivarCliente: vi.fn(async () => ({ ok: true })),
  listarPreciosClientesGlobal: vi.fn(async () => []),
  upsertPrecioCliente: vi.fn(async () => ({})),
  eliminarPrecioCliente: vi.fn(async () => ({})),
  listarClientesSinCoordenadas: vi.fn(async () => []),
}));
vi.mock('../../lib/repos/clientes.js', () => reposMock);

vi.mock('../../lib/geocoding.js', () => ({
  geocodificarDireccion: vi.fn(async () => null),
}));

const { default: handler } = await import('../../lib/handlers/clientes.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function reqCon({ method = 'GET', query = {}, body = {} } = {}) {
  return { method, query, body, url: '/api/clientes' };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gate único de acceso (ROLES_ADMIN original)', () => {
  it.each(['dueno', 'admin', 'vendedor'])('%s puede acceder (GET 200, sin 403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(reposMock.listarClientes).toHaveBeenCalled();
  });

  it.each(['depositero', 'contador', 'chofer'])('%s NO puede acceder (403)', async (rol) => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'e1', rol });
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Acceso solo para administradores' });
    expect(reposMock.listarClientes).not.toHaveBeenCalled();
  });

  it('sin token → 401 antes que el gate de permisos (mismo contrato: perfil null → 401, no 403)', async () => {
    verificarTokenMock.mockResolvedValue(null);
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'No autorizado' });
  });
});
