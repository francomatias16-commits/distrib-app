// tests/handlers/busqueda-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta migración
// a PermisosService. Foco: mismo comportamiento observable que el
// ROLES_ADMIN original — un único gate ('buscar') para el handler entero
// (búsqueda global de clientes/productos/pedidos/presupuestos/facturas/
// cheques).

import { vi, describe, it, expect, beforeEach } from 'vitest';

const authMock = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

const usuariosQueryMock = vi.hoisted(() => ({
  perfil: null, // { empresa_id, rol } — seteado por cada test
}));

function tablaVacia() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    ilike: () => builder,
    limit: () => Promise.resolve({ data: [], error: null }),
    then: (resolve) => resolve({ data: [], error: null }),
  };
  return builder;
}

// FIX (post-migración a repos): busqueda.js ya no consulta `usuarios` ni
// las tablas de negocio (clientes/pedidos/presupuestos/facturas/cheques)
// vía supabase-lazy — delega en obtenerEmpresaYRolPorAuthId()
// (repos/usuarios.js) y en repos/busqueda.js, ambas sobre el cliente
// singleton de lib/repos/_db.js. supabase-lazy queda solo para
// auth.getUser().
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
      return tablaVacia();
    },
  },
}));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    auth: authMock,
  }),
}));

vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => async () => false, // nunca limitado
}));

vi.mock('../../lib/repos/productos.js', () => ({
  buscarProductos: vi.fn(async () => []),
}));

const { default: handler } = await import('../../lib/handlers/busqueda.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function reqCon({ query = { q: 'texto' } } = {}) {
  return { method: 'GET', query, headers: { authorization: 'Bearer token-valido' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  usuariosQueryMock.perfil = null;
});

describe('gate único de búsqueda (ROLES_ADMIN original)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'depositero', 'contador'])(
    '%s puede buscar (sin 403)',
    async (rol) => {
      usuariosQueryMock.perfil = { empresa_id: 'e1', rol };
      const res = mockRes();

      await handler(reqCon(), res);

      expect(res.status).not.toHaveBeenCalledWith(403);
    }
  );

  it('chofer NO puede buscar (403)', async () => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol: 'chofer' };
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos' });
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    const res = mockRes();
    const req = { method: 'GET', query: {}, headers: {} };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
