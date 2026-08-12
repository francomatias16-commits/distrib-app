// tests/handlers/export-contable-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta
// migración a PermisosService. Foco: mismo comportamiento observable que
// los ROLES_EXPORT_CONTABLE/ROLES_CONFIG originales, ahora resuelto vía
// `puede()` — el gate de acceso general (cualquier método/recurso) y el
// gate más restrictivo de `configurar` (POST /config).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const authMock = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

const usuariosQueryMock = vi.hoisted(() => ({
  perfil: null, // { id, empresa_id, rol } — seteado por cada test
}));

const configQueryMock = vi.hoisted(() => ({
  select: vi.fn(() => ({
    eq: () => ({
      maybeSingle: async () => ({ data: { configurado: false }, error: null }),
    }),
  })),
  upsert: vi.fn(() => ({
    select: () => ({
      single: async () => ({ data: { proveedor: 'generico_csv' }, error: null }),
    }),
  })),
}));

// FIX (post-migración a repos): export-contable.js ya no consulta
// `usuarios` ni `export_contable_config` vía supabase-lazy — delega en
// obtenerEmpresaYRolPorAuthId() (repos/usuarios.js) y repos/export-contable.js,
// ambas sobre el cliente singleton de lib/repos/_db.js. supabase-lazy
// queda solo para auth.getUser().
vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    from: (tabla) => {
      if (tabla === 'usuarios') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: usuariosQueryMock.perfil, error: null }),
            }),
          }),
        };
      }
      if (tabla === 'export_contable_config') {
        return configQueryMock;
      }
      throw new Error(`tabla no mockeada en _db: ${tabla}`);
    },
  },
}));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    auth: authMock,
  }),
}));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false,
}));

vi.mock('../../lib/export-contable/index.js', () => ({
  generarExport: vi.fn(async () => ({})),
}));

const { default: handler } = await import('../../lib/handlers/export-contable.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

function reqCon({ method = 'GET', query = {}, body = {} } = {}) {
  return { method, query, body, headers: { authorization: 'Bearer token-valido' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  usuariosQueryMock.perfil = null;
});

describe('gate de acceso general (ROLES_EXPORT_CONTABLE original)', () => {
  it.each(['dueno', 'admin', 'contador'])('%s puede acceder (config GET, sin 403)', async (rol) => {
    usuariosQueryMock.perfil = { id: 'u1', empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(reqCon({ query: { recurso: 'config' } }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it.each(['vendedor', 'depositero', 'chofer'])('%s NO puede acceder (403)', async (rol) => {
    usuariosQueryMock.perfil = { id: 'u1', empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(reqCon({ query: { recurso: 'config' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos' });
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    const res = mockRes();
    const req = { method: 'GET', query: {}, body: {}, headers: {} };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('gate de configuración (ROLES_CONFIG original — más restrictivo)', () => {
  it('contador puede acceder pero no configurar (POST /config → 403)', async () => {
    usuariosQueryMock.perfil = { id: 'u1', empresa_id: 'e1', rol: 'contador' };
    const res = mockRes();

    await handler(
      reqCon({ method: 'POST', query: { recurso: 'config' }, body: { proveedor: 'tango' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Solo dueño/admin puede modificar la configuración contable',
    });
    expect(configQueryMock.upsert).not.toHaveBeenCalled();
  });

  it.each(['dueno', 'admin'])('%s puede configurar (POST /config, sin 403)', async (rol) => {
    usuariosQueryMock.perfil = { id: 'u1', empresa_id: 'e1', rol };
    const res = mockRes();

    await handler(
      reqCon({ method: 'POST', query: { recurso: 'config' }, body: { proveedor: 'tango' } }),
      res
    );

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(configQueryMock.upsert).toHaveBeenCalled();
  });
});
