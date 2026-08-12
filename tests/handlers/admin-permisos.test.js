// tests/handlers/admin-permisos.test.js
//
// No existía cobertura de tests para este handler antes de esta migración
// a PermisosService. Foco: mismo comportamiento observable que el
// ROLES_ADMIN original — un único gate resuelto en `autenticar()`,
// compartido por los 9 _svc del dashboard admin. Se usa un _svc
// inexistente para probar el gate sin mockear la lógica de negocio de
// cada sub-ruta (que ya queda fuera del alcance de "permisos").

import { vi, describe, it, expect, beforeEach } from 'vitest';

const authMock = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

const usuariosQueryMock = vi.hoisted(() => ({
  perfil: null, // { empresa_id, rol, nombre } — seteado por cada test
}));

// FIX (post-migración a repos): admin.js ya no consulta la tabla `usuarios`
// directo vía supabase-lazy — delega en AdminRepo.obtenerPerfilAdmin(), que
// usa el cliente singleton de lib/repos/_db.js. supabase-lazy queda solo
// para auth.getUser().
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
      throw new Error(`tabla no mockeada en _db: ${tabla}`);
    },
  },
}));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    auth: authMock,
  }),
}));

// admin.js llama `limiter(req, res)` SIN await (rateLimit real es síncrono,
// devuelve boolean) — el mock tiene que ser síncrono también, o `if
// (limiter(...))` evaluaría la promesa como truthy y cortaría todo.
vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => () => false,
}));

vi.mock('../../lib/repos/productos.js', () => ({
  existeProductoParaEmpresa: vi.fn(async () => false),
}));

const { default: handler } = await import('../../lib/handlers/admin.js');

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  return res;
}

function reqCon({ query = { _svc: 'no-existe' } } = {}) {
  return { method: 'GET', query, headers: { authorization: 'Bearer token-valido' } };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  usuariosQueryMock.perfil = null;
});

describe('gate único del dashboard admin (ROLES_ADMIN original)', () => {
  it.each(['dueno', 'admin', 'vendedor', 'contador'])(
    '%s puede acceder (llega al dispatcher, 404 por _svc desconocido, no 403)',
    async (rol) => {
      usuariosQueryMock.perfil = { empresa_id: 'e1', rol, nombre: 'Test' };
      const res = mockRes();

      await handler(reqCon(), res);

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(res.status).toHaveBeenCalledWith(404);
    }
  );

  it.each(['depositero', 'chofer'])('%s NO puede acceder (403)', async (rol) => {
    usuariosQueryMock.perfil = { empresa_id: 'e1', rol, nombre: 'Test' };
    const res = mockRes();

    await handler(reqCon(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sin permisos para el panel admin' });
  });

  it('sin token → 401 antes que el gate de permisos', async () => {
    const res = mockRes();
    const req = { method: 'GET', query: {}, headers: {} };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
