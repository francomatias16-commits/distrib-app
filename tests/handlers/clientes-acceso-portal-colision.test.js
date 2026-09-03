// tests/handlers/clientes-acceso-portal-colision.test.js
//
// Hallazgo (auditoría "resto de admin", esta sesión): crearAccesoPortal()
// deriva el email ficticio de auth SOLO del teléfono
// (`${telNorm}@portal.distrib`), sin namespacing por empresa. auth.users
// es un espacio único para todo el proyecto (todas las empresas del SaaS
// comparten la misma base de Supabase) — si el mismo teléfono es cliente
// de dos empresas distintas, otorgar acceso portal para la segunda
// encontraba el auth.users de la primera y repisaba en silencio la fila
// de `usuarios` (empresa_id/cliente_id), secuestrando el login de la
// primera empresa. Este test cubre el guard agregado: en vez de repisar,
// se corta con un error explícito si el auth user ya pertenece a otra
// empresa — mismo criterio que ya usa chofer_invitacion.js para el caso
// análogo (ver "Ya existe una cuenta con ese teléfono").

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false,
}));

const verificarTokenMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth-helpers.js', () => ({ verificarToken: verificarTokenMock }));

const dbMock = vi.hoisted(() => {
  const usuariosRow = { current: null }; // { empresa_id } | null
  const authUsers = { current: [] };     // [{ id, email }]

  const usuariosTable = {
    select: () => usuariosTable,
    eq: () => usuariosTable,
    maybeSingle: async () => ({ data: usuariosRow.current, error: null }),
    update: () => usuariosTable,
    upsert: async (row) => {
      usuariosRow.current = { empresa_id: row.empresa_id };
      return { error: null };
    },
  };

  const clientesTable = {
    update: () => clientesTable,
    eq: () => clientesTable,
    then: (resolve) => resolve({ error: null }), // awaitable: .update().eq().eq() → { error: null }
  };

  return {
    _usuariosRow: usuariosRow,
    _authUsers: authUsers,
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: authUsers.current }, error: null }),
        updateUserById: async () => ({ error: null }),
        createUser: async ({ email }) => ({ data: { user: { id: 'new-auth-id', email } }, error: null }),
      },
    },
    from: (table) => {
      if (table === 'usuarios') return usuariosTable;
      if (table === 'clientes') return clientesTable;
      throw new Error(`tabla no mockeada: ${table}`);
    },
  };
});
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const reposMock = vi.hoisted(() => ({
  obtenerCliente: vi.fn(async () => ({ id: 'cli-1', telefono: '3462123456', razon_social: 'Cliente Test' })),
  listarClientes: vi.fn(async () => []),
  crearCliente: vi.fn(),
  actualizarCliente: vi.fn(),
  desactivarCliente: vi.fn(),
  desbloquearCliente: vi.fn(),
  listarPreciosClientesGlobal: vi.fn(),
  upsertPrecioCliente: vi.fn(),
  eliminarPrecioCliente: vi.fn(),
  listarClientesSinCoordenadas: vi.fn(),
}));
vi.mock('../../lib/repos/clientes.js', () => reposMock);

vi.mock('../../lib/repos/empresas.js', () => ({
  obtenerEmpresa: vi.fn(async () => ({ nombre: 'Mi Empresa' })),
}));

vi.mock('../../lib/geocoding.js', () => ({ geocodificarDireccion: vi.fn() }));

const { default: handler } = await import('../../lib/handlers/clientes.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function reqAcceso(accion, empresaId) {
  return {
    method: 'POST',
    url: '/api/clientes/acceso',
    query: {},
    body: { cliente_id: 'cli-1', accion },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock._usuariosRow.current = null;
  dbMock._authUsers.current = [];
});

describe('POST /api/clientes/acceso — colisión cross-tenant por teléfono', () => {
  it('primera vez (sin auth user previo) — crea acceso normalmente', async () => {
    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'empresa-A', rol: 'admin' });
    const res = mockRes();

    await handler(reqAcceso('crear'), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.waLink).toContain('wa.me');
  });

  it('mismo teléfono, MISMA empresa (regenerar acceso) — permitido', async () => {
    // Simula que ya existe un auth user para este teléfono, ya vinculado a empresa-A.
    dbMock._authUsers.current = [{ id: 'auth-1', email: '543462123456@portal.distrib' }];
    dbMock._usuariosRow.current = { empresa_id: 'empresa-A' };

    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'empresa-A', rol: 'admin' });
    const res = mockRes();

    await handler(reqAcceso('crear'), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalled();
  });

  it('mismo teléfono, OTRA empresa — se corta con error en vez de secuestrar el acceso (regresión del hallazgo)', async () => {
    // El teléfono ya tiene un acceso portal activo, pero de empresa-B.
    dbMock._authUsers.current = [{ id: 'auth-1', email: '543462123456@portal.distrib' }];
    dbMock._usuariosRow.current = { empresa_id: 'empresa-B' };

    verificarTokenMock.mockResolvedValue({ id: 'u1', empresa_id: 'empresa-A', rol: 'admin' });
    const res = mockRes();

    await handler(reqAcceso('crear'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toMatch(/ya tiene acceso al portal de otra empresa/i);
    // Nunca debe haber repisado la fila de usuarios de la otra empresa.
    expect(dbMock._usuariosRow.current).toEqual({ empresa_id: 'empresa-B' });
  });
});
